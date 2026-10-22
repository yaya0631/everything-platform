/** §26 worker-alias boundary: apps only ever see the canonical
 * https://<host_label>.puter.work address; the transport mapper routes it to
 * the private route (behind a session) or the public route (public+approved
 * rows, anonymous). Pins: the alias resolves to private AND public routes,
 * labels are unique per member + DNS-shaped + <= 63 chars (the shape the
 * apps' own code validates), one member cannot reach another member's
 * private worker through the alias, an unknown alias names the refusal
 * (external_not_allowed, private and public), and calendar's cal-<user>
 * self-built label round-trips both ways. */
import test from 'node:test';
import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import { start, cleanup, client } from './helpers.js';
import * as store from '../lib/store.js';
import * as config from '../lib/config.js';
import * as hub from '../lib/hub.js';

const PROBE = 'router.get("/ping", () => new Response("alias pong", { status: 200 }));';
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

let running;
let person1;
let person2;

/** One-shot request over the PUBLIC listener (never undici; keep-alive would
 * pin the process at exit). */
const pub = (method, p, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ port: running.publicPort, path: p, method, headers, agent: false }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({
      status: res.statusCode,
      body: Buffer.concat(chunks).toString('utf8'),
      headers: res.headers,
    }));
  });
  req.on('error', reject);
  req.end();
});

