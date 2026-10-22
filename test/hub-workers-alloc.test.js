/** Worker memory: a single Buffer.alloc(400 MB, 1) used to return 200 and go
 * unnoticed — the §20 RSS watchdog only sees work in flight, and one fast
 * allocation finishes before it ticks. Layer 2d (runner) now checks the
 * REQUESTED byte count BEFORE the allocation happens — Buffer.alloc /
 * allocUnsafe / allocUnsafeSlow / .from, ArrayBuffer, SharedArrayBuffer and
 * every typed-array constructor — against workers.alloc_cap_mb (64 default;
 * the parent passes it to the child as CAD_WORKER_ALLOC_CAP, the one
 * non-allow-list env value the child ever sees, a bare number). A denied
 * attempt is a named 500 (`alloc_cap_exceeded`), while legitimate
 * sub-cap allocations keep working. Best-effort: see the README's limits
 * paragraph — in-process gates are convenience, private-only is the rule. */
import test from 'node:test';
import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, cleanup, client } from './helpers.js';
import * as hub from '../lib/hub.js';
import * as store from '../lib/store.js';
import * as config from '../lib/config.js';

const FIXTURE = 'test/fixtures/hub/fixture-dist';
const SHA40 = (c) => c.repeat(40);

let running;
let hostC;

const PROBE = `
router.post('/alloc', async function (ctx) {
  const mb = Number(new URL(ctx.request.url).searchParams.get('mb') ?? 400);
  const buf = Buffer.alloc(mb * 1024 * 1024, 1);
  return new Response('allocated ' + buf.length, { status: 200 });
});
router.get('/arraybuf', async function () {
  const ab = new ArrayBuffer(400 * 1024 * 1024);
  void ab;
  return new Response('arraybuffer ok', { status: 200 });
});
router.get('/safe', async function () {
  const small = Buffer.alloc(1024 * 1024, 7);
  const u8 = new Uint8Array(64 * 1024);
  return new Response('ok ' + small[0] + '/' + u8.length, { status: 200 });
});
`;

before(async () => {
  running = await start();
  store.addUser('person1', 'person1-password');
  hub.installFromDist('alpha', FIXTURE, { sha: SHA40('a'), source: 'import', title: 'Alpha' });
  config.set('workers.timeout_ms', 12000);
  hostC = client(running.base);
  await hostC.login('person1', 'person1-password');
  const wr = await hostC.call('PUT', 'hub/fs/write?app=alpha&path=workers/mem.js&options=' + encodeURIComponent('{}'), { body: PROBE, raw: true });
  assert.equal(wr.status, 200, JSON.stringify(wr.body));
  const created = await hostC.post('hub/workers', { app: 'alpha', name: 'mem-probe', filePath: 'workers/mem.js' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
});

after(() => cleanup(running));

const exec = (path, method = 'GET') => hostC.post('hub/workers/exec', { target: 'mem-probe', method, path });

test('a 400 MB Buffer.alloc is refused with the named error, before it happens', async () => {
  const r = await exec('/alloc?mb=400', 'POST');
  assert.equal(r.status, 500, `the 400 MB attempt must not succeed: ${JSON.stringify(r.body)}`);
  assert.ok(String(r.body).includes('alloc_cap_exceeded'), `named error in the body: ${String(r.body).slice(0, 200)}`);
  assert.ok(String(r.body).includes('Buffer.alloc'), String(r.body).slice(0, 200));
});

test('a 400 MB ArrayBuffer is refused by the same layer', async () => {
  const r = await exec('/arraybuf');
  assert.equal(r.status, 500, JSON.stringify(r.body));
  assert.ok(String(r.body).includes('alloc_cap_exceeded'), String(r.body).slice(0, 200));
});

test('sub-cap allocations keep working (the cap is not a blanket ban)', async () => {
  // 20 MB is above any earlier test allocation and far below the 64 MB cap;
  // small typed arrays ride along.
  const r = await exec('/alloc?mb=20', 'POST');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(String(r.body), 'allocated 20971520');
  const safe = await exec('/safe');
  assert.equal(safe.status, 200, JSON.stringify(safe.body));
  assert.equal(String(safe.body), 'ok 7/65536');
});
