/** §15 runtime adapter: run upstream's signatures worker cases where the
 * upstream helpers are MAPPED to the cad-home runtime seam
 * (test/runtime/worker-harness.mjs + fake-puter.mjs): the worker source is
 * loaded with the runner's exact contract (lib/worker-contract framing, `me`
 * global), kv goes through lib/hub-kv.js and fs through lib/hub-fsops.js —
 * the same transports the server's `me` frame handler uses. Upstream test
 * files stay unmodified (the vitest-shim resolve hook does the mapping while
 * CAD_RUNTIME_HELPERS=1). */
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { DATA, cleanup } from './helpers.js';
void DATA;

process.env.CAD_RUNTIME_HELPERS = '1';
const hookUrl = pathToFileURL(path.resolve('test', 'vitest-shim', 'hooks.mjs')).href;
register(hookUrl);
const shim = await import(pathToFileURL(path.resolve('test', 'vitest-shim', 'index.mjs')).href);

const db = await import('../lib/db.js');
db.open();

// The mapped runtime set for this adapter (every case in these files runs
// worker source through the runtime seam). Expansion order per §25.
const MAPPED_SET = [
  path.resolve('..', 'upstream', 'src', 'signatures', 'tests', 'email-worker.test.js'),
  path.resolve('..', 'upstream', 'src', 'signatures', 'tests', 'sign-worker.test.js'),
];
const RUNTIME_TOTAL = 172; // §25 runtime denominator: all signatures worker-focused cases

await import(pathToFileURL(MAPPED_SET[0]).href);
await import(pathToFileURL(MAPPED_SET[1]).href);

const { suites, loose } = shim.casesOf();
let runtimeCovered = 0;
let measured = 0;

test(`the mapped runtime set (${MAPPED_SET.map((f) => path.basename(f)).join(', ')}) registered cases`, () => {
  assert.ok(shim.countCases() > 0, 'cases registered');
});

for (const suite of suites) {
  for (const item of suite.its) {
    test(`runtime signatures: ${suite.name} — ${item.name}`, async () => {
      for (const hook of suite.beforeEach) await hook();
      await item.fn();
      runtimeCovered += 1; // the case ran on the runtime seam (kv/fs/framing)
      measured += 1;
    });
  }
}
for (const item of loose) test(`runtime signatures: ${item.name}`, async () => {
  await item.fn();
  runtimeCovered += 1;
  measured += 1;
});

after(() => {
  const dir = path.resolve('data', 'hub', 'test-gates');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'signatures-runtime.json'), JSON.stringify({
    app: 'signatures',
    // covered = cases that executed the cad-home runtime seam; measured =
    // cases the mapped set produced (sanity number for the audit).
    covered: runtimeCovered, runtimeCovered, measured,
    total: RUNTIME_TOTAL, runtimeTotal: RUNTIME_TOTAL,
    mappedSet: MAPPED_SET.map((f) => path.basename(f)),
    execution: 'cad-home runtime seam: worker-contract framing + hub-kv + hub-fsops, in-process; /wr HTTP wrapper and child sandbox stay root-suite-scoped',
    at: new Date().toISOString(),
  }, null, 2));
  db.close();
  return cleanup(null);
});
