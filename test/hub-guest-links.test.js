/** Guest links, the POSITIVE flow (§9/§23): a member deploys a worker, the
 * admin turns the §18 toggle on, approves it, and an unauthenticated visitor
 * on the PUBLIC listener serves it at /w/<user>/<name>/... — the worker sees
 * its own path (never the /w/.. wrapper), gets no session, no fs, no email,
 * and the public listener rate-caps the address (§17). The negative cases —
 * toggle off, never public by default — live in hub-workers.test.js; this
 * file proves the full gated flow once the admin allows it, plus the
 * per-address cap and the 404 shapes (absent vs private stay identical). */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, cleanup, client, DATA } from './helpers.js';
import * as hub from '../lib/hub.js';
import * as store from '../lib/store.js';
import * as config from '../lib/config.js';
import * as hubWorkers from '../lib/hub-workers.js';

const FIXTURE = 'test/fixtures/hub/fixture-dist';
const SHA40 = (c) => c.repeat(40);

let running;
let hostC;
let pubBase = '';
const port = () => running.publicPort;

/** One-shot GET over the public listener (node:http closes right after each
 * response — undici's keep-alive pool would pin the file process at exit). */
const pub = (p, headers = {}) => new Promise((resolve, reject) => {
  const req = http.get({ port: port(), path: p, headers, agent: false }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: () => Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject);
});

const PROBE = `
router.get('/ping', function () {
  return new Response('link pong', { status: 200, headers: { 'Content-Type': 'text/plain' } });
});
router.get('/who', async function (ctx) {
  const u = new URL(ctx.request.url);
  return new Response(JSON.stringify({
    path: u.pathname,
    search: u.search,
    origin: u.origin,
    workerBase: ctx.request.workerBase,
    host: ctx.request.headers.host,
    forwardedHost: ctx.request.headers['x-forwarded-host'],
    originalHost: ctx.request.headers['x-original-host'],
    guest: !(ctx.user || ctx.requestor),
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
router.get('/fs-try', async function (ctx) {
  try { await ctx.me.puter.fs.write('x', 'y'); return new Response('fs-yes'); }
  catch (e) { return new Response('fs-no', { status: 503 }); }
});
`;

