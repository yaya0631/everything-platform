/**
 * Hosted web apps: staging/publish/rollback, the launcher and sandboxed content
 * mounts, scoped token hands and the /appapi. The tests here are mostly about
 * isolation: an app may only reach its person's AppData folder and exactly the
 * granted files, public visitors never touch files or key-value data, and
 * public AI/email stay off until the admin switches them on.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { start, cleanup, client } from './helpers.js';

let running, store, mail, config, db, http, paths;
let admin, sam, kim, visitorToken, gammaToken, deltaToken;

const sandboxCsp = /sandbox( allow-\w+)*;/;
const page = async (kind, path, { method = 'GET', token, json, body, ip, headers = {} } = {}) => {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (ip) h['x-forwarded-for'] = ip;
  let data = body;
  if (json !== undefined) {
    h['Content-Type'] = 'application/json';
    data = JSON.stringify(json);
  }
  const res = await fetch(`${running[kind]}${path}`, { method, headers: h, body: data, redirect: 'manual' });
  const type = res.headers.get('content-type') || '';
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: type.includes('json') && text ? JSON.parse(text) : text };
};

const sandbox = (res) => ({
  csp: res.headers.get('content-security-policy') || '',
  acao: res.headers.get('access-control-allow-origin') || '',
  corp: res.headers.get('cross-origin-resource-policy') || '',
});

/** Upload files into staging, then publish. */
const deploy = async (c, name, files) => {
  for (const [p, text] of Object.entries(files)) {
    const r = await c.call('PUT', `admin/apps/${name}/staging?path=${encodeURIComponent(p)}`, { body: Buffer.from(text) });
    if (r.status !== 200) return r;
  }
  return c.post(`admin/apps/${name}/publish`, {});
};

const V1 = '<h1>alpha v1</h1>';
const V2 = '<h1>alpha v2</h1>';
const INDEX = '<html><body><h1>A tiny app</h1></body></html>\n';

async function setup() {
  running = await start();
  store = await import('../lib/store.js');
  mail = await import('../lib/mail.js');
  config = await import('../lib/config.js');
  db = await import('../lib/db.js');
  http = await import('../lib/http.js');
  paths = await import('../lib/paths.js');
  store.addUser('alex', 'alex-password', { email: 'alex@example.com' });
  store.addUser('sam', 'sam-password');
  store.addUser('kim', 'kim-password');

  admin = client(running.base);
  sam = client(running.base);
  kim = client(running.base);
  await admin.login('alex', 'alex-password');
  await sam.login('sam', 'sam-password');
  await kim.login('kim', 'kim-password');
  const host = await admin.put('admin/users/kim', { canHostApps: true });
  assert.equal(host.body.canHostApps, true);
  // Email for the public-app and email tests (json transport in test mode).
  await admin.put('admin/email', { host: 'json', port: 587, user: 'cad@example.com', from: 'CAD Home <cad@example.com>' });

  const a = await deploy(admin, 'alpha', { 'index.html': V1, 'data/env.json': '{"fresh":true}' });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const b = await deploy(admin, 'bravo', { 'index.html': INDEX });
  assert.equal(b.status, 200);
  const pub = await admin.put('admin/apps/bravo', { visibility: 'public' });
  assert.equal(pub.body.visibility, 'public');
  const g = await deploy(kim, 'gamma', { 'index.html': '<h1>gamma</h1>' });
  assert.equal(g.status, 200);
  const d = await deploy(admin, 'delta', { 'index.html': INDEX });
  assert.equal(d.status, 200);
  const e = await deploy(admin, 'echo', { 'index.html': INDEX });
  assert.equal(e.status, 200);
  assert.equal((await admin.put('admin/apps/echo', { visibility: 'public' })).body.visibility, 'public');

  const vis = await page('pub', '/p/bravo/token', { method: 'POST' });
  assert.equal(vis.status, 200, JSON.stringify(vis.body));
  visitorToken = vis.body.token;
}

before(setup);

after(() => cleanup(running));

test('publish needs an index.html', async () => {
  const r = await client(running.base);
  await r.login('alex', 'alex-password');
  assert.equal((await r.post('admin/apps/hole/publish', {})).status, 400);
  // A bad app name is refused before anything touches disk.
  const bad = await r.call('PUT', 'admin/apps/X/staging?path=index.html', { body: Buffer.from('x') });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'bad_name');
});

