import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA, start, cleanup, client } from './helpers.js';

// Data from the JSON-file version, written before the database is opened.
const oldHash = (await import('../lib/store.js')).hashPassword; // importing opens nothing yet
void oldHash;

let running;
after(() => cleanup(running));

test('imports the old JSON files and keeps sessions working', async () => {
  // Write old-format files into a separate data folder layout first.
  const store = await import('../lib/store.js');
  const db = await import('../lib/db.js');
  db.close();
  fs.rmSync(path.join(DATA, 'cad.db'), { force: true });
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  fs.writeFileSync(path.join(DATA, 'users.json'), JSON.stringify({ users: { old: { hash: store.hashPassword('oldpassword'), stamp: 's1', created: '2024-01-01T00:00:00.000Z' } } }));
  fs.writeFileSync(path.join(DATA, 'sessions.json'), JSON.stringify({ [tokenHash]: { user: 'old', stamp: 's1', expires: Date.now() + 1e9 }, gone: { user: 'nobody', stamp: 'x', expires: Date.now() + 1e9 } }));
  fs.mkdirSync(path.join(DATA, 'kv'));
  fs.writeFileSync(path.join(DATA, 'kv', 'old.json'), JSON.stringify({ 'settings.theme': 'dark' }));

  db.open();
  assert.ok(fs.existsSync(path.join(DATA, 'users.json.migrated')));
  assert.ok(fs.existsSync(path.join(DATA, 'sessions.json.migrated')));
  assert.ok(fs.existsSync(path.join(DATA, 'kv', 'old.json.migrated')));
  assert.equal(store.sessionUser(token), 'old');
  assert.equal(store.kvGet('user:old', 'settings.theme'), 'dark');
  assert.equal(store.checkLogin('OLD', 'oldpassword'), 'old');
  assert.equal(db.get('PRAGMA user_version').user_version >= 1, true);

  running = await start();
  const c = client(running.base);
  c.cookie = `cad_session=${token}`;
  const me = await c.get('auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.username, 'old');
  const kv = await c.get('kv/settings.theme');
  assert.equal(kv.body.value, 'dark');
});

test('first added account becomes admin; stamp change signs out', async () => {
  const store = await import('../lib/store.js');
  // "old" was imported without admin; with no admin yet, the next add becomes admin.
  const r = store.addUser('alex', 'password1');
  assert.equal(r.admin, true);
  assert.equal(store.addUser('sam', 'password2', { email: 'sam@example.com' }).admin, false);
  const c = client(running.base);
  const me = await c.login('alex', 'password1');
  assert.equal(me.isAdmin, true);
  assert.equal((await c.get('auth/me')).body.username, 'alex');
  store.setPassword('alex', 'password3');
  assert.equal((await c.get('auth/me')).status, 401);
  await c.login('alex', 'password3');
  assert.equal((await c.get('auth/me')).status, 200);
  store.updateUser('sam', { disabled: true });
  assert.equal(store.checkLogin('sam', 'password2'), null);
  assert.throws(() => store.updateUser('alex', { isAdmin: false }), /only admin/);
});

test('requests need the CAD header; fs routes keep their shapes', async () => {
  const c = client(running.base);
  await c.login('alex', 'password3');
  const noHeader = await fetch(`${running.base}/api/auth/me`, { headers: { Cookie: c.cookie } });
  assert.equal(noHeader.status, 403);
  const w = await c.call('PUT', 'fs/write?path=Drawings/a.cad', { body: 'hello' });
  assert.equal(w.status, 200);
  assert.equal(w.body.path, '/Drawings/a.cad');
  const list = await c.get('fs/readdir?path=Drawings');
  assert.deepEqual(list.body.items.map((i) => i.name), ['a.cad']);
  const read = await c.get('fs/read?path=/alex/Drawings/a.cad');
  assert.equal(read.body, 'hello');
  const again = await c.call('PUT', 'fs/write?path=Drawings/a.cad&overwrite=0', { body: 'x' });
  assert.equal(again.status, 409);
  for (const bad of ['../x', 'Drawings/../../x', 'Drawings/con.txt', 'Drawings/a:b', 'Drawings/x.', 'Drawings/NUL']) {
    const r = await c.call('PUT', `fs/write?path=${encodeURIComponent(bad)}`, { body: 'x' });
    assert.equal(r.status, 400, bad);
  }
  assert.equal((await c.del('fs/delete?path=Drawings/a.cad')).status, 200);
  assert.equal((await c.get('fs/read?path=Drawings/a.cad')).status, 404);
});

test('public listener serves nothing private and ignores cookies', async () => {
  const c = client(running.base);
  await c.login('alex', 'password3');
  for (const p of ['/', '/api/auth/me', '/admin/', '/account/']) {
    const r = await fetch(`${running.pub}${p}`, { headers: { Cookie: c.cookie, 'X-CAD-Request': '1' } });
    assert.equal(r.status, 404, p);
  }
});

test('m3: the session cookie is Secure exactly when the request is HTTPS', async () => {
  const login = (headers = {}) => fetch(`${running.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'X-CAD-Request': '1', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ username: 'alex', password: 'password3' }),
  });
  const plain = await login();
  const plainCookie = plain.headers.get('set-cookie') || '';
  assert.match(plainCookie, /HttpOnly/);
  assert.match(plainCookie, /SameSite=Strict/);
  // A Secure cookie would never be sent back over plain HTTP, so a LAN box
  // without TLS correctly gets none.
  assert.doesNotMatch(plainCookie, /; Secure/);
  // Behind a TLS-terminating proxy (and on direct TLS) the flag is set.
  const proxied = await login({ 'X-Forwarded-Proto': 'https' });
  assert.match(proxied.headers.get('set-cookie') || '', /; Secure/);
});

test('rate limiter', async () => {
  const { rateLimit } = await import('../lib/http.js');
  for (let i = 0; i < 3; i++) assert.equal(rateLimit('t', 3, 1000), true);
  assert.equal(rateLimit('t', 3, 1000), false);
});