before(async () => {
  running = await start();
  pubBase = `http://127.0.0.1:${running.publicPort}`;
  store.addUser('person1', 'person1-password');
  hub.installFromDist('alpha', FIXTURE, { sha: SHA40('a'), source: 'import', title: 'Alpha' });
  config.set('workers.timeout_ms', 12000);
  hostC = client(running.base);
  await hostC.login('person1', 'person1-password');
  const wr = await hostC.call('PUT', 'hub/fs/write?app=alpha&path=workers/ping.js&options=' + encodeURIComponent('{}'), { body: PROBE, raw: true });
  assert.equal(wr.status, 200, JSON.stringify(wr.body));
  const created = await hostC.post('hub/workers', { app: 'alpha', name: 'ping-1', filePath: 'workers/ping.js' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
});

after(() => cleanup(running));

test('unauthenticated /w/ serving is 404 until the admin both toggles and approves', async () => {
  const off = await pub('/w/person1/ping-1/ping');
  assert.equal(off.status, 404, 'toggle off → identical 404 shape');
  config.set('workers.allow_public_user_workers', true);
  const unapproved = await pub('/w/person1/ping-1/ping');
  assert.equal(unapproved.status, 404, 'toggle on but not approved → the same 404 (nothing leaks)');
  const unknown = await pub('/w/person1/ghost/ping');
  assert.equal(unknown.status, 404, 'unknown address and private address look identical');
});

test('approved member worker serves at /w/ to an anonymous visitor, path-local', async () => {
  const row = hubWorkers.approvePublic({ user: 'person1', app: null }, 'ping-1', true);
  // §23 + §26 boundary: the server keeps its internal relative route; the
  // canonical https://<label>.puter.work alias is applied by the shim, not by
  // the server's own worker API (worker-alias.test.js covers that boundary).
  assert.equal(row.url, '/wr/person1/ping-1/', JSON.stringify(row));
  assert.equal(row.public, true, 'the row is publicly serving');
  const r = await pub('/w/person1/ping-1/ping');
  assert.equal(r.status, 200, `guest serves: ${r.text()}`);
  assert.equal(r.text(), 'link pong');
});

test('the worker sees its OWN path; the guest context has no caller and no fs', async () => {
  const who = await pub('/w/person1/ping-1/who');
  assert.equal(who.status, 200);
  const body = JSON.parse(await who.text());
  assert.equal(body.path, '/who', `base /w/person1/ping-1 is stripped: ${JSON.stringify(body)}`);
  assert.equal(body.search, '', 'no query in the path-only request');
  assert.equal(body.guest, true, 'no user/requestor on the guest context');
  const r = await pub('/w/person1/ping-1/who?see=yes');
  assert.equal(JSON.parse(await r.text()).search, '?see=yes');
  const fsr = await pub('/w/person1/ping-1/fs-try');
  assert.equal(fsr.status, 503, 'guests have no fs (me.puter.fs absent)');
});

test('canonical worker hosts resolve through the shared private route while Request.url stays canonical', async () => {
  const res = await hostC.get('/w/host/ping-1/who');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.path, '/who');
  assert.equal(res.body.origin, 'https://ping-1.puter.work');
});

test('public Request URL and headers never expose the private listener Host/origin', async () => {
  config.set('workers.public_base_url', '');
  const who = await pub('/w/person1/ping-1/who', { host: 'private.internal:8443', 'x-forwarded-host': 'private.internal', 'x-original-host': 'private.internal' });
  assert.equal(who.status, 200);
  const body = JSON.parse(await who.text());
  assert.equal(body.path, '/who');
  assert.equal(body.origin, 'https://ping-1.puter.work');
  assert.equal(body.workerBase, '');
  assert.equal(Object.hasOwn(body, 'host'), false);
  assert.equal(Object.hasOwn(body, 'forwardedHost'), false);
  assert.equal(Object.hasOwn(body, 'originalHost'), false);
  assert.equal(JSON.stringify(body).includes('private.internal'), false);
});

test('signatures worker public base comes from configuration only', async () => {
  config.set('workers.public_base_url', 'https://guest.example.test/public');
  const who = await pub('/w/person1/ping-1/who', { host: 'private.internal:8443', 'x-forwarded-host': 'private.internal', 'x-original-host': 'private.internal' });
  assert.equal(who.status, 200);
  const body = JSON.parse(await who.text());
  assert.equal(body.path, '/who');
  assert.equal(body.origin, 'https://ping-1.puter.work');
  assert.equal(body.workerBase, 'https://guest.example.test/public/w/person1/ping-1');
  assert.equal(Object.hasOwn(body, 'host'), false);
  assert.equal(Object.hasOwn(body, 'forwardedHost'), false);
  assert.equal(Object.hasOwn(body, 'originalHost'), false);
  assert.equal(JSON.stringify(body).includes('private.internal'), false);
  config.set('workers.public_base_url', '');
});

test('no session cookie is ever issued over the guest link', async () => {
  const r = await pub('/w/person1/ping-1/ping');
  assert.equal(r.headers['set-cookie'], undefined);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
});

test('the public listener rate-caps the guest address (429 after 120/min)', async () => {
  // GUEST_RATE is 120 per address per minute (hub-workers-http.js): a
  // sequential walk crosses the cap in one window. The first 120 are served;
  // request 121+ is a named 429 even though the target is still valid.
  const seen = [];
  for (let i = 0; i < 125; i += 1) {
    try {
      const r = await pub('/w/person1/ping-1/ping');
      seen.push(r.status);
    } catch (e) {
      seen.push(`err:${e.code ?? 'unknown'}`);
    }
  }
  assert.ok(seen.filter((s) => s === 200).length >= 100, `healthy guests get through: first ${JSON.stringify(seen.slice(0, 10))} last ${JSON.stringify(seen.slice(-10))}`);
  assert.ok(seen.at(-1) === 429, `the cap fires once the window fills: ${JSON.stringify(seen.slice(-6))}`);
});
