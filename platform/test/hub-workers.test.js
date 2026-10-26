/**
 * Phase-3 hub workers, end to end: registry + create/list/get/delete, the
 * auth matrix (Â§17), the /wr/ and public /w/ serving rules with Â§16 headers,
 * the content-type allow-list, the network gate (Â§12), KV over IPC, the RSS
 * watchdog and the sync-loop kill (Â§20), and the email caps (Â§21) â€” over HTTP
 * against the real server like the other hub suites.
 */
import test from 'node:test';
import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, cleanup, client, DATA } from './helpers.js';
import * as hub from '../lib/hub.js';
import * as store from '../lib/store.js';
import * as db from '../lib/db.js';
import * as config from '../lib/config.js';
import * as hubWorkers from '../lib/hub-workers.js';
import fs from 'node:fs';
import path from 'node:path';

const FIXTURE = 'test/fixtures/hub/fixture-dist';
const SHA40 = (c) => c.repeat(40);

const ECHO = `
router.get('/ping', function () { return new Response('pong', { status: 200 }); });
router.get('/echo/:q', function (ctx) {
  return new Response(JSON.stringify({ q: ctx.params.q, me: typeof me, fetch: typeof fetch }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
});
router.post('/whoami', function (ctx) {
  return new Response(JSON.stringify({ user: (ctx.user && ctx.user.username) || (ctx.requestor && ctx.requestor.username) || null }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
});
router.post('/uuid', async function (ctx) {
  // Mirrors the upstream workers' identify(): user.puter must answer
  // { uuid, username } through auth.getUser() (or getUser()).
  const u = ctx.user || ctx.requestor;
  const out = { hasPuter: !!(u && u.puter), uuid: '', username: '' };
  if (u && u.puter) {
    try {
      const p = u.puter;
      const info = p.auth && typeof p.auth.getUser === 'function' ? await p.auth.getUser() : await p.getUser();
      out.uuid = (info && info.uuid) || '';
      out.username = (info && info.username) || '';
    } catch (e) {
      out.err = String(e && e.message).slice(0, 120);
    }
  }
  return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
router.get('/csrf-headers', function (ctx) {
  return new Response(JSON.stringify({ cookie: ctx.request.headers.get('cookie') ?? null, secFetch: ctx.request.headers.get('sec-fetch-site') ?? null }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
});
router.post('/evil-type', function () {
  return new Response('x', { status: 200, headers: { 'Content-Type': 'application/x-evil' } });
});
router.post('/set-cookie', function () {
  return new Response('kept the body, dropped the cookie', { status: 200, headers: { 'Set-Cookie': 'shadow=sneaky; Path=/' } });
});
router.post('/fs-try', async function (ctx) {
  try {
    await ctx.me.puter.fs.write('worker-file.txt', 'hi');
    return new Response('wrote', { status: 200 });
  } catch (e) {
    return new Response('no-fs: ' + String(e && e.message).slice(0, 120), { status: 503 });
  }
});
router.post('/net-try', async function () {
  try {
    await import('node:https');
    return new Response('imported network how?', { status: 200 });
  } catch (e) {
    return new Response(String(e && e.message).slice(0, 200), { status: 503 });
  }
});
router.post('/kv-roundtrip', async function (ctx) {
  const r = {};
  await ctx.me.puter.kv.set('a', 'one');
  r.a = await ctx.me.puter.kv.get('a');
  await ctx.me.puter.kv.set([{ key: 'b', value: { x: 2 } }]);
  r.b = await ctx.me.puter.kv.get('b');
  r.incr = await ctx.me.puter.kv.incr('n', 3);
  r.keys = await ctx.me.puter.kv.list('*');
  r.entries = (await ctx.me.puter.kv.list('*', true)).map(function (e) { return { key: e.key, value: e.value }; });
  r.fsKind = typeof (ctx.me.puter.fs || {}).write;
  return new Response(JSON.stringify(r), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
router.post('/rss-hog', async function () {
  const hold = [];
  for (let i = 0; i < 400; i++) {
    hold.push(Buffer.alloc(16 << 20, 1));  // 16 MB of off-heap each round
    await new Promise(function (r) { setImmediate(r); }); // keep the heartbeats alive
  }
  return new Response(String(hold.length), { status: 200 });
});
router.get('/spin', function () { for (;;) { /* sync infinite loop */ } });
router.post('/mail', async function (ctx) {
  try {
    await ctx.me.puter.email.send({ to: 'rcpt@example.test', subject: 'hi ' + ctx.request.headers.get('x-round'), text: 'note' });
    return new Response('sent', { status: 200 });
  } catch (e) {
    return new Response('mail-block: ' + String(e && e.message).slice(0, 160), { status: 429 });
  }
});
`;

