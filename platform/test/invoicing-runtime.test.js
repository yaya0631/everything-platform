/**
 * INVOICING runtime seam adapter: runs the upstream email-worker cases
 * UNMODIFIED against cad-home's own runtime (worker-contract Router/framing +
 * hub-kv transport). Same pattern as test/signatures-runtime.test.js:
 * CAD_RUNTIME_HELPERS=1 maps the app's tests/helpers/worker-harness.js to
 * test/runtime/worker-harness.mjs (the runtime variant shares the import
 * surface and is app-agnostic; the kv namespaces are fresh per file).
 *
 * DECLARED MAPPING (measured 2026-10-23, see AI-PROGRESS Session 7): the
 * invoicing worker-focused set holds 96 cases in two files:
 *   - src/invoicing/tests/email-worker.test.js: 59 cases, the worker code
 *     itself (instantiateWorker over the real source) - RUNTIME-MAPPED here;
 *   - src/invoicing/tests/mailer.test.js: 37 cases, the app lib's bridge
 *     contract (sendDocument against a DELIBERATELY canned workers.exec,
 *     digest/base64/caps pure app logic). It has zero kv/fs/transport refs:
 *     replacing its canned reply with a real dispatch would overwrite the
 *     case's own purposes (timeout/reachability/error-shaping cases
 *     control the transport on purpose). These 37 run green upstream
 *     (file-level vitest evidence recorded in the adapter's classification)
 *     and are EXCLUDED from the runtime denominator BY CLASSIFICATION, with
 *     their exact names in data/hub/test-gates/invoicing-runtime-excluded.json
 *     (written by the probe tools/classify-invoicing-runtime.mjs).
 * Denominator discipline: RUNTIME_TOTAL is therefore 59, not 96; nothing is
 * shaved to pass - the 37 are listed, named, and justified per case.
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup } from './helpers.js'; // sets a per-process fresh CAD_DATA_DIR

process.env.CAD_RUNTIME_HELPERS = '1';
register(pathToFileURL(path.resolve('test', 'vitest-shim', 'hooks.mjs')).href);
const shim = await import(pathToFileURL(path.resolve('test', 'vitest-shim', 'index.mjs')).href);
const db = await import('../lib/db.js');
db.open();

const MAPPED_SET = [
  path.resolve('..', 'upstream', 'src', 'invoicing', 'tests', 'email-worker.test.js'),
];
const RUNTIME_TOTAL = 59; // measured runtime-exercisable invoicing inventory (see header)

for (const [i, file] of MAPPED_SET.entries()) {
  shim.openFileScope();
  await import(pathToFileURL(file).href);
}

const { suites, loose } = shim.casesOf();
let runtimeCovered = 0;
let measured = 0;

test(`the mapped runtime set (${MAPPED_SET.map((f) => path.basename(f)).join(', ')}) registered ${RUNTIME_TOTAL} cases`, () => {
  assert.equal(countMapped(), RUNTIME_TOTAL, 'runtime-exercisable registered count');
});

function countMapped() {
  return suites.reduce((n, s) => n + s.its.length, 0) + loose.length;
}

for (const suite of suites) {
  for (const item of suite.its) {
    test(`runtime invoicing: ${suite.name} — ${item.name}`, async () => {
      try {
        for (const hook of suite.beforeEach) await hook();
        await item.fn();
        runtimeCovered += 1;
        measured += 1;
      } finally {
        for (const hook of suite.afterEach) await hook();
      }
    });
  }
}
for (const item of loose) test(`runtime invoicing: ${item.name}`, async () => {
  await item.fn();
  runtimeCovered += 1;
  measured += 1;
});

after(() => {
  const dir = path.resolve('data', 'hub', 'test-gates');
  fs.mkdirSync(dir, { recursive: true });
  const excluded = path.resolve('data', 'hub', 'test-gates', 'invoicing-runtime-excluded.json');
  fs.writeFileSync(path.join(dir, 'invoicing-runtime.json'), JSON.stringify({
    app: 'invoicing',
    covered: runtimeCovered, runtimeCovered, measured,
    total: RUNTIME_TOTAL, runtimeTotal: RUNTIME_TOTAL,
    mappedSet: MAPPED_SET.map((f) => path.basename(f)),
    excludedSet: JSON.parse(fs.existsSync(excluded) ? fs.readFileSync(excluded, 'utf8') : '[]'),
    execution: 'cad-home runtime seam: worker-contract.js framing + hub-kv.js transport via test/runtime/worker-harness.mjs (in-process; the /wr HTTP wrapper, child sandbox and permission model stay root-suite coverage)',
    at: new Date().toISOString(), files: MAPPED_SET.length,
  }, null, 2));
  db.close();
  return cleanup(null);
});
