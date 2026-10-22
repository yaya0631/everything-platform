/** §20 regression: a worker's FIRST call — before any heartbeat exists yet —
 * may take a few seconds (cold cache, a slow first fetch of app data) and
 * must complete. It is exactly the shape the pre-fix watchdog murdered: it
 * measured quiet-time from lastBeat = 0, so the first heartbeat tick with
 * work in flight computed an epoch-sized quiet and killed the child as if
 * it had stalled. lastBeat is now anchored at spawn; this test holds a
 * 3.2 s first call across at least one full heartbeat tick (2 s period,
 * 8 s grace) and demands a 200, with zero `stall` rows in the audit. */
import test from 'node:test';
import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, cleanup, client } from './helpers.js';
import * as hub from '../lib/hub.js';
import * as store from '../lib/store.js';
import * as config from '../lib/config.js';
import * as hubWorkersm from '../lib/hub-workers.js';
import * as runm from '../lib/hub-workers-run.js';

const FIXTURE = 'test/fixtures/hub/fixture-dist';
const SHA40 = (c) => c.repeat(40);

const SLOW_PROBE = `
router.get('/ping', function () { return new Response('pong', { status: 200 }); });
router.get('/slow', async function () {
  await new Promise((ok) => setTimeout(ok, 3200));
  return new Response('awake', { status: 200 });
});
`;

let running;
let hostC;

before(async () => {
  running = await start();
  store.addUser('person1', 'person1-password');
  hub.installFromDist('alpha', FIXTURE, { sha: SHA40('a'), source: 'import', title: 'Alpha' });
  config.set('workers.timeout_ms', 12000);
  hostC = client(running.base);
  await hostC.login('person1', 'person1-password');
  const wr = await hostC.call('PUT', 'hub/fs/write?app=alpha&path=workers/slow.js&options=' + encodeURIComponent('{}'), { body: SLOW_PROBE, raw: true });
  assert.equal(wr.status, 200, JSON.stringify(wr.body));
  const created = await hostC.post('hub/workers', { app: 'alpha', name: 'cold-slow', filePath: 'workers/slow.js' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
});
after(() => cleanup(running));

test('a 3.2 s FIRST call (no heartbeat yet) completes instead of being killed', async () => {
  // /pool-a style warmup is deliberately absent: the slow call IS the cold boot.
  const t0 = Date.now();
  const r = await hostC.post('hub/workers/exec', { target: 'cold-slow', method: 'GET', path: '/slow' });
  const ms = Date.now() - t0;
  assert.equal(r.status, 200, `the first call must survive the watchdog: ${JSON.stringify(r.body)}`);
  assert.equal(String(r.body), 'awake');
  assert.ok(ms >= 3000, `the call must really take the slow path (took ${ms} ms)`);
  // The runtime must ALSO not have logged a stall for this worker.
  const rows = hubWorkersm.recentLogsFor('person1', 50);
  const stalls = rows.filter((row) => row.action === 'stall' && row.name === 'cold-slow');
  assert.deepEqual(stalls.map((row) => String(row.detail || '').slice(0, 60)), [], JSON.stringify(stalls));
});

test('and the worker is still warm afterwards (fast follow-up works)', async () => {
  const r = await hostC.post('hub/workers/exec', { target: 'cold-slow', method: 'GET', path: '/ping' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(String(r.body), 'pong');
  const stats = runm.workerStats();
  const p = stats.find((s) => s.key === 'person1:cold-slow');
  assert.ok(p, `must still be pooled: ${JSON.stringify(stats)}`);
  assert.ok(p.bootMs > 0, `the first call was its boot: ${JSON.stringify(p)}`);
});
