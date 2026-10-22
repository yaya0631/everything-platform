/** §10 packaged system workers: an app dist's workers/<name>.js files install
 * as server-owned rows (user NULL + app), resolve FIRST on bare-name exec
 * even when a member holds the same name, are deletable by no member, go
 * public only through approval, and a CHANGED source resets the approval
 * with a redeploy audit row (§22's overwrite-redeploy rule). An unknown
 * *.puter.work exec target is a named external_not_allowed error, never a
 * silent pass-through. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

let running;
let hostC;

before(async () => {
  running = await start();
  store.addUser('person1', 'person1-password');
  hostC = client(running.base);
  hub.installFromDist('alpha', FIXTURE, { sha: SHA40('a'), source: 'import', title: 'Alpha' });
  config.set('workers.timeout_ms', 12000);
  await hostC.login('person1', 'person1-password');
});
after(() => cleanup(running));

/** A temp dist that ships a workers/mail-error.js (its own fake "system"). */
function tmpDistWithWorker(workerSource) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-dist-'));
  fs.mkdirSync(path.join(dist, 'workers'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'workers', 'alpha-mail.js'), workerSource);
  return dist;
}

const MAIL_SOURCE =
`router.get('/ping', function () { return new Response('packaged-pong', { status: 200 }); });
router.post('/healthz', async function () { return new Response(JSON.stringify({ ok: 1 }), { status: 200 }); });
`;

test('installPackagedFromDist: the dist worker becomes a server-owned row served /wr/app/…', async () => {
  const dist = tmpDistWithWorker(MAIL_SOURCE);
  try {
    const names = await hubWorkersm.installPackagedFromDist('alpha', dist);
    assert.deepEqual(names, ['alpha-mail']);
    const row = hubWorkersm.resolveRoute({ app: 'alpha', name: 'alpha-mail' });
    assert.ok(row, 'a user NULL row exists');
    assert.equal(row.user, null);
    assert.equal(row.script_kind, 'packaged');
    assert.equal(row.url_path, '/wr/app/alpha/alpha-mail/');
  } finally {
    fs.rmSync(dist, { recursive: true, force: true });
  }
});

test('bare-name exec resolves the PACKAGED row first, even under a member with the same name', async () => {
  // person1 deploys their OWN alpha-mail with a DIFFERENT answer — it must
  // not shadow the system one, and their own stays reachable per-owner.
  const ownSource = `router.get('/ping', function () { return new Response('own-pong', { status: 200 }); });`;
  const wr = await hostC.call('PUT', 'hub/fs/write?app=alpha&path=workers/mail.js&options=' + encodeURIComponent('{}'), { body: ownSource, raw: true });
  assert.equal(wr.status, 200, JSON.stringify(wr.body));
  const own = await hostC.post('hub/workers', { app: 'alpha', name: 'alpha-mail', filePath: 'workers/mail.js' });
  assert.equal(own.status, 200, JSON.stringify(own.body));

  const bare = await hostC.post('hub/workers/exec', { target: 'alpha-mail', method: 'GET', path: '/ping' });
  assert.equal(bare.status, 200, JSON.stringify(bare.body));
  assert.equal(String(bare.body), 'packaged-pong');

  // The member's own deploy is still reachable through the owner-scoped form.
  const scoped = await hostC.post('hub/workers/exec', { target: 'person1/alpha-mail', method: 'GET', path: '/ping' });
  assert.equal(scoped.status, 200, JSON.stringify(scoped.body));
  assert.equal(String(scoped.body), 'own-pong');
});

test('a member cannot delete a packaged row even though the name matched theirs', async () => {
  const del = await hostC.post('hub/workers/delete', { name: 'alpha-mail' });
  const status = del.status;
  assert.ok([200, 404, 400].includes(status), JSON.stringify(del.body));
  // Either way, the packaged row SURVIVES.
  assert.ok(hubWorkersm.resolveRoute({ app: 'alpha', name: 'alpha-mail' }), 'packaged row survives member deletion');
});

test('public serving is approval-gated, and a CHANGED source resets it (redeploy rule)', async () => {
  const row = hubWorkersm.resolveRoute({ app: 'alpha', name: 'alpha-mail' });
  assert.equal(hubWorkersm.isPublicServing(row), false, 'fresh install is private');

  hubWorkersm.approvePublic({ app: 'alpha' }, 'alpha-mail', true);
  const approved = hubWorkersm.resolveRoute({ app: 'alpha', name: 'alpha-mail' });
  assert.equal(hubWorkersm.isPublicServing(approved), true, 'admin approval turns public serving on');

  // A changed sha resets approval WITHOUT action (the redeploy rule).
  const dist2 = tmpDistWithWorker(MAIL_SOURCE + '\n// v2: changed source\n');
  try {
    await hubWorkersm.installPackagedFromDist('alpha', dist2);
    const redeployed = hubWorkersm.resolveRoute({ app: 'alpha', name: 'alpha-mail' });
    assert.notEqual(redeployed.sha, approved.sha, 'the sha actually changed');
    assert.equal(hubWorkersm.isPublicServing(redeployed), false, 'public serving before re-approval');
    const rows = hubWorkersm.recentLogsAll(20);
    assert.ok(rows.some((r) => r.action === 'redeploy'), JSON.stringify(rows.map((r) => r.action)));
  } finally {
    fs.rmSync(dist2, { recursive: true, force: true });
  }
});

test('an unknown *.puter.work exec target is external_not_allowed, not a silent miss', async () => {
  const r = await hostC.post('hub/workers/exec', {
    target: 'https://helpdesk-whatever.puter.work/ping', method: 'GET', path: '/ping',
  });
  assert.ok([403, 404].includes(r.status), JSON.stringify(r.body));
  assert.equal(r.body?.code, 'external_not_allowed');
  const miss = await hostC.post('hub/workers/exec', { target: 'no-such-worker', method: 'GET', path: '/ping' });
  assert.equal(miss.status, 404);
  assert.equal(miss.body?.code, 'worker_not_found');
});
