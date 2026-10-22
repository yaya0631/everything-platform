/** §20 pool budget: workers.pool_rss_budget_mb — boots beyond the budget
 * evict LRU idle workers first; a fresh boot is refused with the named
 * `worker_busy` error only when nothing can evict (the only idle candidate
 * is busy). Setup tuned to the measured reality (~50 MB steady per worker,
 * heartbeat every 2 s): a tight budget (80 MB) makes the second worker's
 * boot evict the first, and a busy first worker refuses the third. */
import test from 'node:test';
import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, cleanup, client } from './helpers.js';
import * as hub from '../lib/hub.js';
import * as store from '../lib/store.js';
import * as config from '../lib/config.js';
import * as runm from '../lib/hub-workers-run.js';

const FIXTURE = 'test/fixtures/hub/fixture-dist';
const SHA40 = (c) => c.repeat(40);

const POOL_PROBE = `
router.get('/ping', function () { return new Response('pong', { status: 200 }); });
router.post('/sleep', async function () {
  await new Promise((ok) => setTimeout(ok, 2500));
  return new Response('awake', { status: 200 });
});
`;

let running;
let hostC;
const heartbeat = () => new Promise((ok) => setTimeout(ok, 2600));

const exec = (name, route, method = 'GET', extra = {}) => hostC.post('hub/workers/exec', {
  target: name, method, path: route,
  headers: { 'content-type': 'application/json' },
  ...(method === 'POST' ? { body: JSON.stringify(extra) } : {}),
});

before(async () => {
  running = await start();
  store.addUser('person1', 'person1-password');
  hub.installFromDist('alpha', FIXTURE, { sha: SHA40('a'), source: 'import', title: 'Alpha' });
  config.set('workers.timeout_ms', 12000);
  config.set('workers.rss_mb', 96);
  // Conservative boot estimate (§20 default 64 MB; measured steady ≈ 50 MB)
  // against a tight 80 MB budget: two workers cannot coexist.
  config.set('workers.pool_rss_budget_mb', 80);
  config.set('workers.boot_rss_estimate_mb', 64);

  hostC = client(running.base);
  await hostC.login('person1', 'person1-password');
  const wr = await hostC.call('PUT', 'hub/fs/write?app=alpha&path=workers/pool.js&options=' + encodeURIComponent('{}'), { body: POOL_PROBE, raw: true });
  assert.equal(wr.status, 200, JSON.stringify(wr.body));
  for (const name of ['pool-a', 'pool-b', 'pool-c']) {
    const created = await hostC.post('hub/workers', { app: 'alpha', name, filePath: 'workers/pool.js' });
    assert.equal(created.status, 200, JSON.stringify(created.body));
  }
});
after(() => cleanup(running));

test('first worker boots and warms into its RSS report', async () => {
  const r = await exec('pool-a', '/ping');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(String(r.body), 'pong');
  await heartbeat();
  const stats = runm.workerStats();
  const a = stats.find((s) => s.key === 'person1:pool-a');
  assert.ok(a, `pool-a must be pooled: ${JSON.stringify(stats)}`);
  assert.ok(a.rssBytes > 10 * 1048576, `pool-a must have reported RSS: ${a.rssBytes}`);
});

test('booting a second worker evicts the LRU idle first, not refuses', async () => {
  const r = await exec('pool-b', '/ping');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const stats = runm.workerStats();
  assert.ok(!stats.some((s) => s.key === 'person1:pool-a'), `pool-a must have been evicted: ${JSON.stringify(stats.map((s) => s.key))}`);
  assert.ok(stats.some((s) => s.key === 'person1:pool-b'), `pool-b must be pooled`);
});

test('a boot beyond budget with NOTHING evictable is refused as worker_busy', async () => {
  // pool-b idle → would be evictable… but pool-a respawns warm on demand!
  // pin pool-b BUSY with /sleep so nothing is evictable when pool-c boots.
  const busy = exec('pool-b', '/sleep', 'POST', {});
  await new Promise((ok) => setTimeout(ok, 250)); // the job must be in flight
  const before = runm.workerStats();
  assert.ok(before.some((s) => s.key === 'person1:pool-b' && s.busy > 0), 'pool-b must be busy for this test');
  const c = await exec('pool-c', '/ping');
  assert.equal(c.status, 503, `pool-c must be refused: ${JSON.stringify(c.body)}`);
  assert.equal(c.body?.code, 'worker_busy', JSON.stringify(c.body));
  const after = runm.workerStats();
  assert.ok(after.some((s) => s.key === 'person1:pool-b'), 'the busy worker must survive the refusal');
  assert.ok(!after.some((s) => s.key === 'person1:pool-c'), 'nothing pooled for the refused boot');
  const b = await busy;
  assert.equal(b.status, 200, JSON.stringify(b.body));
  // when pool-b goes idle again, pool-c CAN boot (evicts pool-b LRU)
  await heartbeat();
  const c2 = await exec('pool-c', '/ping');
  assert.equal(c2.status, 200, JSON.stringify(c2.body));
});

test('eviction is visible in the audit log with a named reason', async () => {
  const log = await hostC.get('hub/workers/logs');
  assert.equal(log.status, 200, JSON.stringify(log.body));
  const rows = Array.isArray(log.body) ? log.body : [];
  const actions = rows.map((r) => r.action);
  assert.ok(actions.includes('pool-evict'), `audit must name the LRU eviction: ${actions.join(', ')}`);
});
