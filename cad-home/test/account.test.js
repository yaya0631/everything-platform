import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, cleanup, client } from './helpers.js';

let running, store, mail, config;
before(async () => {
  running = await start();
  store = await import('../lib/store.js');
  mail = await import('../lib/mail.js');
  config = await import('../lib/config.js');
  store.addUser('alex', 'alex-password', { email: 'alex@example.com' });
  store.addUser('sam', 'sam-password', { email: 'sam@example.com' });
});
after(() => cleanup(running));

const tokenFrom = (msg, kind) => new RegExp(`#/${kind}/([A-Za-z0-9_-]+)`).exec(msg.text)[1];

test('auth/me has profile fields; account updates', async () => {
  const c = client(running.base);
  await c.login('alex', 'alex-password');
  const me = (await c.get('auth/me')).body;
  assert.deepEqual(Object.keys(me).sort(), ['canHostApps', 'color', 'displayName', 'email', 'isAdmin', 'username']);
  assert.equal(me.isAdmin, true);
  const r = await c.put('account', { displayName: 'Alex K', color: '#112233', notifyShares: false });
  assert.equal(r.body.displayName, 'Alex K');
  assert.equal((await c.put('account', { color: 'red' })).status, 400);
  assert.equal((await c.get('auth/me')).body.color, '#112233');
});

test('password change signs out other devices but keeps this one', async () => {
  const a = client(running.base);
  const b = client(running.base);
  await a.login('sam', 'sam-password');
  await b.login('sam', 'sam-password');
  assert.equal((await a.get('account/sessions')).body.length, 2);
  const wrong = await a.post('account/password', { current: 'nope', next: 'new-password' });
  assert.equal(wrong.status, 403);
  const ok = await a.post('account/password', { current: 'sam-password', next: 'sam-password-2' });
  assert.equal(ok.status, 200);
  assert.equal((await a.get('auth/me')).status, 200);
  assert.equal((await b.get('auth/me')).status, 401);
});

test('admin API is for admins only; email setup, test, invite and reset', async () => {
  const sam = client(running.base);
  await sam.login('sam', 'sam-password-2');
  assert.equal((await sam.get('admin/users')).status, 403);
  const admin = client(running.base);
  await admin.login('alex', 'alex-password');
  // Not set up yet.
  const noMail = await admin.post('admin/users', { username: 'kim', email: 'kim@example.com', invite: true });
  assert.equal(noMail.status, 503);
  const set = await admin.put('admin/email', { host: 'json', port: 587, user: 'cad@example.com', pass: 'secret-pass', from: 'CAD Home <cad@example.com>' });
  assert.equal(set.status, 200);
  assert.equal(set.body.pass, '••••pass');
  assert.equal(set.body.configured, true);
  // Saving with the masked value keeps the secret.
  await admin.put('admin/email', { ...set.body, pass: set.body.pass });
  assert.equal(config.get('smtp').pass, 'secret-pass');
  assert.equal((await admin.post('admin/email/test', { to: 'alex@example.com' })).status, 200);
  assert.equal(mail.sent.at(-1).subject, 'CAD Home test email');

  const inv = await admin.post('admin/users', { username: 'kim', email: 'kim@example.com', invite: true });
  assert.equal(inv.status, 200, JSON.stringify(inv.body));
  assert.equal(inv.body.invited, true);
  const invite = mail.sent.at(-1);
  assert.deepEqual(invite.to.map((t) => t.address), ['kim@example.com']);
  const token = tokenFrom(invite, 'invite');
  const info = await client(running.base).get(`auth/token-info?kind=invite&token=${token}`);
  assert.equal(info.body.username, 'kim');
  const kim = client(running.base);
  const accepted = await kim.post('auth/accept-invite', { token, password: 'kim-password' });
  assert.equal(accepted.status, 200);
  assert.equal((await kim.get('auth/me')).body.username, 'kim');
  assert.equal((await kim.post('auth/accept-invite', { token, password: 'again-password' })).status, 404);

  // Forgot password always answers ok; a reset email arrives for real accounts.
  const before = mail.sent.length;
  assert.equal((await client(running.base).post('auth/forgot', { username: 'nobody' })).body.ok, true);
  assert.equal(mail.sent.length, before);
  await client(running.base).post('auth/forgot', { username: 'kim' });
  const reset = tokenFrom(mail.sent.at(-1), 'reset');
  assert.equal((await client(running.base).post('auth/reset', { token: reset, password: 'kim-password-2' })).status, 200);
  assert.equal((await kim.get('auth/me')).status, 401);
  await kim.login('kim', 'kim-password-2');

  // Flags, audit and the email log.
  const up = await admin.put('admin/users/kim', { canHostApps: true, displayName: 'Kim' });
  assert.equal(up.body.canHostApps, true);
  const audit = (await admin.get('admin/audit')).body;
  assert.ok(audit.some((a) => a.action === 'user.updated'));
  const log = (await admin.get('admin/email/log')).body;
  assert.ok(log.length >= 3);
  assert.ok(log.every((l) => !('text' in l) && !('html' in l)));
  const ov = (await admin.get('admin/overview')).body;
  assert.equal(ov.accounts, 3);
  assert.ok(Array.isArray(ov.rooms));

  // Server settings validate addresses.
  assert.equal((await admin.put('admin/server', { publicUrl: 'not a url' })).status, 400);
  assert.equal((await admin.put('admin/server', { publicUrl: 'https://pc.example.ts.net:8443/' })).status, 200);
  assert.equal(config.publicUrl(), 'https://pc.example.ts.net:8443');
  await admin.put('admin/server', { publicUrl: '' });

  // Delete keeps the last admin.
  assert.equal((await admin.del('admin/users/alex', {})).status, 400);
  assert.equal((await admin.del('admin/users/kim', { deleteFiles: true })).status, 200);
  assert.equal((await kim.get('auth/me')).status, 401);
});

test('panel pages are private and have a strict CSP', async () => {
  const r = await fetch(`${running.base}/admin/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await fetch(`${running.base}/panel/tokens.css`)).status, 200);
  assert.equal((await fetch(`${running.pub}/admin/`)).status, 404);
  assert.equal((await fetch(`${running.pub}/account/`)).status, 404);
});