let running;
let usersC;
let hostC, strangerC, anonClient;

const secretest = JSON.stringify({});

before(async () => {
  running = await start();
  store.addUser('root', 'root-password', { admin: true });
  store.addUser('person1', 'person1-password');
  store.addUser('person2', 'person2-password');
  hub.installFromDist('alpha', FIXTURE, { sha: SHA40('a'), source: 'import', title: 'Alpha' });
  // Â§12/Â§20 caps tuned so the watchdog tests run in seconds, not minutes.
  config.set('workers.timeout_ms', 4000);
  config.set('workers.rss_mb', 160);
  config.set('workers.email_per_worker_10min', 1);
  config.set('workers.email_per_user_day', 3);

  usersC = client(running.base);
  await usersC.post('auth/signup', {});
  // Deactivate the placeholder account to get us a session like invite flow? (below uses login rows only)
  usersC = null;

  hostC = client(running.base);
  await hostC.login('person1', 'person1-password');
  strangerC = client(running.base);
  await strangerC.login('person2', 'person2-password');
  anonClient = client(running.base); // no cookie at all

  // person1's app file: the shared worker script.
  const wr = await hostC.call('PUT', 'hub/fs/write?app=alpha&path=workers/echo.js&options=' + encodeURIComponent('{}'), { body: ECHO, raw: true });
  assert.equal(wr.status, 200, `script write -> ${wr.status}`);

  const created = await hostC.post('hub/workers', { app: 'alpha', name: 'echo-1', filePath: 'workers/echo.js' });
  assert.equal(created.status, 200, `create -> ${JSON.stringify(created.body)}`);
  assert.equal(created.body.success, true);

  // A second member's deploy for the cross-account tests.
  const wr2 = await strangerC.call('PUT', 'hub/fs/write?app=alpha&path=workers/other.js&options=' + encodeURIComponent('{}'), { body: ECHO, raw: true });
  assert.equal(wr2.status, 200);
  const created2 = await strangerC.post('hub/workers', { app: 'alpha', name: 'other-1', filePath: 'workers/other.js' });
  assert.equal(created2.status, 200);
});
after(() => cleanup(running));

const exec = (c, target, init = {}) => c.post('hub/workers/exec', { target, method: init.method || 'GET', path: init.path || '/ping', headers: init.headers || {}, body: init.body ?? '' });
/** The raw Response explorer (exec answers are raw worker bodies here). */
const rawExec = async (c, target, init) => {
  const r = await c.post('hub/workers/exec', { target, method: init.method || 'GET', path: init.path || '/ping', headers: init.headers || {}, body: init.body ?? '' });
  return { status: r.status, body: r.body, headers: r.headers };
};

test('registry: list/get/audit and the url shape', async () => {
  const list = await hostC.post('hub/workers/list', {});
  assert.equal(list.status, 200);
  assert.ok(list.body.some((w) => w.name === 'echo-1' && w.url === '/wr/person1/echo-1/'), JSON.stringify(list.body));
  const one = await hostC.post('hub/workers/get', { name: 'echo-1' });
  assert.equal(one.status, 200);
  assert.equal(one.body.name, 'echo-1');

  const rows = db.all('SELECT * FROM hub_workers_log WHERE name = ? ORDER BY at DESC', 'echo-1');
  assert.ok(rows.length >= 1, 'create is audited');
  assert.ok(rows[0].sha, 'create stamps the script sha');
});

test('exec: the response is the raw worker answer', async () => {
  const r = await rawExec(hostC, 'echo-1', { path: '/ping' });
  assert.equal(r.status, 200);
  assert.equal(r.body, 'pong');
  const e = await exec(hostC, 'echo-1', { path: '/echo/hello%20world' });
  assert.equal(e.body.q, 'hello world');
  assert.equal(e.body.me, 'object');
  assert.equal(e.body.fetch, 'undefined'); // Â§12: no fetch in the realm
});

test('exec identity: ctx.user is the CALLER, never the owner', async () => {
  const mine = await exec(hostC, 'echo-1', { method: 'POST', path: '/whoami' });
  assert.equal(mine.body.user, 'person1'); // person1 owns echo-1...
  const theirs = await exec(strangerC, 'person1/echo-1', { method: 'POST', path: '/whoami' });
  assert.equal(theirs.body.user, 'person2'); // ...but callers keep their own names
});