test('app content is sandboxed and private to signed-in people', async () => {
  const bare = await page('base', '/app-content/alpha/');
  assert.equal(bare.status, 401);
  const r = await admin.call('GET', '/app-content/alpha/');
  assert.equal(r.status, 200);
  assert.match(r.body, /alpha v1/);
  const s = sandbox(r);
  assert.match(s.csp, sandboxCsp);
  assert.doesNotMatch(s.csp, /allow-same-origin/);
  assert.match(s.csp, /frame-ancestors 'self'/);
  assert.equal(s.acao, '*');
  assert.equal(s.corp, 'cross-origin');
  assert.equal((await admin.call('GET', '/app-content/alpha/data/env.json')).body.fresh, true);
  assert.equal((await admin.call('GET', '/app-content/nothing/')).status, 404);
  const v = await page('base', '/app-content/alpha/');
  assert.equal(v.status, 401);
});

test('the launcher serves from /apps/<name>/ and hands out scoped tokens', async () => {
  const r = await fetch(`${running.base}/apps/alpha/`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /launcher\.js/);
  const bare = client(running.base);
  assert.equal((await bare.post('apps/alpha/token', {})).status, 401); // not signed in
  const nope = await admin.post('apps/nope/token', {});
  assert.equal(nope.status, 404);
  const t = await admin.post('apps/alpha/token', {});
  assert.equal(t.status, 200);
  assert.match(t.body.token, /^[A-Za-z0-9_-]{20,}$/);
  assert.equal(t.body.title, 'alpha');
});

test('public listener: launcher, visitor token, sandboxed content, nothing else', async () => {
  assert.equal((await page('pub', '/p/bravo/')).status, 200);
  assert.equal((await page('pub', '/p/alpha/')).status, 404);
  assert.equal((await page('pub', '/p/gamma/')).status, 404);
  // Private apps do not exist on the public listener at all.
  assert.equal((await page('pub', '/p/alpha/token', { method: 'POST' })).status, 404);
  assert.equal((await page('pub', '/app-content/alpha/')).status, 404);
  assert.equal((await page('pub', '/api/auth/me')).status, 404);
  assert.equal((await page('pub', '/admin/apps')).status, 404);

  const c = await page('pub', '/p-content/bravo/');
  assert.equal(c.status, 200);
  const s = sandbox(c);
  assert.equal(s.acao, '*');
  assert.equal(s.corp, 'cross-origin');
  assert.match(s.csp, sandboxCsp);
  assert.doesNotMatch(s.csp, /allow-same-origin/);
  assert.equal((await page('pub', '/p-content/alpha/')).status, 404);
  assert.equal((await page('pub', '/')).status, 404);

  // The SDK is served to everyone; appapi answers too.
  const sdk = await page('pub', '/sdk/puter.js');
  assert.equal(sdk.status, 200);
  assert.match(sdk.body, /postMessage|refreshToken/);
  const me = await page('pub', '/appapi/bravo/whoami', { token: visitorToken });
  assert.equal(me.status, 200);
  assert.equal(me.body, null);
  const options = await page('pub', '/appapi/bravo/whoami', { method: 'OPTIONS' });
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('access-control-allow-origin'), '*');
  // A private app's appapi answers 404 on the public listener, even with a real token.
  const iSpy = await admin.post('apps/delta/token', {});
  deltaToken = iSpy.body.token;
  const spy = await page('pub', '/appapi/delta/whoami', { token: deltaToken });
  assert.equal(spy.status, 404);
  assert.equal(spy.body.code, 'unknown_app');
  gammaToken = (await kim.post('apps/gamma/token', {})).body.token;
  assert.equal((await page('pub', '/appapi/gamma/whoami', { token: gammaToken })).status, 404);
});

test('staging paths refuse traversal and Windows-reserved names', async () => {
  // A good upload first, so the staging folder exists for the leak check.
  assert.equal((await admin.call('PUT', 'admin/apps/alpha/staging?path=keep.txt', { body: Buffer.from('keep') })).status, 200);
  for (const bad of ['../evil.js', '..\\evil.js', 'x/../evil', 'nul', 'com1.html', 'a:b.txt', 'dir/.', 'trailing ']) {
    const r = await admin.call('PUT', `admin/apps/alpha/staging?path=${encodeURIComponent(bad)}`, { body: Buffer.from('no') });
    assert.equal(r.status, 400, `expected 400 for ${bad}: ${JSON.stringify(r.body)}`);
  }
  // Nothing leaked outside the staging folder.
  assert.deepEqual(fs.readdirSync(`${paths.DATA_DIR}/apps/alpha/.staging`, { recursive: true }), ['keep.txt']);
});

