import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { start, cleanup, client } from './helpers.js';

let running, store, cadfile, config;
const c = {};
before(async () => {
  running = await start();
  store = await import('../lib/store.js');
  cadfile = await import('../lib/cadfile.js');
  config = await import('../lib/config.js');
  for (const n of ['alex', 'sam', 'kim']) {
    store.addUser(n, `${n}-password`);
    c[n] = client(running.base);
    await c[n].login(n, `${n}-password`);
  }
  const bytes = cadfile.encode({ version: 1, header: {}, layers: [{ name: '0' }], entities: [{ id: 1, type: 'point', x: 0, y: 0 }] });
  await c.alex.call('PUT', 'fs/write?path=Projects/plan.cad', { body: bytes });
  await c.alex.call('PUT', 'fs/write?path=Projects/notes.txt', { body: 'notes' });
  await c.alex.call('PUT', 'fs/write?path=Private/secret.txt', { body: 'secret' });
});
after(() => cleanup(running));

test('folder shares cover the subtree and enforce view/edit', async () => {
  assert.equal((await c.sam.get('fs/read?path=/@alex/Projects/notes.txt')).status, 404);
  assert.equal((await c.alex.post('share/people', { path: 'Projects', user: 'sam', mode: 'view' })).status, 200);
  assert.equal((await c.alex.post('share/people', { path: '/Projects/plan.cad', user: 'kim', mode: 'edit' })).status, 200);
  assert.equal((await c.sam.get('fs/read?path=/@alex/Projects/notes.txt')).body, 'notes');
  assert.equal((await c.sam.get('fs/read?path=/@alex/Private/secret.txt')).status, 404);
  assert.equal((await c.sam.get('fs/read?path=/@alex/Projects/../Private/secret.txt')).status, 400);
  assert.equal((await c.sam.call('PUT', 'fs/write?path=/@alex/Projects/new.txt', { body: 'x' })).status, 403);
  const list = await c.sam.get('fs/readdir?path=/@alex/Projects');
  assert.deepEqual(list.body.items.map((i) => i.name).sort(), ['notes.txt', 'plan.cad']);
  assert.ok(list.body.items.every((i) => i.path.startsWith('/@alex/Projects/') && i.mode === 'view'));
  // Edit on a folder: write and delete inside, but not the shared folder itself.
  await c.alex.post('share/people', { path: 'Projects', user: 'sam', mode: 'edit' });
  assert.equal((await c.sam.call('PUT', 'fs/write?path=/@alex/Projects/new.txt', { body: 'x' })).status, 200);
  assert.equal((await c.sam.del('fs/delete?path=/@alex/Projects/new.txt')).status, 200);
  assert.equal((await c.sam.del('fs/delete?path=/@alex/Projects&recursive=1')).status, 403);
  // Only the owner shares with people.
  assert.equal((await c.sam.post('share/people', { path: '/@alex/Projects/plan.cad', user: 'kim', mode: 'edit' })).status, 403);
  const incoming = (await c.kim.get('share/incoming')).body;
  assert.deepEqual(incoming.map((i) => [i.path, i.mode]), [['/@alex/Projects/plan.cad', 'edit']]);
  const dir = (await c.kim.get('users/directory')).body.map((u) => u.username);
  assert.deepEqual(dir, ['alex', 'sam']);
  const info = (await c.sam.get('share/list?path=/@alex/Projects/plan.cad')).body;
  assert.equal(info.canManagePeople, false);
  assert.equal(info.isCad, true);
});

test('links: public listener only, expiry, revoke closes sockets', async () => {
  const noUrl = await c.alex.post('share/links', { path: 'Projects/plan.cad', mode: 'view' });
  assert.equal(noUrl.status, 200);
  assert.equal(noUrl.body.url, null);
  config.set('public_url', `http://127.0.0.1:${running.publicPort}`);
  assert.equal((await c.alex.post('share/links', { path: 'Projects/notes.txt', mode: 'view' })).status, 400);
  const link = (await c.alex.post('share/links', { path: 'Projects/plan.cad', mode: 'edit', expiresDays: 7 })).body;
  assert.match(link.url, /\/s\/[A-Za-z0-9_-]{32}\/$/);
  const token = link.token;
  // The private listener does not serve links.
  assert.equal((await fetch(`${running.base}/s/${token}/api/share`)).status, 404);
  const pub = await fetch(`${running.pub}/s/${token}/api/share`);
  assert.deepEqual(await pub.json(), { name: 'plan.cad', mode: 'edit', ownerName: 'alex' });
  const page = await fetch(`${running.pub}/s/${token}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /html/);
  assert.equal((await fetch(`${running.pub}/s/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/`)).status, 404);

  // A guest joins live over the public listener.
  const ws = new WebSocket(`ws://127.0.0.1:${running.publicPort}/s/${token}/api/live`);
  const msgs = [];
  ws.on('message', (m) => msgs.push(JSON.parse(m)));
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ t: 'hello', name: 'Pat', color: '#123456', client: 'g' }));
  const until = async (fn) => {
    for (let i = 0; i < 300 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(fn());
  };
  await until(() => msgs.some((m) => m.t === 'welcome'));
  const welcome = msgs.find((m) => m.t === 'welcome');
  assert.equal(welcome.you.name, 'Pat (guest)');
  assert.equal(welcome.you.mode, 'edit');
  assert.equal(welcome.snapshot.entities.length, 1);
  // Revoke: the socket gets closed.
  const closed = new Promise((r) => ws.on('close', r));
  assert.equal((await c.alex.del(`share/links/${token}`)).status, 200);
  await closed;
  assert.ok(msgs.some((m) => m.t === 'closed' && m.reason === 'revoked'));
  const gone = await fetch(`${running.pub}/s/${token}/`);
  assert.equal(gone.status, 404);
  assert.match(await gone.text(), /no longer available/);

  // Expired links stop working.
  const db = await import('../lib/db.js');
  const l2 = (await c.alex.post('share/links', { path: 'Projects/plan.cad', mode: 'view', expiresDays: 1 })).body;
  db.run('UPDATE links SET expires = ? WHERE token = ?', Date.now() - 1, l2.token);
  assert.equal((await fetch(`${running.pub}/s/${l2.token}/api/share`)).status, 404);
});

test('deleting a shared file removes its shares and links', async () => {
  await c.alex.post('share/links', { path: 'Projects/plan.cad', mode: 'view' });
  assert.equal((await c.alex.del('fs/delete?path=Projects/plan.cad')).status, 200);
  assert.deepEqual((await c.kim.get('share/incoming')).body, []);
  const mine = (await c.alex.get('share/mine')).body;
  assert.ok(mine.links.every((l) => l.path !== '/Projects/plan.cad'));
});