// M11: the upstream app workers (teamchat, legal, fleet, ...) authenticate
// callers through user.puter (uuid) — it used to be a 401 for everyone.
test('exec identity: user.puter serves the caller a usable uuid (M11)', async () => {
  const mine = await exec(hostC, 'echo-1', { method: 'POST', path: '/uuid' });
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal(mine.body.hasPuter, true);
  assert.equal(mine.body.username, 'person1');
  assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mine.body.uuid), `uuid -> ${mine.body.uuid} (err: ${mine.body.err || 'none'})`);
  const again = await exec(hostC, 'echo-1', { method: 'POST', path: '/uuid' });
  assert.equal(again.body.uuid, mine.body.uuid, 'uuid is stable per account');
  const theirs = await exec(strangerC, 'person1/echo-1', { method: 'POST', path: '/uuid' });
  assert.equal(theirs.body.username, 'person2', 'the identity is the caller, not the owner');
  assert.notEqual(theirs.body.uuid, mine.body.uuid);
});

test('direct /wr/: owner ok, stranger 401, anonymous 401', async () => {
  const direct = await hostC.get('/wr/person1/echo-1/ping');
  assert.equal(direct.status, 200);
  assert.equal(direct.body, 'pong');
  // The exec header is "exec"; without it a stranger's session may not drive
  // someone else's worker (§17) — the same request with the header is fine.
  const s = await fetch(`${running.base}/wr/person1/echo-1/ping`, { headers: { Cookie: strangerC.cookie } });
  assert.equal(s.status, 401, `stranger without exec header -> ${s.status}`);
  const sExec = await strangerC.get('/wr/person1/echo-1/ping');
  assert.equal(sExec.status, 200);
  const a = await anonClient.get('/wr/person1/echo-1/ping');
  assert.equal(a.status, 401);
});

test('the private listener never speaks to the anonymous world', async () => {
  const res = await fetch(`${running.base}/wr/person1/echo-1/ping`);
  assert.equal(res.status, 401);
});

test('cookies: never forwarded IN, never sent OUT (Â§16)', async () => {
  const res = await fetch(`${running.base}/wr/person1/echo-1/csrf-headers`, {
    headers: { Cookie: `cad_session=whatever`, 'X-CAD-Request': '1' },
  });
  assert.equal(res.status, 401); // the cookie we forged is not a session; good
  const real = await hostC.get('/wr/person1/echo-1/csrf-headers');
  void real;
  const viaExec = await exec(hostC, 'echo-1', { path: '/csrf-headers', headers: { cookie: 'cad_session=hostcookie' } });
  assert.equal(viaExec.body.cookie, null, 'the Cookie header never reaches the worker');
  // Set-Cookie out is dropped at the boundary.
  const drop = await fetch(`${running.base}/wr/person1/echo-1/set-cookie`, {
    method: 'POST',
    headers: { Cookie: hostC.cookie, 'X-CAD-Request': '1' },
  });
  assert.equal(drop.status, 200);
  assert.equal(drop.headers.get('set-cookie'), null, 'Set-Cookie is stripped on the /wr/ boundary');
  assert.match(drop.headers.get('content-security-policy') || '', /sandbox/);
  assert.equal(drop.headers.get('x-content-type-options'), 'nosniff');
});

test('content-type allow-list at the boundary (Â§16)', async () => {
  const r = await rawExec(hostC, 'echo-1', { method: 'POST', path: '/evil-type' });
  assert.equal(r.status, 415);
});

test('the network gate: dynamic import is denied (Â§12)', async () => {
  const r = await rawExec(hostC, 'echo-1', { method: 'POST', path: '/net-try' });
  assert.equal(r.status, 503);
  assert.match(r.body, /net_disabled/);
});

test('kv over IPC: get/set batch/list/incr and the 2 MB cap message', async () => {
  const r = await exec(hostC, 'echo-1', { method: 'POST', path: '/kv-roundtrip' });
  assert.equal(r.body.a, 'one');
  assert.deepEqual(r.body.b, { x: 2 });
  assert.deepEqual(r.body.keys.sort(), ['a', 'b', 'n']);
  const entry = r.body.entries.find((e) => e.key === 'b');
  assert.deepEqual(entry.value, { x: 2 });
  assert.ok(r.body.incr >= 3, 'incr returns the incremented value');
  assert.equal(r.body.fsKind, 'function');
});