test('rollback swaps between the last two versions', async () => {
  const r0 = await deploy(admin, 'alpha', { 'index.html': V1 });
  assert.equal(r0.status, 200);
  const again = await deploy(admin, 'alpha', { 'index.html': V2 });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.previous, true);
  assert.match((await admin.call('GET', '/app-content/alpha/')).body, /v2/);
  await admin.post('admin/apps/alpha/rollback', {});
  assert.match((await admin.call('GET', '/app-content/alpha/')).body, /v1/);
  // The swap keeps the other version, so it can be toggled back.
  await admin.post('admin/apps/alpha/rollback', {});
  assert.match((await admin.call('GET', '/app-content/alpha/')).body, /v2/);
  // An app without an earlier version cannot roll back.
  const no = await admin.post('admin/apps/bravo/rollback', {});
  assert.equal(no.status, 400);
  assert.equal(no.body.code, 'no_previous');
  // Clearing staging works too.
  assert.equal((await admin.del('admin/apps/alpha/staging', {})).body.ok, true);
});

test('visitors can never touch files or key-value data', async () => {
  const w = await page('pub', '/appapi/bravo/fs/write?path=x.txt', { method: 'PUT', token: visitorToken, body: 'x' });
  assert.equal(w.status, 403);
  assert.equal(w.body.code, 'not_for_visitors');
  assert.equal((await page('pub', '/appapi/bravo/fs/readdir?path=', { token: visitorToken })).body.code, 'not_for_visitors');
  assert.equal((await page('pub', '/appapi/bravo/kv/hi', { method: 'PUT', token: visitorToken, json: { value: 1 } })).body.code, 'not_for_visitors');
  assert.equal((await page('pub', '/appapi/bravo/kv/hi', { token: visitorToken })).body.code, 'not_for_visitors');
  assert.equal((await page('pub', '/appapi/bravo/kv/incr', { method: 'POST', token: visitorToken, json: { key: 'hi' } })).body.code, 'not_for_visitors');
  assert.equal((await page('pub', '/appapi/bravo/kv/flush', { method: 'POST', token: visitorToken })).body.code, 'not_for_visitors');
  // A visitor token from one public app is not valid on another.
  const echoVis = (await page('pub', '/p/echo/token', { method: 'POST' })).body.token;
  assert.match(echoVis, /^.{20,}$/);
  const wrong = await page('pub', '/appapi/bravo/whoami', { token: echoVis, ip: '6.6.6.7' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.code, 'wrong_app');
  // A user token for another app never works, and junk tokens are refused.
  const otherTok = (await admin.post('apps/echo/token', {})).body.token;
  const aliased = await page('pub', '/appapi/bravo/whoami', { token: otherTok, ip: '6.6.6.8' });
  assert.equal(aliased.status, 401);
  assert.equal(aliased.body.code, 'wrong_app');
  assert.equal((await page('pub', '/appapi/bravo/whoami', { token: 'not-a-real-token' })).body.code, 'invalid_token');
});

test('app tokens: own AppData only, cross-app rejected, kv per user and per app', async () => {
  const t = (await admin.post('apps/alpha/token', {})).body.token;
  const me = await page('base', '/appapi/alpha/whoami', { token: t });
  assert.equal(me.body.username, 'alex');
  assert.equal(me.body.displayName, 'alex');

  // Writes land in this person's AppData/alpha folder only.
  assert.equal((await page('base', '/appapi/alpha/fs/write?path=nested/data.txt', { method: 'PUT', token: t, body: 'app data' })).body.path, 'nested/data.txt');
  const got = await page('base', '/appapi/alpha/fs/read?path=nested/data.txt', { token: t });
  assert.equal(got.status, 200);
  assert.equal(got.body, 'app data');
  // The person's real drive files are invisible to the app.
  assert.equal((await page('base', '/appapi/alpha/fs/read?path=notes/secret.txt', { token: t })).status, 404);
  assert.equal((await page('base', '/appapi/alpha/fs/read?path=notes', { token: t })).status, 404);
  // Traversal out of the AppData folder is refused.
  assert.equal((await page('base', '/appapi/alpha/fs/readdir?path=..%2F..%2F', { token: t })).status, 400);
  // Someone else's app may not use my token; my token for another app cannot read alpha.
  assert.equal((await page('base', '/appapi/delta/whoami', { token: t })).body.code, 'wrong_app');
  const tDelta = (await admin.post('apps/delta/token', {})).body.token;
  assert.equal((await page('base', '/appapi/delta/fs/read?path=nested/data.txt', { token: tDelta })).status, 404);
  assert.equal((await page('base', '/appapi/delta/fs/readdir?path=..%2Falpha%2Fnested', { token: tDelta })).status, 400);

  // Key-value data is per app and per person.
  assert.equal((await page('base', '/appapi/alpha/kv/hi', { method: 'PUT', token: t, json: { value: 'a-hi' } })).body.ok, true);
  assert.equal((await page('base', '/appapi/delta/kv/hi', { method: 'PUT', token: tDelta, json: { value: 'd-hi' } })).body.ok, true);
  assert.equal((await page('base', '/appapi/alpha/kv/hi', { token: t })).body.value, 'a-hi');
  assert.equal((await page('base', '/appapi/delta/kv/hi', { token: tDelta })).body.value, 'd-hi');
  // Alex's delta token is not valid on the alpha endpoints: no cross-app aliasing.
  assert.equal((await page('base', '/appapi/alpha/kv/hi', { token: tDelta })).body.code, 'wrong_app');
  const samTok = (await sam.post('apps/alpha/token', {})).body.token;
  assert.equal((await page('base', '/appapi/alpha/kv/hi', { token: samTok })).body.value, null);
  assert.equal((await page('base', '/appapi/alpha/whoami', { token: samTok })).body.username, 'sam');
  assert.equal((await page('base', '/appapi/alpha/whoami', { token: 'not-a-real-token' })).status, 401);
});

test('grants are scoped, mode-checked and revocable', async () => {
  const up = await admin.call('PUT', 'fs/write?path=notes%2Fsecret.txt', { body: Buffer.from('top secret') });
  assert.equal(up.status, 200);
  const g = await admin.post('apps/alpha/grants', { paths: ['notes/secret.txt'], mode: 'view' });
  assert.equal(g.status, 200);
  const item = g.body.items[0];
  assert.match(item.path, /^~grant\/[A-Za-z0-9_-]+$/);
  const id = item.path.split('/')[1];

  const tok = (await admin.post('apps/alpha/token', {})).body.token;
  const read = await page('base', `/appapi/alpha/fs/read?path=${encodeURIComponent(`~grant/${id}`)}`, { token: tok });
  assert.equal(read.status, 200);
  assert.equal(read.body, 'top secret');
  // The granted item is a file, so listing it is a normal 404.
  assert.equal((await page('base', `/appapi/alpha/fs/readdir?path=${encodeURIComponent(`~grant/${id}`)}`, { token: tok })).status, 404);

  // A view grant blocks writing, and the app cannot climb past the grant.
  const w = await page('base', `/appapi/alpha/fs/write?path=${encodeURIComponent(`~grant/${id}`)}`, { method: 'PUT', token: tok, body: 'no' });
  assert.equal(w.status, 403);
  assert.equal(w.body.code, 'view_only');
  assert.equal((await page('base', `/appapi/alpha/fs/readdir?path=${encodeURIComponent(`~grant/${id}/..`)}`, { token: tok })).status, 400);
  assert.equal((await page('base', `/appapi/alpha/fs/read?path=${encodeURIComponent('~grant/deadbeef/x')}`, { token: tok })).status, 404);

  // Another person's app cannot use this grant, and revoking cuts access.
  const kim = await page('base', `/appapi/gamma/fs/read?path=${encodeURIComponent(`~grant/${id}`)}`, { token: gammaToken });
  assert.notEqual(kim.status, 200);
  const rev = await admin.del(`account/grants/${id}`, {});
  assert.equal(rev.status, 200);
  assert.equal((await page('base', `/appapi/alpha/fs/read?path=${encodeURIComponent(`~grant/${id}`)}`, { token: tok })).status, 404);
});

test('email: permission for people, own address only for public apps, rate limited', async () => {
  const tok = (await admin.post('apps/alpha/token', {})).body.token;
  const denied = await page('base', '/appapi/alpha/email/send', { method: 'POST', token: tok, json: { to: 'friend@example.com', subject: 'Hi' } });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'email_permission');
  const allow = await admin.post('apps/alpha/email-permission', {});
  assert.equal(allow.body.ok, true);
  const again = await admin.post('apps/alpha/email-permission', {});
  assert.equal(again.body.id, allow.body.id); // idempotent
  const ok = await page('base', '/appapi/alpha/email/send', { method: 'POST', token: tok, json: { to: 'friend@example.com', subject: 'Hi', text: 'hello' } });
  assert.equal(ok.status, 200);
  assert.equal(mail.sent.at(-1).subject, 'Hi');

  // Public: off by default, then only to the owner, then rate limited.
  const off = await page('pub', '/appapi/bravo/email/send', { method: 'POST', token: visitorToken, json: { to: 'friend@example.com' } });
  assert.equal(off.status, 403);
  assert.equal(off.body.code, 'public_email_off');
  const on = await admin.put('admin/apps/bravo', { publicEmail: true });
  assert.equal(on.body.publicEmail, true);
  const wrong = await page('pub', '/appapi/bravo/email/send', { method: 'POST', token: visitorToken, json: { to: 'friend@example.com' }, ip: '7.7.7.7' });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.code, 'wrong_recipient');
  const right = await page('pub', '/appapi/bravo/email/send', { method: 'POST', token: visitorToken, json: { to: 'ALEX@example.com' }, ip: '7.7.7.7' });
  assert.equal(right.status, 200);
  config.set('limits.public_email_per_hour', 1);
  try {
    const limited = await page('pub', '/appapi/bravo/email/send', { method: 'POST', token: visitorToken, json: { to: 'alex@example.com' }, ip: '7.7.7.7' });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.code, 'rate_limited');
  } finally {
    config.set('limits.public_email_per_hour', 5);
  }
});

