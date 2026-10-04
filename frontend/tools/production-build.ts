import { build } from 'vite';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireThat } from './coverage-gate.ts';

export async function productionBuild(output) {
  const request = JSON.parse(readFileSync(path.join(output, 'request.json'), 'utf8'));
  requireThat(request.runId === process.env.QUALITY_RUN_ID, 'Build run identity mismatch');
  const modules = new Set();
  await build({ plugins: [{
    name: 'quality-production-modules',
    generateBundle() {
      for (const id of this.getModuleIds()) modules.add(id.split('?')[0]);
    },
  }] });
  requireThat(modules.size > 0, 'Missing production module graph');
  writeFileSync(path.join(output, 'production.json'), JSON.stringify({ ...request, modules: [...modules].sort() }), { flag: 'wx' });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await productionBuild(process.env.QUALITY_RUN_DIR);