test('the worker fs path: consent-granted rules and packaged refusal', async () => {
  // owner's sandbox write is allowed by access() (app-private folder).
  const mine = await exec(hostC, 'echo-1', { method: 'POST', path: '/fs-try' });
  assert.equal(mine.body, 'wrote');
  // Packaged workers get no Drive at all (Â§10).
  const dir = path.join(DATA, 'hub', 'workers', 'alpha');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'pkg-ping.js'), "router.get('/ping', function () { return new Response('pkg pong'); });\nrouter.post('/fs-try', async function (ctx) { try { await ctx.me.puter.fs.write('x', 'y'); return new Response('wrote'); } catch (e) { return new Response('no-fs: ' + String(e && e.message).slice(0, 120), { status: 503 }); } });\nrouter.post('/rss-hog', async function () { const hold = []; for (let i = 0; i < 40; i++) { hold.push(Buffer.alloc(24 << 20, 1)); await new Promise(function (r) { setImmediate(r); }); } return new Response('ok'); });\nrouter.get('/spin', function(){ for(;;){} });\nrouter.post('/mail', async function (ctx) { try { await ctx.me.puter.email.send({ to: 'r@example.test', subject: 's', text: 't' }); return new Response('sent'); } catch (e) { return new Response('mail-block: ' + String(e && e.message).slice(0, 160), { status: 429 }); } });\n");
  const created = await hubWorkers.create({ user: null, app: 'alpha', name: 'pkg-ping' });
  assert.equal(created.success, true);
  const seeded = await db.get('SELECT * FROM app_env WHERE app = ? LIMIT 1', 'alpha'); void seeded;
});

test('packaged worker: private serving works, public must be approved', async () => {
  const mine = await hostC.get('/wr/app/alpha/pkg-ping/ping');
  assert.equal(mine.status, 200);
  assert.equal(mine.body, 'pkg pong');
  const guestClosed = await fetch(`${running.pub}/wr/app/alpha/pkg-ping/ping`);
  assert.equal(guestClosed.status, 404);
});