test('public AI is off by default and rate limited once allowed', async () => {
  const off = await page('pub', '/appapi/bravo/ai/models', { token: visitorToken, ip: '8.8.8.8' });
  assert.equal(off.status, 403);
  assert.equal(off.body.code, 'public_ai_off');
  const chatOff = await page('pub', '/appapi/bravo/ai/chat', { method: 'POST', token: visitorToken, json: { messages: [{ role: 'user', content: 'hi' }] }, ip: '8.8.8.8' });
  assert.equal(chatOff.status, 403);
  assert.equal(chatOff.body.code, 'public_ai_off');
  // Signed-in app users keep normal access; the switch is only for anonymous visitors.
  const tok = (await admin.post('apps/bravo/token', {})).body.token;
  assert.equal((await page('base', '/appapi/bravo/ai/models', { token: tok })).status, 200);

  assert.equal((await admin.put('admin/apps/bravo', { publicAi: true })).body.publicAi, true);
  await admin.put('admin/server', { publicAiPerHour: 2 });
  assert.equal((await page('pub', '/appapi/bravo/ai/models', { token: visitorToken, ip: '8.8.8.8' })).status, 200);
  // Models (1) then chat (2): the next call for this IP is refused. A bad model
  // still counts: the rate limit exists to cap upstream traffic, not traffic that succeeds.
  const chat = await page('pub', '/appapi/bravo/ai/chat', { method: 'POST', token: visitorToken, json: { model: 'nope:none', messages: [{ role: 'user', content: 'hi' }] }, ip: '8.8.8.8' });
  assert.equal(chat.status, 200);
  assert.equal(chat.body.type, 'error'); // a bad model still streams an error frame
  const fourth = await page('pub', '/appapi/bravo/ai/chat', { method: 'POST', token: visitorToken, json: { messages: [{ role: 'user', content: 'hi' }] }, ip: '8.8.8.8' });
  assert.equal(fourth.status, 429);
  assert.equal(fourth.body.code, 'rate_limited');
  await admin.put('admin/server', { publicAiPerHour: 30 });
});

