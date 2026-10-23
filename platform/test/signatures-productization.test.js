/** §24 signatures productization pieces, each pinned by its own test:
 *  1. shape() absolute user-worker URLs under a §23 public base (relative stays
 *     the default);
 *  2. workers.public_auto_approve — default false, audited when on, gated by
 *     the §18 toggle;
 *  3. CORS + OPTIONS preflight on the public /w/ + /wr/ mounts (success AND
 *     error shapes carry the headers);
 *  4. the public guest-page mount serves sign.html + ITS referenced assets
 *     only (the owner page and other files stay 404 on the public listener);
 *  5. the page-URL anchor: the served owner chunk carries the §23 base instead
 *     of a location-derived sign-page URL (the shim-prelude idea, landed as a
 *     serve-time substitution with the base in the cache key);
 *  6. the three serve-time rewrite rules exist, are counted by the §22
 *     zero-match walker, and rewrite the built chunks byte-exactly;
 *  7. the deploy consent overlay: source contract here (trusted-only clicks,
 *     session-wide deny memory, named error shape) — the behavioral proof is
 *     the §24 browser E2E.
 * Upstream clone untouched throughout. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, cleanup, client } from './helpers.js';
import * as hub from '../lib/hub.js';
import * as store from '../lib/store.js';
import * as config from '../lib/config.js';
import * as hubWorkers from '../lib/hub-workers.js';
import { APP_JS_RULES, REWRITE_RULES, applyAppJsRules, countRuleHits } from '../lib/hub-rewrite.js';

const FIXTURE = 'test/fixtures/hub/fixture-dist';
const REPO_SIG_DIST = path.join(import.meta.dirname, '..', 'data', 'hub', 'apps', 'signatures');
const SIG_ASSETS = fs.existsSync(path.join(REPO_SIG_DIST, 'assets')) ? path.join(REPO_SIG_DIST, 'assets') : REPO_SIG_DIST;
const SHA40 = (c) => c.repeat(40);

let running;
let hostC;
let pubBase = '';
const port = () => running.publicPort;

/** One-shot request over the public listener, method and headers explicit
 * (node:http closes right after each response — undici's keep-alive pool
 * would pin the test process at exit). */
const pub = (method, p, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ port: port(), path: p, method, headers, agent: false }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: () => Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject);
  req.end();
});

before(async () => {
  running = await start();
  pubBase = `http://127.0.0.1:${running.publicPort}`;
  hub.installFromDist('alpha', FIXTURE, { sha: SHA40('a'), source: 'import', title: 'Alpha' });
  hub.installFromDist('signatures', REPO_SIG_DIST, { sha: SHA40('s'), source: 'import', title: 'Signatures' });
  config.set('workers.timeout_ms', 12000);
  store.addUser('person1', 'person1-password');
  // the test workers point at a tiny probe script in the app sandbox
  const PROBE = 'router.get("/ping", () => new Response("link pong", { status: 200 }));';
  hostC = client(running.base);
  await hostC.login('person1', 'person1-password');
  const wrote = await hostC.call('PUT', 'hub/fs/write?app=alpha&path=workers/ping.js&options=' + encodeURIComponent('{}'), { body: PROBE, raw: true });
  assert.equal(wrote.status, 200, `probe script written: ${wrote.status}`);
  await hostC.login('person1', 'person1-password');
});

after(async () => {
  config.set('workers.public_base_url', '');
  config.set('workers.allow_public_user_workers', false);
  config.set('workers.public_auto_approve', false);
  await cleanup(running);
});

/* 1 — shape(): the §23 base turns member-worker URLs absolute ---------------- */

test('shape() keeps the relative /wr/ URL while no public base is set', async () => {
  const created = await hostC.post('hub/workers', { app: 'alpha', name: 'relative-url', filePath: 'workers/ping.js' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.url, '/wr/person1/relative-url/', JSON.stringify(created.body));
});

test('shape() hands member workers the ABSOLUTE guest URL once the base is set', async () => {
  config.set('workers.public_base_url', `${pubBase}/`); // trailing slash on purpose
  try {
    const created = await hostC.post('hub/workers', { app: 'alpha', name: 'absolute-url', filePath: 'workers/ping.js' });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.url, `${pubBase}/w/person1/absolute-url/`, JSON.stringify(created.body));
    const rows = hubWorkers.listFor({ user: 'person1' });
    const row = rows.find((w) => w.name === 'absolute-url');
    assert.ok(row, 'the created worker shows in the list');
    assert.equal(row.url, `${pubBase}/w/person1/absolute-url/`, 'list/get shapes agree');
  } finally {
    config.set('workers.public_base_url', '');
  }
});

