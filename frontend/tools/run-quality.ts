import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEBT_BASE, digest, evaluate, snapshot, verifyProduction } from './coverage-gate.ts';

export function runCommand(command, args, options) {
  // execFileSync throws for signals and every nonzero exit; no report is emitted.
  execFileSync(command, args, options);
  return { command, args, exitCode: 0 };
}
export function runQuality(root) {
  const frontend = path.join(root, 'frontend');
  const directory = path.join(frontend, 'quality-artifacts');
  mkdirSync(directory, { recursive: true });
  const output = mkdtempSync(path.join(directory, 'run-'));
  const runId = randomUUID();
  const before = snapshot(root, DEBT_BASE);
  writeFileSync(path.join(output, 'request.json'), JSON.stringify({runId, fingerprint: before.fingerprint}), {flag:'wx'});
  writeFileSync(path.join(output, 'before.json'), JSON.stringify(before, null, 2));
  const env = {...process.env, QUALITY_RUN_DIR:output, QUALITY_RUN_ID:runId};
  const options = { cwd: frontend, stdio: 'inherit', env };
  const coverageDir = path.join(output, 'coverage');
  const includes = before.scope.filter(f => f.kind === 'executable' && !f.deleted).map(f => `--coverage.include=${path.relative(frontend, path.join(root, f.file))}`);
  const commands = [];
  commands.push(runCommand(process.execPath, [path.join(frontend, 'node_modules/vitest/vitest.mjs'), 'run', '--coverage', '--coverage.provider=custom', '--coverage.customProviderModule=./tools/coverage-provider.ts', ...includes, '--coverage.exclude=**/node_modules/**', `--coverage.reportsDirectory=${coverageDir}`, '--coverage.reporter=json', '--coverage.reporter=text', '--coverage.reporter=html', '--coverage.reporter=lcov'], options));
  commands.push(runCommand(process.execPath, ['node_modules/typescript/bin/tsc', '-b'], options));
  commands.push(runCommand(process.execPath, ['--experimental-strip-types', 'tools/production-build.ts'], options));
  const production = JSON.parse(readFileSync(path.join(output, 'production.json'), 'utf8'));
  verifyProduction(root, before, production, runId);
  commands.push(runCommand(process.execPath, ['--test', 'tests/stockBrowser.test.mjs'], options));
  const raw = readFileSync(path.join(coverageDir, 'coverage-final.json'), 'utf8');
  const collected = JSON.parse(readFileSync(path.join(output, 'collected.json'), 'utf8'));
  const report = evaluate(root, before, snapshot(root, DEBT_BASE), JSON.parse(raw), collected, runId);
  report.coverageSha256 = digest(raw);
  report.collectionSha256 = digest(JSON.stringify(collected));
  report.productionSha256 = digest(JSON.stringify(production));
  report.runId = runId;
  report.node = process.version;
  report.browserSha256 = digest(readFileSync(path.join(output, 'browser.json')));
  report.commands = commands;
  report.tools = Object.fromEntries(['vitest', '@vitest/coverage-v8', 'ast-v8-to-istanbul', 'typescript'].map(name => [name, JSON.parse(readFileSync(path.join(frontend, 'node_modules', name, 'package.json'), 'utf8')).version]));
  writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, fingerprint: before.fingerprint, totals: report.totals, output }));
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!runQuality(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')).passed) process.exitCode = 1;
}