test('key-value space is capped per app and person', async () => {
  const tok = (await admin.post('apps/alpha/token', {})).body.token;
  const big = 'a'.repeat(255000);
  for (let i = 0; i < 8; i++) {
    const r = await page('base', `/appapi/alpha/kv/key${i}`, { method: 'PUT', token: tok, json: { value: big } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const r9 = await page('base', '/appapi/alpha/kv/key8', { method: 'PUT', token: tok, json: { value: big } });
  assert.equal(r9.status, 413);
  assert.equal(r9.body.code, 'too_large');
  await page('base', '/appapi/alpha/kv/flush', { method: 'POST', token: tok });
  const list = await page('base', '/appapi/alpha/kv/list', { token: tok });
  assert.deepEqual(list.body, []);
  // Oversized single values are refused as well.
  assert.equal((await page('base', '/appapi/alpha/kv/one', { method: 'PUT', token: tok, json: { value: 'x'.repeat(300000) } })).status, 413);
});

test('hosts only, own apps only', async () => {
  assert.deepEqual((await sam.get('admin/apps')).body, []);
  const plain = await sam.put('admin/apps/sammy/staging', {});
  assert.equal(plain.status, 403);
  assert.equal(plain.body.code, 'hosts_only');
  // Not signed in at all.
  const r = await fetch(`${running.base}/api/admin/apps`);
  assert.equal(r.status, 403); // missing the X-CAD-Request header first
  const bare = client(running.base);
  assert.equal((await bare.call('PUT', 'admin/apps/x/staging?path=a.txt', { body: Buffer.from('x') })).status, 401);

  // A host sees only their own apps and may not manage other people's.
  const kimList = (await kim.get('admin/apps')).body;
  assert.deepEqual(kimList.map((a) => a.name), ['gamma']);
  const steal = await kim.call('PUT', 'admin/apps/alpha/staging?path=index.html', { body: Buffer.from('<h1>evil</h1>') });
  assert.equal(steal.status, 403);
  assert.equal(steal.body.code, 'not_yours');
  const peek = await kim.get('admin/apps/alpha');
  assert.equal(peek.status, 403);

  // The owner sees grants and can set env, which comes back masked and stays so.
  const info = await kim.get('admin/apps/gamma');
  assert.equal(info.status, 200);
  assert.deepEqual(info.body.env, []);
  const env = await kim.put('admin/apps/gamma', { env: { apiKey: 'sk-deadbeef' } });
  assert.equal(env.status, 200);
  const again = await kim.get('admin/apps/gamma');
  assert.deepEqual(again.body.env, [{ key: 'apiKey', value: '••••' }]);
  await kim.put('admin/apps/gamma', { env: { apiKey: '••••ef' } });
  assert.equal(db.get("SELECT value FROM app_env WHERE app = 'gamma' AND key = 'apiKey'").value, 'sk-deadbeef');
  const badKey = await kim.put('admin/apps/gamma', { env: { '9lives': 'x' } });
  assert.equal(badKey.status, 400);
});

test('staging can be cleared; an app can be deleted for good', async () => {
  const tok = gammaToken;
  assert.equal((await page('base', '/appapi/gamma/whoami', { token: tok })).body.username, 'kim');
  assert.equal((await kim.del('admin/apps/gamma/staging', {})).body.ok, true);
  // Publish with nothing staged now fails; the app keeps running.
  assert.equal((await kim.post('admin/apps/gamma/publish', {})).status, 400);
  assert.equal(await fs.existsSync(`${paths.DATA_DIR}/apps/gamma/site/index.html`), true);
  assert.equal((await kim.call('GET', '/app-content/gamma/')).body, '<h1>gamma</h1>');

  const gone = await kim.del('admin/apps/gamma', {});
  assert.equal(gone.body.ok, true);
  assert.equal((await fetch(`${running.base}/apps/gamma/`)).status, 404);
  assert.equal((await kim.call('GET', '/app-content/gamma/')).status, 404);
  assert.equal((await page('base', '/appapi/gamma/whoami', { token: tok })).status, 404); // its token is dead
  assert.equal(await fs.existsSync(`${paths.DATA_DIR}/apps/gamma`), false);
  assert.equal(await fs.existsSync(`${paths.DATA_DIR}/apps/gamma/.staging`), false);
});

test('/fn needs both an app name and a function name, on both listeners', async () => {
  for (const kind of ['base', 'pub']) {
    const r = await page(kind, '/fn/do');
    assert.equal(r.status, 404);
  }
});
