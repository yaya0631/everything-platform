/** §15 adapter — runs UPSTREAM's rsvp-worker.test.js UNMODIFIED against the
 * same deploy-time source cad-home stages: `vitest` is resolved to a local
 * shim (test/vitest-shim/), the file is imported by its real path, and the
 * 45 registered test cases execute here under node:test. This validates the
 * DEPLOYED SCRIPT'S contract as upstream defines it (route behaviors,
 * statuses, KV discipline, redirect fragments) — complementing the hub-level
 * exec test (hub-workers-rsvp.test.js) which drives the same source through
 * the server. The count is asserted: 45 cases, all passing — the test goes
 * red (not "skip") the moment upstream grows a case the shim cannot run.
 * NOTE on claims: this 45/45 is the number to cite; the upstream-staged
 * harness is NOT the hub runtime — both facts are stated in the docs. */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

const CASES = 45; // upstream rsvp-worker.test.js cases; calendar's worker total is 51
const TOTAL_WORKER_CASES = 45; // exact upstream rsvp-worker.test.js denominator

const hookUrl = pathToFileURL(path.resolve('test', 'vitest-shim', 'hooks.mjs')).href;
register(hookUrl);

// Import the shim FIRST so the main-thread instance (and its state) is the
// exact module the hook hands the upstream file.
const shim = await import(pathToFileURL(path.resolve('test', 'vitest-shim', 'index.mjs')).href);

// The upstream file resolves its own './helpers/worker-harness.js' relative
// to itself — the real upstream tree, untouched.
await import(pathToFileURL(path.resolve('..', 'upstream', 'src', 'calendar', 'tests', 'rsvp-worker.test.js')).href);

const { suites, loose } = shim.casesOf();
let covered = 0;

test(`the upstream file registered ${CASES} rsvp-worker test cases`, () => {
  assert.equal(shim.countCases(), CASES, `registered: ${suites.map((s) => `${s.name} (${s.its.length})`).join('; ')}`);
});

for (const suite of suites) {
  for (const item of suite.its) {
    test(`upstream rsvp-worker: ${suite.name} — ${item.name}`, async (t) => {
      for (const hook of suite.beforeEach) await hook();
      await item.fn();
      covered += 1;
    });
  }
}

for (const item of loose) test(`upstream rsvp-worker: ${item.name}`, async () => { await item.fn(); covered += 1; });
after(() => {
  const dir = path.resolve('data', 'hub', 'test-gates');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'calendar.json'), JSON.stringify({
    app: 'calendar', covered, total: TOTAL_WORKER_CASES, runtimeCovered: 0, runtimeTotal: TOTAL_WORKER_CASES,
    execution: 'upstream RSVP worker harness; no cad-home runner/shim/hub API calls',
    at: new Date().toISOString(), files: 1,
  }, null, 2));
});