async function deploy(userC, name) {
  const created = await userC.post('hub/workers', { app: 'alpha', name, filePath: 'workers/ping.js' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  return created.body;
}

before(async () => {
  running = await start();
  hub.installFromDist('alpha', 'test/fixtures/hub/fixture-dist', { sha: 'a'.repeat(40), source: 'import', title: 'Alpha' });
  // the FIRST account becomes admin (store bootstrap rule); give that role
  // to a dedicated account so member username are genuine non-admins here.
  store.addUser('boss', 'boss-password', { admin: true });
  store.addUser('person1', 'person1-password');
  store.addUser('person2', 'person2-password');
  person1 = client(running.base);
  person2 = client(running.base);
  await person1.login('person1', 'person1-password');
  const w1 = await person1.call('PUT', 'hub/fs/write?app=alpha&path=workers/ping.js&options=' + encodeURIComponent('{}'), { body: PROBE, raw: true });
  assert.equal(w1.status, 200, `person1 write: ${w1.status} ${JSON.stringify(w1.body ?? w1.text ?? '')}`);
  await person2.login('person2', 'person2-password');
  const w2 = await person2.call('PUT', 'hub/fs/write?app=alpha&path=workers/ping.js&options=' + encodeURIComponent('{}'), { body: PROBE, raw: true });
  assert.equal(w2.status, 200, `person2 write: ${JSON.stringify(w2.body ?? w2.status)}`);
  await person2.login('person2', 'person2-password');
});

after(async () => {
  config.set('workers.allow_public_user_workers', false);
  config.set('workers.public_auto_approve', false);
  await cleanup(running);
});

/** Load the shim source and realize its canonicalWorkerRow boundary function
 * the same way the page does (pure function; no browser needed). */
function shimCanonical() {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib', 'shim', 'puter.js'), 'utf8');
  const start = src.indexOf('function canonicalWorkerRow');
  const end = src.indexOf('puter.workers = {');
  assert.ok(start >= 0 && end > start, 'canonicalWorkerRow lives right above puter.workers');
  const fn = src.slice(start, end);
  const ctx = { Promise };
  vm.runInNewContext(fn, ctx);
  return { canon: ctx.canonicalWorkerRow, src };
}

test('the shim-visible shape is the canonical alias, nothing else', async () => {
  const created = await deploy(person1, 'alias-priv');
  // the SERVER-INTERNAL response keeps the §23 relative route:
  assert.equal(created.url, '/wr/person1/alias-priv/');
  // ...and the shim converts it at the app-visible boundary:
  const { canon } = shimCanonical();
  const seenRow = canon(created);
  assert.equal(seenRow.url, `https://${created.host_label}.puter.work`);
  assert.match(seenRow.url, /^https:\/\/[a-z0-9][a-z0-9-]{0,61}[a-z0-9]?\.puter\.work$/);
  const listRow = canon([created])[0];
  assert.equal(listRow.url, seenRow.url, 'create/list agree at the boundary');
  const nullish = canon(null);
  assert.equal(nullish, null, 'nulls pass through (get: no such worker)');
});

test('the shim wires canonicalWorkerRow into create, list, and get', () => {
  const { src } = shimCanonical();
  const at = src.indexOf('puter.workers = {');
  const end = src.indexOf('function apiFail2');
  assert.ok(at >= 0 && end > at, 'the puter.workers block is where the boundary belongs');
  const block = src.slice(at, end);
  const wired = block.split('canonicalWorkerRow(').length;
  assert.ok(wired >= 4, `create, list, get (and the list itself) converge at the boundary; found ${wired - 1} call sites`);
  for (const method of ['create', 'list', 'get']) {
    const m = block.indexOf(`${method}: function`);
    assert.ok(m >= 0, `shim has ${method}()`);
    const slice = block.slice(m, m + 900);
    assert.ok(/canonicalWorkerRow\(/.test(slice), `shim ${method}() converges the row at the boundary`);
  }
});

test('the alias answers on the PRIVATE route behind the owner session', async () => {
  const created = await deploy(person1, 'alias-priv');
  const r = await person1.get(`/w/host/${created.host_label}/ping`);
  assert.equal(r.status, 200, JSON.stringify({ status: r.status, body: r.body }));
  assert.equal(r.body, 'alias pong');
});

test('the alias answers on the PUBLIC route once the row is public + approved', async () => {
  config.set('workers.allow_public_user_workers', true);
  config.set('workers.public_auto_approve', true);
  try {
    const created = await deploy(person1, 'alias-pub');
    assert.equal(created.public, true, JSON.stringify(created));
    assert.equal(created.publicApproved, true);
    const r = await pub('GET', `/w/host/${created.host_label}/ping`);
    assert.equal(r.status, 200, JSON.stringify({ status: r.status, body: r.body }));
    assert.equal(r.body, 'alias pong');
  } finally {
    config.set('workers.allow_public_user_workers', false);
    config.set('workers.public_auto_approve', false);
  }
});

test('a private row stays unreachable on the PUBLIC listener under its alias', async () => {
  const created = await deploy(person1, 'alias-not-public');
  const r = await pub('GET', `/w/host/${created.host_label}/ping`, { origin: 'http://x.test' });
  assert.equal(r.status, 404, JSON.stringify({ status: r.status, body: r.body }));
  assert.equal(JSON.parse(r.body).code, 'not_found');
});

test('labels are unique across members, DNS-shaped, and at most 63 chars', async () => {
  const a = await deploy(person1, 'echo-1');
  const b = await deploy(person2, 'echo-1');
  assert.notEqual(a.host_label, b.host_label, 'the same name across members must not share a label');
  for (const [label, who] of [[a.host_label, 'person1'], [b.host_label, 'person2']]) {
    assert.ok(DNS_LABEL.test(label), `${who} label is DNS-shaped: ${label}`);
    assert.ok(label.length <= 63, `${who} label is at most 63 chars: ${label.length}`);
  }
  // a maximum-length name (64 = NAME_RE cap) still yields a DNS-safe label
  const longName = 'a-' + 'b'.repeat(61) + '-'; // exactly 64 chars, ends with a dash on purpose
  const c = await deploy(person1, longName);
  assert.ok(DNS_LABEL.test(c.host_label), `long/dashy name -> DNS label: ${c.host_label}`);
  assert.ok(c.host_label.length <= 63);
});

test('one member cannot reach another member\'s private worker through the alias', async () => {
  const b = await deploy(person2, 'echo-1');
  const r = await person1.get(`/w/host/${b.host_label}/ping`);
  // indistinguishable from an unknown address on purpose (§9 privacy)
  assert.equal(r.status, 404, JSON.stringify({ status: r.status, body: r.body }));
});

test('an unknown alias names the refusal: external_not_allowed (private + public)', async () => {
  const priv = await person1.get('/w/host/nobody-deployed-this/ping');
  assert.equal(priv.status, 403, JSON.stringify(priv.body));
  assert.equal(priv.body.code, 'external_not_allowed');
  const publicr = await pub('GET', '/w/host/nobody-deployed-this/ping', { origin: 'http://x.test' });
  assert.equal(publicr.status, 403, JSON.stringify(publicr.body));
  assert.equal(JSON.parse(publicr.body).code, 'external_not_allowed');
  assert.equal(publicr.headers['access-control-allow-origin'], '*', 'even the refusal carries CORS so the app can read it');
});

test("calendar's cal-<user> self-built label round-trips both ways", async () => {
  config.set('workers.allow_public_user_workers', true);
  config.set('workers.public_auto_approve', true);
  try {
    const created = await deploy(person1, 'cal-person1');
    assert.equal(created.host_label, 'cal-person1', 'the label the calendar app builds is allocated verbatim');
    const viaCal = await pub('GET', '/w/cal-person1/ping');
    assert.equal(viaCal.status, 200, JSON.stringify({ status: viaCal.status, body: viaCal.body }));
    assert.equal(viaCal.body, 'alias pong');
    const viaAlias = await pub('GET', `/w/host/${created.host_label}/ping`);
    assert.equal(viaAlias.status, 200, JSON.stringify({ status: viaAlias.status, body: viaAlias.body }));
    assert.equal(viaAlias.body, 'alias pong');
  } finally {
    config.set('workers.allow_public_user_workers', false);
    config.set('workers.public_auto_approve', false);
  }
});
