import ts from 'typescript';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';

export const DEBT_BASE = 'a8e547543057594b04cc36c898580c5ed68318fd';
export const POLICY = 'whole-changed-files-v2';
export function digest(value) { return createHash('sha256').update(value).digest('hex'); }
export function requireThat(ok, message) { if (!ok) throw new Error(message); }

// Full changed files are deliberately stricter than changed-line coverage:
// every changed function and all of its branches are included without a regex diff mapper.
export function classify(file, production = new Set()) {
  if (production.has(file) && /\.[cm]?[jt]sx?$/.test(file) && !/\.d\.ts$/.test(file)) return 'executable';
  if (/\.py$/.test(file) && !/(^|\/)tests\//.test(file)) return 'blocked-python';
  if (/(^|\/)(__tests__|tests)\//.test(file) || /\.test\.[cm]?[jt]sx?$/.test(file)) return 'test';
  if (/\.d\.ts$/.test(file)) return 'declaration';
  if (/\.[cm]?[jt]sx?$/.test(file)) return 'executable';
  return 'non-executable';
}
export function git(root, args) {
  return execFileSync('git', ['--no-optional-locks', '-C', root, ...args], { encoding: 'utf8' });
}
export function snapshot(root, base) {
  requireThat(base === DEBT_BASE, 'Debt baseline must not be moved');
  git(root, ['merge-base', '--is-ancestor', base, 'HEAD']);
  const changed = new Set(git(root, ['diff', '--name-only', '--no-renames', '-z', base]).split('\0').filter(Boolean));
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  for (const name of untracked) changed.add(name);
  const tracked = git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
  const removed = git(root, ['ls-files', '--deleted', '-z']).split('\0').filter(Boolean);
  for (const name of removed) changed.add(name);
  const files = [...new Set([...tracked, ...untracked])].filter(name =>
    name.startsWith('frontend/') || name.startsWith('.github/') || changed.has(name));
  const hashes = {};
  const deleted = new Set(git(root, ['diff', '--name-only', '--diff-filter=D', '-z', base]).split('\0').filter(Boolean));
  for (const name of removed) deleted.add(name);
  for (const name of files.sort()) {
    if (deleted.has(name)) continue;
    requireThat(!path.basename(name).startsWith('.env'), `Credential file forbidden: ${name}`);
    const full = path.join(root, name);
    requireThat(lstatSync(full).isFile(), `Non-regular source file: ${name}`);
    hashes[name] = digest(readFileSync(full));
  }
  const production = productionFiles(root, hashes);
  const scope = [...changed].sort().map(file => ({ file, kind: classify(file, production), deleted: deleted.has(file) }));
  requireThat(!scope.some(x => x.kind === 'blocked-python'), 'Python production changes require function coverage tooling');
  const manifest = { base, head: git(root, ['rev-parse', 'HEAD']).trim(), policy: POLICY, scope, hashes };
  return { ...manifest, fingerprint: digest(JSON.stringify(manifest)) };
}

// Compare the complete converter inventory, including each branch arm. IDs are
// retained: any converter/transform drift is a failure, not a smaller denominator.
export function sameMaps(file, actual, expected) {
  requireThat(actual && expected, `Missing complete mapping: ${file}`);
  for (const key of ['statementMap', 'fnMap', 'branchMap']) {
    requireThat(JSON.stringify(actual[key]) === JSON.stringify(expected[key]), `Complete ${key} mismatch: ${file}`);
  }
}
export function analyze(file, source, entry, expected) {
  requireThat(!/(?:istanbul|c8|v8|node:coverage)\s+ignore/.test(source), `Coverage suppression: ${file}`);
  sameMaps(file, entry, expected);
  for (const [map, hits] of [['statementMap','s'],['fnMap','f'],['branchMap','b']]) {
    requireThat(JSON.stringify(Object.keys(entry[map])) === JSON.stringify(Object.keys(entry[hits])), `Map/count mismatch: ${file}`);
  }
  const lineHits = new Map();
  for (const [id, loc] of Object.entries(entry.statementMap)) {
    lineHits.set(loc.start.line, Math.max(lineHits.get(loc.start.line) ?? 0, entry.s[id]));
  }
  for (const [id, counts] of Object.entries(entry.b)) requireThat(Array.isArray(counts) && counts.length === entry.branchMap[id].locations.length, `Branch/count mismatch: ${file}`);
  const metrics = { lines: [...lineHits.values()], statements: Object.values(entry.s), functions: Object.values(entry.f), branches: Object.values(entry.b).flat() };
  return Object.fromEntries(Object.entries(metrics).map(([metric, counts]) => {
    requireThat(counts.every(n => Number.isInteger(n) && n >= 0), `Invalid hit count: ${file}`);
    return [metric, { covered: counts.filter(n => n > 0).length, total: counts.length }];
  }));
}

// Only test files proven unreachable from actual application/tool entries may be
// exempted. Unresolved/computed imports conservatively include every local file.
export function productionFiles(root, hashes) {
  const all = Object.keys(hashes).filter(f => /\.[cm]?[jt]sx?$/.test(f));
  const html = readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
  const entries = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)].map(m => {
    const name = 'frontend/' + m[1].replace(/^\//, '');
    return hashes[name] ? name : 'frontend/public/' + m[1].replace(/^\//, '');
  });
  requireThat(entries.length > 0 && entries.every(f => hashes[f]), 'Unresolved HTML entry');
  const config = ts.readConfigFile(path.join(root, 'frontend/tsconfig.json'), ts.sys.readFile);
  requireThat(!config.error, 'Unreadable TypeScript resolver config');
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, path.join(root, 'frontend')).options;
  const pending = [...entries, ...all.filter(f => f.startsWith('frontend/tools/'))];
  const production = new Set();
  let uncertain = false;
  while (pending.length) {
    const file = pending.pop();
    if (production.has(file)) continue;
    production.add(file);
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    const ast = ts.createSourceFile(file, readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
    requireThat(ast.parseDiagnostics.length === 0, `Cannot parse dependency graph: ${file}`);
    function resolve(node) {
      if (!node || !ts.isStringLiteralLike(node)) { uncertain = true; return; }
      const id = node.text;
      if (id.startsWith('node:')) return;
      if (id.startsWith('.')) {
        const direct = path.relative(root, path.resolve(root, path.dirname(file), id));
        if (hashes[direct]) pending.push(direct);
      }
      const resolved = ts.resolveModuleName(id, path.join(root, file), options, ts.sys).resolvedModule;
      if (resolved) {
        const relative = path.relative(root, resolved.resolvedFileName).split(path.sep).join('/');
        if (!relative.includes('node_modules/')) {
          // A declaration may shadow a runtime .js file; it proves no exclusion.
          if (/\.d\.ts$/.test(relative) || !hashes[relative]) uncertain = true;
          else pending.push(relative);
        }
      } else if (!/\.(css|json|svg|png|woff2?)$/.test(id)) uncertain = true;
    }
    function visit(node) {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) && node.moduleSpecifier) resolve(node.moduleSpecifier);
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require') resolve(node.arguments[0]);
        if (node.expression.getText(ast) === 'import.meta.glob') uncertain = true;
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  return uncertain ? new Set(all) : production;
}

export function evaluate(root, before, after, coverage, collected, runId) {
  requireThat(collected && collected.runId === runId && collected.fingerprint === before.fingerprint, 'Stale collection identity');
  requireThat(collected.coverageSha256 === digest(JSON.stringify(coverage)), 'Collection coverage mismatch');
  requireThat(JSON.stringify(before) === JSON.stringify(after), 'Source fingerprint changed during validation');
  requireThat(coverage && typeof coverage === 'object', 'Missing coverage report');
  const files = [];
  const exemptions = [];
  for (const item of before.scope) {
    if (item.deleted || item.kind !== 'executable') { exemptions.push(item); continue; }
    const filename = path.resolve(root, item.file);
    const source = readFileSync(filename, 'utf8');
    requireThat(collected.sources[filename] === digest(source) && before.hashes[item.file] === digest(source), `Collected source mismatch: ${item.file}`);
    const counts = analyze(item.file, source, coverage[filename], collected.expected[filename]);
    files.push({ file: item.file, counts, notApplicable: Object.entries(counts).filter(([, count]) => count.total === 0).map(([metric]) => ({ metric, reason: 'No entries in independently generated complete converter inventory' })) });
  }
  requireThat(files.length > 0, 'No executable files in gate scope');
  const totals = Object.fromEntries(['lines','statements','functions','branches'].map(metric => [metric, {
    covered: files.reduce((sum, f) => sum + f.counts[metric].covered, 0),
    total: files.reduce((sum, f) => sum + f.counts[metric].total, 0),
  }]));
  return { passed: Object.values(totals).every(x => x.covered === x.total), manifest: before, files, totals, exemptions };
}

// Vite's real build graph independently catches runtime alias/extension resolution
// that differs from TypeScript. An unmeasured test-named production module blocks.
export function verifyProduction(root, manifest, production, runId) {
  requireThat(production.runId === runId && production.fingerprint === manifest.fingerprint, 'Stale production graph');
  requireThat(Array.isArray(production.modules) && production.modules.length > 0, 'Missing production graph');
  for (const id of production.modules) {
    const file = path.relative(root, id).split(path.sep).join('/');
    if (manifest.hashes[file] && classify(file) === 'test') {
      requireThat(manifest.scope.some(item => item.file === file && item.kind === 'executable' && !item.deleted), `Unmeasured production test path: ${file}`);
    }
  }
}
