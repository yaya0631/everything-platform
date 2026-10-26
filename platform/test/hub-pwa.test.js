/**
 * m1: browsers fetch PWA manifests with credentials omitted (HTML spec), so
 * the private /h/ mount answered 401 to every browser — a console error on
 * every app and no installability. The manifest and the images it references
 * now come from the session-free /hub/app-manifest/ and /hub/app-asset/
 * routes; the app shell itself stays behind the session gate.
 */
import test from 'node:test';
import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, cleanup, client } from './helpers.js';
import * as hub from '../lib/hub.js';
import * as store from '../lib/store.js';

const FIXTURE = 'test/fixtures/hub/manifest-dist';
const SHA40 = (c) => c.repeat(40);
const APP = 'pwa';

let running;
before(async () => {
  running = await start();
  store.addUser('owner', 'owner-password');
  hub.installFromDist(APP, FIXTURE, { sha: SHA40('p'), source: 'import', title: 'PWA fixture' });
});
after(() => cleanup(running));

const signedIn = async () => {
  const c = client(running.base);
  await c.login('owner', 'owner-password');
  return c;
};

test('signed-in HTML points the manifest link at the session-free route', async () => {
  const c = await signedIn();
  const r = await c.get(`/h/${APP}/`);
  assert.equal(r.status, 200);
  assert.ok(r.body.includes(`href="/hub/app-manifest/${APP}/manifest.json"`), 'manifest link rewritten');
  assert.ok(!r.body.includes('href="./manifest.json"'), 'original link gone');
});

test('the manifest and its icons answer without a session (m1)', async () => {
  // No login: this is exactly what the browser sends for a manifest fetch.
  const anon = client(running.base);
  const man = await anon.get(`/hub/app-manifest/${APP}/manifest.json`);
  assert.equal(man.status, 200, JSON.stringify(man.body));
  assert.match(man.headers.get('content-type') || '', /application\/manifest\+json/);
  // The test client parses any *json content type, so body is the object.
  const j = man.body;
  assert.equal(j.start_url, `/h/${APP}/`);
  assert.equal(j.scope, `/h/${APP}/`);
  assert.equal(j.id, `/h/${APP}/`);
  assert.deepEqual(j.icons.map((i) => i.src), [
    `/hub/app-asset/${APP}/icon-192.png`,
    `/hub/app-asset/${APP}/icons/icon-512.png`,
  ]);
  assert.equal(j.screenshots[0].src, `/hub/app-asset/${APP}/shots/wide.png`);

  for (const icon of j.icons.map((i) => i.src)) {
    const r = await anon.get(icon);
    assert.equal(r.status, 200, `${icon} must load without a session`);
    assert.match(r.headers.get('content-type') || '', /image\/png/);
  }
});

test('the gate stays closed: /h/ still 401, non-images and traversal 404', async () => {
  const anon = client(running.base);
  assert.equal((await anon.get(`/h/${APP}/manifest.json`)).status, 401);
  assert.equal((await anon.get(`/h/${APP}/index.html`)).status, 401);
  assert.equal((await anon.get(`/hub/app-asset/${APP}/secret.txt`)).status, 404);
  assert.equal((await anon.get(`/hub/app-asset/${APP}/index.html`)).status, 404);
  assert.equal((await anon.get(`/hub/app-manifest/${APP}/secret.txt`)).status, 404);
  assert.equal((await anon.get(`/hub/app-asset/${APP}/%2e%2e%2fcad.db`)).status, 404);
  assert.equal((await anon.get('/hub/app-manifest/nosuchapp/manifest.json')).status, 404);
});
