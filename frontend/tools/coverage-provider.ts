import base from '@vitest/coverage-v8';
import { V8CoverageProvider } from '@vitest/coverage-v8/dist/provider.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { digest, requireThat, sameMaps } from './coverage-gate.ts';

export class BoundProvider extends V8CoverageProvider {
  expected = {};
  sources = {};
  async remapCoverage(filename, wrapperLength, result, functions) {
    requireThat(!this.options.ignoreClassMethods?.length, 'Class-method coverage exclusions forbidden');
    requireThat(result.map?.sourcesContent?.length > 0, `Missing source content: ${filename}`);
    for (let i = 0; i < result.map.sources.length; i++) {
      const source = fileURLToPath(new URL(result.map.sources[i], filename));
      requireThat(result.map.sourcesContent[i] === readFileSync(source, 'utf8'), `Transformed source mismatch: ${source}`);
      this.sources[source] = digest(result.map.sourcesContent[i]);
    }
    const expected = await super.remapCoverage(filename, wrapperLength, result, []);
    const actual = await super.remapCoverage(filename, wrapperLength, result, functions);
    requireThat(Object.keys(expected).length > 0, `Empty conversion: ${filename}`);
    requireThat(JSON.stringify(Object.keys(actual)) === JSON.stringify(Object.keys(expected)), `Converted file mismatch: ${filename}`);
    for (const file of Object.keys(expected)) {
      sameMaps(file, actual[file], expected[file]);
      if (this.expected[file]) sameMaps(file, expected[file], this.expected[file]);
      this.expected[file] = expected[file];
    }
    return actual;
  }
  async generateReports(coverageMap, allTestsRun) {
    await super.generateReports(coverageMap, allTestsRun);
    const output = process.env.QUALITY_RUN_DIR;
    const request = JSON.parse(readFileSync(path.join(output, 'request.json'), 'utf8'));
    requireThat(request.runId === process.env.QUALITY_RUN_ID, 'Collector run identity mismatch');
    const coverage = JSON.parse(readFileSync(path.join(this.options.reportsDirectory, 'coverage-final.json'), 'utf8'));
    writeFileSync(path.join(output, 'collected.json'), JSON.stringify({
      runId: request.runId, fingerprint: request.fingerprint,
      coverageSha256: digest(JSON.stringify(coverage)), expected: this.expected, sources: this.sources,
    }), { flag: 'wx' });
  }
}
export default { ...base, getProvider: () => new BoundProvider() };
