/** §23 publicBaseUrl: the admin-set guest address flows through the
 * workers guest-base surface with the honest reachability note, and bad
 * values are rejected. */
import test from 'node:test';
import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, cleanup, client } from './helpers.js';
import * as store from '../lib/store.js';

let running;
let adminC;

before(async () => {
  running = await start();
  store.addUser('boss', 'boss-password', { admin: true });
  adminC = client(running.base);
  await adminC.login('boss', 'boss-password');
});
after(() => cleanup(running));

test('unset: the route answers with the honest LAN-only note', async () => {
  const r = await adminC.get('hub/workers/guest-base');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.base, '');
  assert.match(r.body.note, /LAN-only/, JSON.stringify(r.body.note));
  assert.match(r.body.note, /loopback-only/i);
});

test('set via Admin → Hub: guest links name a full address, trailing slashes trimmed', async () => {
  const put = await adminC.put('admin/server', { workersPublicBaseUrl: 'http://192.168.1.4:18100/' });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const r = await adminC.get('hub/workers/guest-base');
  assert.equal(r.body.base, 'http://192.168.1.4:18100');
  assert.match(r.body.note, /Guest links use this address/);
});

test('invalid guest address is rejected with the standard URL message', async () => {
  const put = await adminC.put('admin/server', { workersPublicBaseUrl: 'not-a-url' });
  assert.equal(put.status, 400, JSON.stringify(put.body));
  const r = await adminC.get('hub/workers/guest-base');
  assert.equal(r.body.base, 'http://192.168.1.4:18100', 'a bad write must not clobber the good value');
});

test('clearing the value returns to the honest note', async () => {
  const put = await adminC.put('admin/server', { workersPublicBaseUrl: '' });
  assert.equal(put.status, 200);
  const r = await adminC.get('hub/workers/guest-base');
  assert.equal(r.body.base, '');
  assert.match(r.body.note, /LAN-only/);
});
