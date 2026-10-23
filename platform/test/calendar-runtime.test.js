/**
 * CALENDAR runtime seam adapter: runs the upstream rsvp-worker.test.js cases
 * UNMODIFIED against cad-home's own runtime (worker-contract Router/framing +
 * hub-kv transport), same pattern as the signatures and invoicing adapters.
 * CAD_RUNTIME_HELPERS=1 maps the app's tests/helpers/worker-harness.js to
 * test/runtime/worker-harness.mjs; the RSVP worker is instantiated over the
 * real source with runtime-backed kv, admin auth over sha256Hex, and per-call
 * routes through the runtime seam transports.
 *
 * Denominator: the upstream rsvp-worker.test.js registers exactly 45 cases
 * (asserted) and every one of them exercises the worker seam; no file-level
 * exclusions. The calendar app suite (upstream vitest, 51 worker-slotting
 * files incl. this one) stays the upstream coverage wall.
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
  path.resolve('..', 'upstream', 'src', 'calendar', 'tests', 'rsvp-worker.test.js'),
];
const RUNTIME_TOTAL = 45; // measured exact (vitest registers 45; asserted below)

for (const [i, file] of MAPPED_SET.entries()) {
  shim.openFileScope();
  await import(pathToFileURL(file).href);
}

const { suites, loose } = shim.casesOf();
let runtimeCovered = 0;
let measured = 0;

test(`the mapped runtime set (${MAPPED_SET.map((f) => path.basename(f)).join(', ')}) registered ${RUNTIME_TOTAL} cases`, () => {
  const n = countMapped();
  assert.equal(n, RUNTIME_TOTAL, `unexpected inventory change: ${n}`);
});

function countMapped() {
  return suites.reduce((n, s) => n + s.its.length, 0) + loose.length;
}

for (const suite of suites) {
  for (const item of suite.its) {
    test(`runtime calendar: ${suite.name} — ${item.name}`, async () => {
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
for (const item of loose) test(`runtime calendar: ${item.name}`, async () => {
  await item.fn();
  runtimeCovered += 1;
  measured += 1;
});

after(() => {
  const dir = path.resolve('data', 'hub', 'test-gates');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'calendar-runtime.json'), JSON.stringify({
    app: 'calendar',
    covered: runtimeCovered, runtimeCovered, measured,
    total: RUNTIME_TOTAL, runtimeTotal: RUNTIME_TOTAL,
    mappedSet: MAPPED_SET.map((f) => path.basename(f)),
    execution: 'cad-home runtime seam: worker-contract.js framing + hub-kv.js transport via test/runtime/worker-harness.mjs (in-process; the /wr HTTP wrapper, child sandbox and permission model stay root-suite coverage, incl. test/hub-workers-rsvp.test.js)',
    at: new Date().toISOString(), files: MAPPED_SET.length,
  }, null, 2));
  db.close();
  return cleanup(null);
});
