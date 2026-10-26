/**
 * The LAN peer relay: invites, pairing, both message directions, closes, and
 * the events channel that wakes another signed-in tab. The browser shim's
 * WebRTC half is exercised separately (it needs a real Chromium); this covers
 * the server contract every app ultimately talks to.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { start, cleanup, client } from './helpers.js';
import * as hub from '../lib/hub.js';
import * as store from '../lib/store.js';

const FIXTURE = 'test/fixtures/hub/fixture-dist';
let running;
let ana;
let ben;

function peerSocket(who, path = '/api/hub/peer', app = 'alpha', extra = '') {
  const ws = new WebSocket(`ws://127.0.0.1:${running.privatePort}${path}?app=${app}${extra}`, {
    headers: { Cookie: who ? who.cookie : '', Origin: running.base },
  });
  const inbox = [];
  const waiters = [];
  const messages = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    messages.push(msg);
    for (const waiter of [...waiters]) {
      if (!waiter.test(msg)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(msg);
      return;
    }
    inbox.push(msg);
  });
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`upgrade ${res.statusCode}`)));
    ws.once('error', reject);
  });
  opened.catch(() => {});
  return {
    ws,
    messages,
    open: () => opened,
    seen: (type, where = (m) => m.type === type) => messages.filter(where),
    send: (msg) => ws.send(JSON.stringify(msg)),
    wait(type, predicate = () => true, ms = 4_000) {
      const at = inbox.findIndex((m) => m.type === type && predicate(m));
      if (at >= 0) return Promise.resolve(inbox.splice(at, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = {
          test: (m) => m.type === type && predicate(m),
          resolve,
        };
        const timer = setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error(`timed out waiting for ${type}; saw ${JSON.stringify(messages)}`));
        }, ms);
        const done = waiter.resolve;
        waiter.resolve = (msg) => {
          clearTimeout(timer);
          done(msg);
        };
        waiters.push(waiter);
      });
    },
  };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  running = await start();
  store.addUser('peer-ana', 'peer-ana-password');
  store.addUser('peer-ben', 'peer-ben-password');
  hub.installFromDist('alpha', FIXTURE, { sha: 'a'.repeat(40), source: 'import', title: 'Alpha' });
  hub.installFromDist('beta', FIXTURE, { sha: 'b'.repeat(40), source: 'import', title: 'Beta' });
  ana = client(running.base);
  ben = client(running.base);
  await ana.login('peer-ana', 'peer-ana-password');
  await ben.login('peer-ben', 'peer-ben-password');
});

after(() => cleanup(running));

test('peer relay pairs two sessions and carries both directions', async () => {
  const host = peerSocket(ana);
  await host.open();
  host.send({ type: 'serve' });
  const served = await host.wait('served');
  assert.match(served.inviteCode, /^[A-Z0-9]{8}$/);

  const guest = peerSocket(ben);
  await guest.open();
  const connected = host.wait('connection');
  guest.send({ type: 'join', code: served.inviteCode });
  const joined = await guest.wait('joined');
  const connection = await connected;
  assert.equal(joined.code, served.inviteCode);
  assert.equal(joined.host.username, 'peer-ana');
  assert.equal(connection.user.username, 'peer-ben');
  assert.equal(connection.connId, joined.connId);

  guest.send({ type: 'relay', data: 'from-guest' });
  const hostHeard = await host.wait('relay');
  assert.equal(hostHeard.connId, joined.connId);
  assert.equal(hostHeard.data, 'from-guest');

  host.send({ type: 'relay', connId: joined.connId, data: { move: 'e4' } });
  const guestHeard = await guest.wait('relay');
  assert.deepEqual(guestHeard.data, { move: 'e4' });

  host.send({ type: 'close-conn', connId: joined.connId, reason: 'good game' });
  const closed = await guest.wait('conn-closed');
  assert.equal(closed.reason, 'good game');

  // The invite stays open for the next opponent.
  const guest2 = peerSocket(ben);
  await guest2.open();
  guest2.send({ type: 'join', code: served.inviteCode.toLowerCase() });
  const joined2 = await guest2.wait('joined');
  assert.equal(joined2.code, served.inviteCode);
  guest2.ws.close();
  host.ws.close();
});

test('peer refuses unknown invites, other apps, and signed-out sockets', async () => {
  const host = peerSocket(ana);
  await host.open();
  host.send({ type: 'serve' });
  const served = await host.wait('served');

  const stranger = peerSocket(ben);
  await stranger.open();
  stranger.send({ type: 'join', code: 'ZZZZZZZZ' });
  const refused = await stranger.wait('join-error');
  assert.equal(refused.code, 'invalid_invite');
  assert.match(refused.message, /invalid invite/i);

  // An invite is scoped to the app that minted it, even when another app is
  // installed for the same person.
  const wrongApp = peerSocket(ben, '/api/hub/peer', 'beta');
  await wrongApp.open();
  wrongApp.send({ type: 'join', code: served.inviteCode });
  const wrong = await wrongApp.wait('join-error');
  assert.equal(wrong.code, 'invalid_invite');

  const signedOut = peerSocket(null);
  await assert.rejects(signedOut.open(), /upgrade 403/);

  host.ws.close();
  await delay(50);

  // Once the host socket is gone its code is dead.
  const afterClose = peerSocket(ben);
  await afterClose.open();
  afterClose.send({ type: 'join', code: served.inviteCode });
  const gone = await afterClose.wait('join-error');
  assert.equal(gone.code, 'invalid_invite');
});

test('a host grant lets a signed-out guest join that host’s invite only', async () => {
  const host = peerSocket(ana);
  await host.open();
  host.send({ type: 'serve' });
  const served = await host.wait('served');

  const granted = await ana.post('hub/peer/grant', { app: 'alpha' });
  assert.equal(granted.status, 200);
  assert.match(granted.body.grant, /^pg1\./);
  assert.ok(granted.body.expiresAt > Math.floor(Date.now() / 1000));
  const token = granted.body.grant;

  const guest = peerSocket(null, '/api/hub/peer', 'alpha', `&grant=${encodeURIComponent(token)}`);
  await guest.open();
  // A bearer grant is only a join ticket, never an account.
  guest.send({ type: 'serve' });
  const notHost = await guest.wait('error');
  assert.equal(notHost.code, 'not_signed_in');

  guest.send({ type: 'join', code: served.inviteCode });
  const joined = await guest.wait('joined');
  assert.equal(joined.host.username, 'peer-ana');
  const connection = await host.wait('connection');
  assert.equal(connection.user.username, 'Guest');
  assert.match(connection.user.uuid, /\S/);

  guest.send({ type: 'relay', data: 'hello from a guest' });
  const relayed = await host.wait('relay');
  assert.equal(relayed.data, 'hello from a guest');

  // The same token may not join a different host’s invite.
  const otherHost = peerSocket(ben);
  await otherHost.open();
  otherHost.send({ type: 'serve' });
  const otherInvite = await otherHost.wait('served');
  const outsider = peerSocket(null, '/api/hub/peer', 'alpha', `&grant=${encodeURIComponent(token)}`);
  await outsider.open();
  outsider.send({ type: 'join', code: otherInvite.inviteCode });
  const refused = await outsider.wait('join-error');
  assert.equal(refused.message, 'That grant is for a different host.');

  guest.ws.close();
  outsider.ws.close();
  otherHost.ws.close();
  host.ws.close();
});

test('events deliver this person’s kv/fs changes and nothing from another person', async () => {
  const events = peerSocket(ana, '/api/hub/events');
  await events.open();
  events.send({ type: 'sub', id: 'kv-room', subject: 'kv:room', includeValue: true });
  const kvSub = await events.wait('sub-ok');
  assert.equal(kvSub.match, 'exact');
  assert.equal(kvSub.includeValue, true);

  events.send({ type: 'sub', id: 'fs-notes', subject: 'fs:notes' });
  const fsSub = await events.wait('sub-ok');
  assert.equal(fsSub.match, 'prefix');

  // The same person's other app may not watch this app's private sandbox.
  const betaEvents = peerSocket(ana, '/api/hub/events', 'beta');
  await betaEvents.open();
  betaEvents.send({ type: 'sub', id: 'beta-notes', subject: 'fs:notes' });
  await betaEvents.wait('sub-ok');

  // Another person's write to the same app/key is not ours to hear.
  await ben.post('hub/kv/set', { app: 'alpha', key: 'room', value: { by: 'ben' } });
  await delay(250);
  assert.equal(events.seen('event').length, 0);

  // A write from another session of the same person wakes this one.
  const wrote = await ana.post('hub/kv/set', { app: 'alpha', key: 'room', value: { by: 'ana', n: 4 } });
  assert.equal(wrote.status, 200);
  const kvEvent = await events.wait('event', (m) => m.id === 'kv-room');
  assert.equal(kvEvent.event.op, 'set');
  assert.deepEqual(kvEvent.event.value, { by: 'ana', n: 4 });

  const put = await ana.call('PUT', 'hub/fs/write?app=alpha&path=notes/a.txt', { body: 'hello' });
  assert.equal(put.status, 200);
  const fsEvent = await events.wait('event', (m) => m.id === 'fs-notes');
  assert.equal(fsEvent.event.path, 'notes/a.txt');
  assert.equal(fsEvent.event.op, 'set');
  await delay(250);
  assert.equal(betaEvents.seen('event').length, 0);

  // A flush is a gap for the whole app namespace, delivered to every KV
  // subscription, not only to a literal "*" one.
  const flushed = await ana.post('hub/kv/flush', { app: 'alpha' });
  assert.equal(flushed.status, 200);
  const gap = await events.wait('event', (m) => m.id === 'kv-room' && m.event.op === 'gap');
  assert.equal(gap.event.reason, 'flush');

  betaEvents.ws.close();
  events.ws.close();
});
