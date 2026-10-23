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

// Some upstream test files import UI helpers (src/ui/sendflow.js -> toast)
// whose modules touch `document` at import time under vitest's jsdom wheel.
// In the runtime adapter process the imports only need to not crash: a tiny
// inert DOM stub (module-import safety; the cases themselves exercise lib +
// worker code, and any ui function the tests assert on comes vi-mocked).
if (typeof globalThis.document === 'undefined') {
  const fakeNode = () => ({
    style: {}, className: '', textContent: '', children: [],
    appendChild(c) { this.children.push(c); return c; },
    append(...cs) { for (const c of cs) this.children.push(c); },
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, removeAttribute() {}, remove() {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    focus() {}, blur() {}, click() {},
  });
  globalThis.document = {
    body: { append() {} },
    head: { append() {} },
    addEventListener() {}, removeEventListener() {},
    createElement: () => fakeNode(),
    createTextNode: () => fakeNode(),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
  };
  globalThis.window = { addEventListener() {}, removeEventListener() {}, location: { href: '' } };
  globalThis.localStorage = {
    items: new Map(),
    getItem(k) { return this.items.has(k) ? this.items.get(k) : null; },
    setItem(k, v) { this.items.set(String(k), String(v)); },
    removeItem(k) { this.items.delete(k); },
    clear() { this.items.clear(); },
  };
}

// The mapped runtime set for this adapter (every case in these files runs
// worker source through the runtime seam). Expansion order per §25.
const MAPPED_SET = [
  path.resolve('..', 'upstream', 'src', 'signatures', 'tests', 'email-worker.test.js'),
  path.resolve('..', 'upstream', 'src', 'signatures', 'tests', 'sign-worker.test.js'),
  path.resolve('..', 'upstream', 'src', 'signatures', 'tests', 'accesscode.test.js'),
  path.resolve('..', 'upstream', 'src', 'signatures', 'tests', 'ownernotify.test.js'),
  path.resolve('..', 'upstream', 'src', 'signatures', 'tests', 'consent.test.js'),
  path.resolve('..', 'upstream', 'src', 'signatures', 'tests', 'expiry.test.js'),
  path.resolve('..', 'upstream', 'src', 'signatures', 'tests', 'store.test.js'),
  path.resolve('..', 'upstream', 'src', 'signatures', 'tests', 'templates.test.js'),
  path.resolve('..', 'upstream', 'src', 'signatures', 'tests', 'emailer.test.js'),
  path.resolve('..', 'upstream', 'src', 'signatures', 'tests', 'signlinks.test.js'),
  path.resolve('..', 'upstream', 'src', 'signatures', 'tests', 'deleteflow.test.js'),
];
// §25 runtime denominator, RECONCILED 2026-10-23 by measurement (declared
// doc/harness calibration, evidence in AI-PROGRESS Session 6): the 13
// worker-focused signatures files hold 173 cases under real vitest; two of
// the files cannot exercise the cad-home runtime seam and stay upstream-only
// (advanceturn.test.js, 9 cases, mocks the store module itself - no puter
// transport anywhere; pagerail.test.js, 5 cases, DOM/jsdom-bound). The
// runtime-exercisable inventory is therefore the 159 cases in the 11 mapped
// files above, and this adapter covers exactly that (159/159 measured).
const RUNTIME_TOTAL = 159;

for (const [i, file] of MAPPED_SET.entries()) {
  shim.openFileScope(); // attributes file-level hooks + this file's suites
  await import(pathToFileURL(file).href);
}

const { suites, loose } = shim.casesOf();
let runtimeCovered = 0;
let measured = 0;

test(`the mapped runtime set (${MAPPED_SET.map((f) => path.basename(f)).join(', ')}) registered cases`, () => {
  assert.ok(shim.countCases() > 0, 'cases registered');
});

for (const suite of suites) {
  for (const item of suite.its) {
    test(`runtime signatures: ${suite.name} — ${item.name}`, async () => {
      try {
        for (const hook of suite.beforeEach) await hook();
        await item.fn();
        runtimeCovered += 1; // the case ran on the runtime seam (kv/fs/framing)
        measured += 1;
      } finally {
        // vitest runs afterEach even when the case fails (state tearing down);
        // a throwing hook is surfaced as that hook's failure.
        for (const hook of suite.afterEach) await hook();
      }
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
