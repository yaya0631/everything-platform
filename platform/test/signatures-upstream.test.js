/** §15 adapter: run upstream's signatures worker tests unchanged through the
 * local Vitest shim and Node's test runner. */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

const CASES = 30;
const TOTAL_WORKER_CASES = 172;
const hookUrl = pathToFileURL(path.resolve('test', 'vitest-shim', 'hooks.mjs')).href;
register(hookUrl);
const shim = await import(pathToFileURL(path.resolve('test', 'vitest-shim', 'index.mjs')).href);
await import(pathToFileURL(path.resolve('..', 'upstream', 'src', 'signatures', 'tests', 'sign-worker.test.js')).href);
await import(pathToFileURL(path.resolve('..', 'upstream', 'src', 'signatures', 'tests', 'email-worker.test.js')).href);

const { suites, loose } = shim.casesOf();
let covered = 0;
test(`the upstream signatures sign-worker test file registered ${CASES} cases`, () => {
  assert.equal(shim.countCases(), CASES,
    `registered: ${suites.map((s) => `${s.name} (${s.its.length})`).join('; ')}`);
});

for (const suite of suites) {
  for (const item of suite.its) {
    test(`upstream signatures worker: ${suite.name} — ${item.name}`, async () => {
      for (const hook of suite.beforeEach) await hook();
      await item.fn();
      covered += 1;
    });
  }
}
for (const item of loose) test(`upstream signatures worker: ${item.name}`, async () => { await item.fn(); covered += 1; });
after(() => {
  const dir = path.resolve('data', 'hub', 'test-gates');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'signatures.json'), JSON.stringify({
    app: 'signatures', covered, total: TOTAL_WORKER_CASES, adapter_covered: covered,
    adapter_total: CASES, runtimeCovered: 0, runtimeTotal: TOTAL_WORKER_CASES,
    execution: 'upstream worker-harness; no cad-home runner/shim/hub API calls',
    at: new Date().toISOString(), files: 2,
  }, null, 2));
});