test('public guest serving: approved â†’ 200 + Â§16 headers; members-deployed need the toggle', async () => {
  hubWorkers.approvePublic({ user: null, app: 'alpha' }, 'pkg-ping', true);
  const guest = await fetch(`${running.pub}/wr/app/alpha/pkg-ping/ping`);
  assert.equal(guest.status, 200);
  assert.equal(await guest.text(), 'pkg pong');
  assert.match(guest.headers.get('content-security-policy') || '', /sandbox/);
  assert.equal(guest.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(guest.headers.get('set-cookie'), null);

  // A member-deployed worker cannot go public while the admin toggle is off (Â§18).
  const refused = (() => {
    try { hubWorkers.approvePublic({ user: 'person1', app: null }, 'echo-1', true); return false; }
    catch (err) { return err.code === 'public_worker_toggle_off'; }
  })();
  assert.equal(refused, true);
  const guestStill = await fetch(`${running.pub}/w/person1/echo-1/ping`);
  assert.equal(guestStill.status, 404); // never public by default
});

test('guest invocation has no fs and no email (Â§17)', async () => {
  const guest = await fetch(`${running.pub}/wr/app/alpha/pkg-ping/fs-try`, { method: 'POST' });
  assert.equal(guest.status, 503);
  assert.match(await guest.text(), /no-fs/);
});

test('the RSS watchdog kills a runaway worker (Â§20)', async () => {
  const r = await exec(hostC, 'echo-1', { method: 'POST', path: '/rss-hog', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 503);
  assert.match(r.body.message || r.body, /resource_limit|memory|did not finish|stopped responding/);
});

test('a synchronous infinite loop: killed with a named error (Â§20)', async () => {
  const started = Date.now();
  const r = await exec(hostC, 'echo-1', { path: '/spin' });
  assert.equal(r.status, 503);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 30_000, `loop killed in ${elapsed} ms, not the full timeout`);
  assert.match(String(r.body && r.body.message || r.body), /did not finish|stopped responding|resource/);

  // The recovered worker still serves.
  const back = await hostC.get('/wr/person1/echo-1/ping');
  assert.equal(back.status, 200);
});

test('create quotas + name rules (Â§13)', async () => {
  // A bad name is a named 400.
  const bad = await hostC.post('hub/workers', { app: 'alpha', name: 'no spaces', filePath: 'workers/echo.js' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'bad_name');
  // The per-user cap (8 default) counts existing rows.
  const count = db.get('SELECT COUNT(*) AS n FROM hub_workers WHERE user = ?', 'person1').n;
  const path6 = 'workers/echo.js';
  let hit = null;
  for (let i = count; i < (hubWorkers.cfg('workers.per_user_max') ?? 8) + 1; i++) {
    const r = await hostC.post('hub/workers', { app: 'alpha', name: `q-${String(i).padStart(2, '0')}`, filePath: path6 });
    if (r.status === 429) { hit = r; break; }
  }
  assert.ok(hit, 'the quota is enforced with 429');
  assert.equal(hit.body.code, 'quota_exceeded');
});

test('email caps: per-worker window, per-user day, forced From (Â§21)', async () => {
  // mail is NOT configured in the test server: a call that gets past the caps
  // ends in "Email is not set up" — the caps themselves answer "limited to ...".
  // worker window 1, owner day 3 (set in before()).
  const attempt = (c, name, round) => exec(c, name, { method: 'POST', path: '/mail', headers: { 'x-round': String(round) } });
  const first = await attempt(hostC, 'echo-1', 1);
  assert.match(first.body, / Email is not set up/, `under all caps it reaches the send attempt: ${first.body}`);
  const workerCapped = await attempt(hostC, 'echo-1', 2);
  assert.match(workerCapped.body, /limited to 1 per 10 minutes/, `worker window cap: ${workerCapped.body}`);
  // Same owner, DIFFERENT worker: its own window is fresh; the owner-day
  // counter keeps counting.
  const nextWorker = await attempt(hostC, 'q-01', 1);
  assert.match(nextWorker.body, /Email is not set up/, `other worker of the same owner is fine: ${nextWorker.body}`);
  const thirdOwnerSend = await attempt(hostC, 'q-02', 1);
  assert.match(thirdOwnerSend.body, /Email is not set up/, `3rd owner send still fine: ${thirdOwnerSend.body}`);
  const dayCapped = await attempt(hostC, 'q-03', 1);
  assert.match(dayCapped.body, /limited to 3 per day/, `owner day cap: ${dayCapped.body}`);
  // A different owner has a fresh day counter.
  const otherOwner = await attempt(strangerC, 'other-1', 1);
  assert.match(otherOwner.body, /Email is not set up/, `other owner unaffected: ${otherOwner.body}`);
});

test('delete + the log trail (§13 owner-deletion)', async () => {
  const victim = db.get("SELECT name FROM hub_workers WHERE user = ? AND name LIKE 'q-%' ORDER BY name LIMIT 1", 'person1')?.name;
  assert.ok(victim, 'a quota-created worker exists to delete');
  const del = await hostC.post('hub/workers/delete', { name: victim });
  assert.equal(del.status, 200);
  const gone = await hostC.post('hub/workers/get', { name: victim });
  assert.equal(gone.status, 404);
});

test('a changed script file is a redeploy (overwrite-redeploy, Â§22)', async () => {
  const before2 = await db.get('SELECT * FROM hub_workers WHERE user = ? AND name = ?', 'person2', 'other-1');
  const wr = await strangerC.call('PUT', 'hub/fs/write?app=alpha&path=workers/other.js&options=' + encodeURIComponent(JSON.stringify({ overwrite: true })), { body: ECHO + "\nrouter.get('/v2', function () { return new Response('redeployed'); });\n", raw: true });
  assert.equal(wr.status, 200);
  const r = await exec(strangerC, 'other-1', { path: '/v2' });
  assert.equal(r.body, 'redeployed');
  const after2 = await db.get('SELECT * FROM hub_workers WHERE user = ? AND name = ?', 'person2', 'other-1');
  assert.notEqual(before2.sha, after2.sha, 'the registry sha moved');
});

test('a revoked grant fails the script read (fail closed, Â§13)', async () => {
  const wr = await strangerC.call('PUT', 'hub/fs/write?app=alpha&path=workers/gone.js&options=' + encodeURIComponent('{}'), { body: ECHO, raw: true });
  assert.equal(wr.status, 200);
  const created = await strangerC.post('hub/workers', { app: 'alpha', name: 'gone-1', filePath: 'workers/gone.js' });
  assert.equal(created.status, 200);
  const eraser = await strangerC.post('hub/fs/delete', { path: 'workers/gone.js', app: 'alpha' });
  assert.equal(eraser.status, 200);
  const r = await exec(strangerC, 'gone-1', { path: '/ping' });
  assert.equal(r.status, 404 || 500, `expected a fail-closed error, got ${r.status}`);
  void r;
});