/* 2 — public_auto_approve: default false, audited on, gated by the toggle ---- */

test('public_auto_approve defaults to false, and the base default is empty', () => {
  assert.equal(hubWorkers.DEFAULT_WORKERS_CONFIG['workers.public_auto_approve'], false);
  assert.equal(hubWorkers.DEFAULT_WORKERS_CONFIG['workers.public_base_url'], '');
});

test('with the toggle on, auto-approve marks the deploy publicly served at create (audited)', async () => {
  config.set('workers.allow_public_user_workers', true);
  config.set('workers.public_auto_approve', true);
  const created = await hostC.post('hub/workers', { app: 'alpha', name: 'auto-approved-1', filePath: 'workers/ping.js' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.public, true, JSON.stringify(created.body));
  assert.equal(created.body.publicApproved, true);
  const log = hubWorkers.recentLogsFor('person1').map((r) => r.action);
  assert.ok(log.includes('create'), `create in the audit: ${log.join(',')}`);
  assert.ok(log.includes('auto-approved'), `auto-approved audited: ${log.join(',')}`);
});

test('auto-approve without the §18 toggle does NOT publish (and the manual path still works)', async () => {
  config.set('workers.allow_public_user_workers', false);
  config.set('workers.public_auto_approve', true);
  const gated = await hostC.post('hub/workers', { app: 'alpha', name: 'auto-but-toggle-off', filePath: 'workers/ping.js' });
  assert.equal(gated.status, 200, JSON.stringify(gated.body));
  assert.equal(gated.body.public, false, 'toggle off wins over auto-approve');

  config.set('workers.allow_public_user_workers', true);
  config.set('workers.public_auto_approve', false);
  const manual = await hostC.post('hub/workers', { app: 'alpha', name: 'manual-approve-1', filePath: 'workers/ping.js' });
  assert.equal(manual.status, 200, JSON.stringify(manual.body));
  assert.equal(manual.body.public, false, 'no auto → private until approved');
  const approved = hubWorkers.approvePublic({ user: 'person1', app: null }, 'manual-approve-1', true);
  assert.equal(approved.publicApproved, true, 'the manual path still works');
});

/* 3 — CORS + OPTIONS on the public /w//wr/ mounts ----------------------------- */

test('public worker mounts answer the CORS preflight', async () => {
  const r = await pub('OPTIONS', '/w/person1/auto-approved-1/ping', {
    Origin: 'https://app-page.example',
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'authorization, x-sign-session',
  });
  assert.equal(r.status, 204, JSON.stringify(r.headers));
  assert.equal(r.headers['access-control-allow-origin'], 'https://app-page.example');
  assert.match(String(r.headers['access-control-allow-headers']), /x-sign-session/);
  assert.match(String(r.headers['access-control-allow-methods']), /POST/);
});

test('public worker answers carry the CORS headers, including on error shapes', async () => {
  const r = await pub('GET', '/w/person1/auto-approved-1/ping', { Origin: 'https://owner-page.example' });
  assert.equal(r.status, 200, `served: ${r.text()}`);
  assert.equal(r.headers['access-control-allow-origin'], '*', JSON.stringify(r.headers));

  const missing = await pub('GET', '/w/person1/ghost/who', { Origin: 'https://owner-page.example' });
  assert.equal(missing.status, 404, 'unknown address stays 404');
  assert.equal(missing.headers['access-control-allow-origin'], '*', '404 shape carries CORS so cross-origin callers can read it');

  const denied = await pub('GET', '/w/person1/manual-approve-1/who', { Origin: 'https://owner-page.example' });
  assert.equal(denied.status, 404, 'a private worker is 404 on the public listener');
  assert.equal(denied.headers['access-control-allow-origin'], '*', '…and that 404 keeps CORS intact');
});

/* 4 — the public guest-page mount: sign.html + ITS assets, nothing else ------- */

test('the public listener serves the sign page to anonymous visitors', async () => {
  const r = await pub('GET', '/h/signatures/sign.html');
  assert.equal(r.status, 200, `sign page served publicly: ${r.status}`);
  assert.match(String(r.headers['content-type']), /text\/html/);
  assert.match(String(r.headers['content-security-policy']), /default-src 'self'/);
  assert.equal(r.headers['set-cookie'], undefined, 'no session on the public mount');
  const html = r.text();
  const src = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => u.startsWith('./') || u.startsWith('/h/signatures/'))
    .map((u) => (u.startsWith('./') ? `/h/signatures/${u.slice(2)}`.replace(/\/\//g, '/') : u));
  assert.ok(src.length >= 2, `the page references its assets: ${src.slice(0, 5).join(', ')}`);
  for (const asset of src.slice(0, 3)) {
    const a = await pub('GET', asset);
    assert.equal(a.status, 200, `referenced asset serves on the public listener: ${asset}`);
  }
});

test('the public guest mount is an ALLOWLIST: owner page and other files stay 404', async () => {
  const owner = await pub('GET', '/h/signatures/index.html');
  assert.equal(owner.status, 404, 'the owner SPA must not be the public surface');
  const other = await pub('GET', '/h/signatures/lib-not-on-page.js');
  assert.equal(other.status, 404, 'unreferenced files stay 404');
  const root = await pub('GET', '/h/signatures/');
  assert.equal(root.status, 404, 'no directory listing on the public mount');
  const unknownApp = await pub('GET', '/h/alpha/index.html');
  assert.equal(unknownApp.status, 404, 'apps not on the guest-page list stay 404 publicly');
  const sessioned = await hostC.get('/h/signatures/');
  assert.equal(sessioned.status, 200, 'the private listener still serves the owner page');
});

/* 5 — the page-URL anchor: served chunks carry the §23 base ------------------- */

test('served signatures chunks carry the public base instead of a location-derived page URL', async () => {
  const ownerName = fs.readdirSync(SIG_ASSETS).filter((f) => f.endsWith('.js'))
    .find((f) => fs.readFileSync(path.join(SIG_ASSETS, f), 'utf8').includes(APP_JS_RULES.signatures[0].old));
  assert.ok(ownerName, 'the built owner chunk matches the rule (build shape did not drift)');
  config.set('workers.public_base_url', pubBase);
  try {
    let r = await hostC.get(`/h/signatures/assets/${ownerName}`, { raw: true });
    assert.equal(r.status, 200);
    let served = await r.text();
    assert.ok(served.includes(`${pubBase}/h/signatures/sign.html`), 'the served chunk holds the absolute sign-page URL');
    assert.ok(!served.includes('__CAD_GUEST_BASE__'), 'no marker leaks into served bytes');

    config.set('workers.public_base_url', '');
    r = await hostC.get(`/h/signatures/assets/${ownerName}`, { raw: true });
    served = await r.text();
    assert.ok(served.includes('__CAD_GUEST_BASE__'), 'with no base configured the marker stays (documented degrade)');
  } finally {
    config.set('workers.public_base_url', '');
  }
});

/* 6 — the four serve-time rules + the §22 zero-match checker ----------------- */

test('the four signatures rewrite rules exist, are counted, and rewrite byte-exactly', async () => {
  const names = APP_JS_RULES.signatures.map((r) => r.name);
  assert.deepEqual(names, ['sign-page-url', 'sign-link-host', 'sign-worker-self', 'sign-guest-link']);
  for (const name of names) assert.ok(REWRITE_RULES.some((r) => r.name === name), `${name} participates in the §22 walk`);

  const counts = countRuleHits(REPO_SIG_DIST);
  for (const name of names) {
    assert.ok((counts[name] || 0) >= 1, `${name} hits the built bundle ${counts[name] ?? 0} time(s)`);
  }

  let ownerHit = null;
  let guestHit = null;
  for (const f of fs.readdirSync(SIG_ASSETS).filter((f) => f.endsWith('.js'))) {
    const t = fs.readFileSync(path.join(SIG_ASSETS, f), 'utf8');
    if (t.includes(APP_JS_RULES.signatures[0].old)) ownerHit = f;
    if (t.includes(APP_JS_RULES.signatures[1].old)) guestHit = f;
  }
  assert.ok(ownerHit, 'owner chunk found by rule text');
  assert.ok(guestHit, 'guest sign chunk found by rule text');

  const owner = applyAppJsRules(fs.readFileSync(path.join(SIG_ASSETS, ownerHit), 'utf8'), 'signatures');
  assert.deepEqual(owner.applied.sort(), ['sign-guest-link', 'sign-page-url', 'sign-worker-self'], 'owner chunk gets page-url + self + guest-link');
  assert.ok(owner.text.includes('pageUrl:s=`__CAD_GUEST_BASE__/h/signatures/sign.html`'), 'pageUrl default replaced');
  assert.ok(owner.text.includes('href.replace(/\\\\/sign\\\\/.*$'), 'the worker self-link carries the /sign/ strip');
  // §26-consistent guest links: the stored link resolves the canonical worker
  // hostname onto the public base's /w/host/ alias (openable by a guest); the
  // canonical row URL stays the fallback when no public base is configured.
  assert.ok(owner.text.includes('`__CAD_GUEST_BASE__/w/host/`+new URL'), 'the guest link composes the public /w/host/ alias of the worker hostname');
  assert.ok(owner.text.includes('?`__CAD_GUEST_BASE__/w/host/`'), 'the marker is the no-base degrade arm');
  // With a configured base the served owner chunk carries the OPENABLE shape.
  const servedChunk = fs.readdirSync(SIG_ASSETS).filter((f) => f.endsWith('.js'))
    .find((f) => fs.readFileSync(path.join(SIG_ASSETS, f), 'utf8').includes(APP_JS_RULES.signatures[3].old));
  assert.ok(servedChunk, 'the guest-link rule target exists in the built assets');
  config.set('workers.public_base_url', pubBase);
  try {
    const servedOwner = await hostC.get(`/h/signatures/assets/${servedChunk}`, { raw: true }).then((r) => r.text());
    assert.ok(servedOwner.includes(`\`${pubBase}/w/host/\`+new URL`), 'the served chunk composes guest links on the public base');
    assert.ok(!servedOwner.includes('__CAD_GUEST_BASE__'), 'no marker leaks into served bytes');
  } finally {
    config.set('workers.public_base_url', '');
  }

  const guest = applyAppJsRules(fs.readFileSync(path.join(SIG_ASSETS, guestHit), 'utf8'), 'signatures');
  assert.deepEqual(guest.applied, ['sign-link-host'], 'guest chunk gets the http-loc arm');
  assert.ok(guest.text.includes(',e.protocol===`http:`&&(r=e.href)'), 'the added arm takes the FULL worker URL as base');

  const missed = applyAppJsRules('nothing here', 'signatures');
  assert.deepEqual(missed.missed, ['sign-page-url', 'sign-link-host', 'sign-worker-self', 'sign-guest-link'], 'unmatched rules are reported, never silent');
});

/* 7 — the deploy consent overlay (source contract; behavior in the §24 E2E) --- */

test('the shim routes workers.create through a trusted-only deploy overlay with deny memory', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib', 'shim', 'puter.js'), 'utf8');
  const fn = src.slice(src.indexOf('function deployOverlay'), src.indexOf('function consentChain'));
  assert.ok(fn.includes('dataset.cadDeploy'), 'the overlay is observable (light DOM marker)');
  assert.ok(fn.includes('deployDenied = true'), 'a Deny is remembered for the page session');
  assert.ok(src.includes('return deployOverlay(String(name)).then'), 'workers.create flows through the overlay');
  assert.ok(fn.includes("'pending'") && fn.includes("'allowed'") && fn.includes("'denied'"), 'pending/allowed/denied lifecycle');
  assert.ok(src.includes("code: 'deploy_denied'"), 'a denied create returns the named error the app handles');
  const guards = (fn.match(/isTrusted/g) || []).length;
  assert.ok(guards >= 2, `allow + deny both trust-gated (${guards} guards)`);
  assert.ok(fn.includes("e.key === 'Escape'") && fn.includes('finish(false)'), 'Escape denies through the same trusted decision path');
});
