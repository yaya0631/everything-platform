import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { start, cleanup, client } from './helpers.js';
import * as hub from '../lib/hub.js';
import * as store from '../lib/store.js';
import * as config from '../lib/config.js';
import * as db from '../lib/db.js';

const FIXTURE = 'test/fixtures/hub/fixture-dist';
const SHA = 'b'.repeat(40);
let running;
let owner;
const pub = (method, pathname, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ method, port: running.publicPort, path: pathname, headers, agent: false }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject); req.end();
});

test('shared hosting API and public static site lifecycle', async () => {
  running = await start();
  try {
    store.addUser('hoster', 'hoster-password');
    hub.installFromDist('alpha', FIXTURE, { sha: SHA, source: 'import', title: 'Alpha' });
    owner = client(running.base);
    await owner.login('hoster', 'hoster-password');
    const path = 'hub/fs/write?app=alpha&path=';
    const html = '<!doctype html><html><head><style>h1{color:red}</style></head><body><h1>public page</h1><script>window.publicPage = true</script></body></html>';
    assert.equal((await owner.call('PUT', path + 'site/index.html', { body: html, raw: true })).status, 200);
    assert.equal((await owner.call('PUT', path + 'site/secret.exe', { body: 'no', raw: true })).status, 200);
    const settings = { publicUrl: `http://127.0.0.1:${running.publicPort}`, hostingEnabled: false };
    assert.equal((await owner.put('admin/server', settings)).status, 200);
    const disabled = await owner.post('hub/hosting/create', { app: 'alpha', subdomain: 'alpha-site', root_dir: 'site' });
    assert.equal(disabled.status, 503);

    assert.equal((await owner.put('admin/server', { hostingEnabled: true })).status, 200);
    const made = await owner.post('hub/hosting/create', { app: 'alpha', subdomain: 'alpha-site', root_dir: 'site' });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.equal(made.body.domain, 'alpha-site.puter.site');
    assert.equal(made.body.url, `http://127.0.0.1:${running.publicPort}/site/alpha-site`);
    assert.equal((await owner.post('hub/hosting/get', { app: 'alpha', subdomain: 'alpha-site' })).body.root_dir, 'site');
    assert.equal((await owner.post('hub/hosting/list', { app: 'alpha' })).body.length, 1);

    const page = await pub('GET', '/site/alpha-site/', { cookie: 'cad_session=must-not-be-used' });
    assert.equal(page.status, 200);
    assert.match(page.body, /<script src="\/hub\/worker-url-map\.js" defer><\/script>/);
    assert.match(page.headers['content-security-policy'], /script-src 'self' 'sha256-/);
    assert.match(page.headers['content-security-policy'], /style-src 'self' 'sha256-/);
    assert.doesNotMatch(page.headers['content-security-policy'], /unsafe-inline/);
    assert.match(page.headers['content-security-policy'], /default-src 'none'/);
    assert.match(page.headers['content-security-policy'], /sandbox allow-scripts allow-forms/);
    assert.doesNotMatch(page.headers['content-security-policy'], /allow-same-origin/);
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal(page.headers['set-cookie'], undefined);
    assert.equal((await pub('HEAD', '/site/alpha-site/')).status, 200);
    assert.equal((await fetch(`${running.base}/site/alpha-site/`)).status, 404, 'hosted pages are mounted only on the public listener');
    assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal((await pub('GET', '/site/alpha-site/secret.exe')).status, 415);
    assert.equal((await pub('POST', '/site/alpha-site/')).status, 405);
    assert.equal((await pub('GET', '/site/alpha-site/%2e%2e/secret')).status, 404);

    // contracts publishes subscribable deadline feeds (.ics, §27 census).
    assert.equal((await owner.call('PUT', path + 'site/deadlines.ics', { body: 'BEGIN:VCALENDAR\nEND:VCALENDAR', raw: true })).status, 200);
    const ics = await pub('GET', '/site/alpha-site/deadlines.ics');
    assert.equal(ics.status, 200);
    assert.equal(ics.headers['content-type'], 'text/calendar; charset=utf-8');
    assert.equal((await pub('GET', '/site/alpha-site/nonexistent.ics2')).status, 415, 'the extension list stays closed');

    config.set('hosting.quota_bytes', 22);
    const overWrite = await owner.call('PUT', path + 'site/extra.txt', { body: 'x', raw: true });
    assert.equal(overWrite.status, 413, 'later app writes cannot grow hosted data beyond the per-user quota');
    config.set('hosting.quota_bytes', 1);
    const over = await owner.post('hub/hosting/update', { app: 'alpha', subdomain: 'alpha-site', root_dir: 'site' });
    assert.equal(over.status, 413);
    config.set('hosting.quota_bytes', 104857600);
    const updated = await owner.post('hub/hosting/update', { app: 'alpha', subdomain: 'alpha-site', root_dir: 'site' });
    assert.equal(updated.status, 200);
    assert.ok(db.get("SELECT 1 FROM audit WHERE actor = 'hoster' AND action = 'hosting.created'"));
    assert.ok(db.get("SELECT 1 FROM audit WHERE actor = 'hoster' AND action = 'hosting.updated'"));
    assert.deepEqual((await owner.post('hub/hosting/delete', { app: 'alpha', subdomain: 'alpha-site' })).body, { success: true, uid: 'alpha-site' });
    assert.equal((await pub('GET', '/site/alpha-site/')).status, 404);
    assert.ok(db.get("SELECT 1 FROM audit WHERE actor = 'hoster' AND action = 'hosting.deleted'"));

    const traffic = [];
    for (let i = 0; i < 121; i += 1) traffic.push((await pub('GET', '/site/alpha-site/')).status);
    assert.equal(traffic.at(-1), 429, 'public static hosting is rate limited per site and IP');
  } finally {
    config.set('hosting.enabled', false);
    config.set('hosting.quota_bytes', 104857600);
    config.set('public_url', null);
    await cleanup(running);
  }
});
