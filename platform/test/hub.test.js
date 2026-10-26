/**
 * The hub: catalog, serve-time rewriting, strict CSP, access control. Runs
 * against a synthetic dist fixture so no npm or network work happens in tests.
 */
import test from 'node:test';
import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { start, cleanup, client } from './helpers.js';
import * as hub from '../lib/hub.js';
import * as store from '../lib/store.js';

const FIXTURE = 'test/fixtures/hub/fixture-dist';
const SHA40 = (c) => c.repeat(40);
const install = (sha = SHA40('0')) =>
  hub.installFromDist('fixture', FIXTURE, { sha, source: 'import', title: 'Fixture' });

let running;
before(async () => {
  running = await start();
  store.addUser('root', 'root-password', { admin: true });
  store.addUser('person1', 'person1-password');
  store.addUser('person2', 'person2-password');
});
after(() => cleanup(running));

async function asAdmin() {
  const c = client(running.base);
  await c.login('root', 'root-password');
  return c;
}
async function as(name) {
  const c = client(running.base);
  await c.login(name, `${name}-password`);
  return c;
}

test('installing from dist and the admin catalog', async () => {
  const a = await asAdmin();
  const app = install();
  assert.equal(app.name, 'fixture');
  assert.ok(app.size > 0);
  assert.equal(app.enabled, true);
  assert.equal(app.access, 'all');

  // Resolved dependency versions and the per-app path-prefix issues are part
  // of the catalog metadata, so installs are reproducible and the /h/<name>/
  // decision later can be made on recorded numbers.
  assert.ok(app.pathIssues);
  assert.deepEqual(app.pathIssues.swRegister, ['/sw.js']);
  assert.ok(app.pathIssues.assetStrings.includes('icon.svg'), JSON.stringify(app.pathIssues.assetStrings));
  assert.ok(app.pathIssues.assetStrings.includes('manifest.webmanifest'));

  const cat = await a.get('hub/apps');
  assert.equal(cat.status, 200);
  assert.equal(cat.body.apps.length, 1);
  assert.match(String(cat.body.everythingDir), /upstream/);
  assert.ok(cat.body.apps[0].pathIssues);

  // Non-admins can't manage the catalog.
  assert.equal((await (await as('person1')).get('hub/apps')).status, 403);
});

test('the /apps/ prefix stays with hosted apps; hub apps are served at /h/<name>/', async () => {
  install();
  const p = await as('person1');
  const page = await p.get('/h/fixture/');
  assert.equal(page.status, 200);
  assert.match(String(page.body), /fixture-rewritten/);

  const old = await p.get('/apps/fixture/');
  assert.notEqual(old.status, 200);
  assert.doesNotMatch(String(old.body ?? ''), /fixture-rewritten/);
});

test('rewriting: shim instead of the cloud loader, analytics gone, strict CSP', async () => {
  const p = await as('person1');
  const page = await p.get('/h/fixture/');
  const html = String(page.body);
  assert.match(page.headers.get('content-type') || '', /html/);
  assert.ok(page.headers.get('content-security-policy'));

  assert.match(html, /src="\/hub\/puter\.js"/);
  // Root-absolute app assets are rebased to /h/<name>/; the PWA manifest is
  // the documented exception — browsers fetch it without credentials, so it
  // lives on the session-free /hub/app-manifest/ route (m1).
  assert.match(html, /href="\/hub\/app-manifest\/fixture\/manifest\.webmanifest"/);
  assert.match(html, /href="\/h\/fixture\/favicon\.svg"/);
  assert.doesNotMatch(html, /href="\/manifest\.webmanifest"/);
  assert.doesNotMatch(html, /href="\/h\/fixture\/manifest\.webmanifest"/);
  assert.doesNotMatch(html, /[^"]js\.puter\.com/); // loader rewritten; can only remain in comments if stripped
  assert.doesNotMatch(html, /<script[^>]*plausible/i);
  assert.doesNotMatch(html, /<link[^>]*fonts\.googleapis/i);
  assert.match(html, /external script removed at serve time \(https:\/\/plausible\.io/);
  assert.match(html, /external resource removed at serve time \(https:\/\/fonts\.googleapis\.com/);
  assert.match(html, /fixture-rewritten/);

  const csp = String(page.headers.get('content-security-policy'));
  assert.match(csp, /^default-src 'self'/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /font-src 'self'/);
  assert.match(csp, /img-src 'self' data: blob:/);
  assert.match(csp, /report-uri \/hub\/csp-report/);

  // Exactly one inline script â†’ exactly one hash, and it is that script's.
  const hashes = [...csp.matchAll(/'sha256-([A-Za-z0-9+/=]+)'/g)].map((m) => m[1]);
  assert.equal(hashes.length, 1);
  const body = /<script>([\s\S]*?)<\/script>/.exec(html.replace(/<script src="\/hub\/puter\.js"><\/script>/g, ''))?.[1];
  const want = `sha256-${crypto.createHash('sha256').update(body, 'utf8').digest('base64')}`;
  assert.ok(csp.includes(want), 'the CSP contains the inline script hash');
});

test('JS bundles are rewritten too (chess-style Puter loaders inside code)', async () => {
  const p = await as('person1');
  const js = await p.get('/h/fixture/assets/app.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type') || '', /javascript/);
  assert.match(String(js.body), /\/hub\/puter\.js/);
  assert.doesNotMatch(String(js.body), /js\.puter\.com/);
  assert.match(String(js.body), /fonts\.gstatic\.com/); // left in place, listed by the scan

  const shim = await p.get('/hub/puter.js');
  assert.equal(shim.status, 200);
  assert.match(shim.headers.get('content-type') || '', /javascript/);
  assert.match(String(shim.body), /window\.puter/);
  assert.match(String(shim.body), /Apache License 2\.0/); // the licence note stays
  assert.doesNotMatch(String(shim.body), /fetch\(`?\$?\{?API[^)]*https/);
  assert.match(String(shim.body), /credentials: 'same-origin'/);

  // The shim's identity endpoint answers with the session's user.
  const who = await p.get('hub/auth/whoami');
  assert.equal(who.status, 200);
  assert.equal(who.body.username, 'person1');

  // Unknown assets do not mask as index.html; extension-less paths do route.
  assert.equal((await p.get('/h/fixture/assets/nope.png')).status, 404);
  const route = await p.get('/h/fixture/some/route');
  assert.equal(route.status, 200);
  assert.match(String(route.body), /fixture-rewritten/);

  const anon = client(running.base);
  anon.cookie = '';
  assert.equal((await anon.get('hub/auth/whoami')).status, 401);
  assert.equal((await anon.get('/hub/auth/whoami')).status, 404);
  assert.equal((await anon.get('/h/fixture/')).status, 401);
});

test('the root page is the hub launcher, not CAD; CAD opens like any app', async () => {
  const p = await as('person1');
  const root = await p.get('/');
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/hub/');
  // Signed-out visitors get the hub's OWN sign-in form at the launcher -
  // identity is platform UI, not something that lives inside an app.
  const anon = client(running.base);
  anon.cookie = '';
  const gate = await anon.get('/hub/');
  assert.equal(gate.status, 401);
  const gateHtml = String(gate.body);
  assert.match(gateHtml, /action="\/api\/hub\/signin"/);
  assert.match(gateHtml, /name="username"/);
  assert.match(gateHtml, /name="password"/);
  // cad is installed in the same catalog as every other app (from its own
  // dist, same installFromDist), and the launcher lists it like any app.
  hub.installFromDist('cad', path.resolve(import.meta.dirname, '../../upstream/src/cad/dist'), { sha: SHA40('c'), source: 'import', title: 'CAD' });
  const home = await p.get('/hub/');
  assert.match(String(home.body), /\/h\/cad\//);
  assert.match(String(home.body), /\/h\/fixture\//);
  // cad itself serves from its own hub path like every other app.
  const cad = await p.get('/h/cad/');
  assert.equal(cad.status, 200);
});

test('the hub sign-in form logs in without any JavaScript', async () => {
  const anon = client(running.base);
  anon.cookie = '';
  // A real browser form post: urlencoded, no X-CAD-Request header, no JSON.
  const login = await fetch(`${running.base}/api/hub/signin`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'person1', password: 'person1-password', to: '/' }).toString(),
  });
  assert.equal(login.status, 303);
  assert.equal(login.headers.get('location'), '/');
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  assert.match(cookie, /^cad_session=.+/);

  // The session works: the launcher renders the app grid now.
  anon.cookie = cookie;
  assert.equal((await anon.get('/hub/')).status, 200);

  // Wrong password re-renders the form with the error, no cookie set.
  anon.cookie = '';
  const bad = await fetch(`${running.base}/api/hub/signin`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'person1', password: 'wrong' }).toString(),
  });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get('set-cookie'), null);
  assert.match(String(await bad.text()), /do not match an account/);

  // The hidden destination may only be a same-site path.
  anon.cookie = '';
  const evil = await fetch(`${running.base}/api/hub/signin`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'person1', password: 'person1-password', to: '//evil.example' }).toString(),
  });
  assert.equal(evil.status, 303);
  assert.equal(evil.headers.get('location'), '/');
});

test('enable/disable and per-user allow lists drive what people see', async () => {
  const a = await asAdmin();
  install(SHA40('b'));
  const p1 = await as('person1');
  const p2 = await as('person2');

  await a.put('hub/apps/fixture', { enabled: false });
  const blocked = await p1.get('/h/fixture/');
  assert.equal(blocked.status, 404);
  assert.match(String(blocked.body), /switched off/);

  await a.put('hub/apps/fixture', { enabled: true, access: 'users', users: ['person1'] });
  assert.equal((await p1.get('/h/fixture/')).status, 200);
  assert.equal((await p2.get('/h/fixture/')).status, 403);
  assert.equal((await a.get('/h/fixture/')).status, 200);

  // Unknown names in the list are dropped at save time.
  await a.put('hub/apps/fixture', { users: ['person1', 'not_a_user'] });
  const cat = await a.get('hub/apps');
  assert.deepEqual(cat.body.apps.find((x) => x.name === 'fixture').users, ['person1']);
});

test('the external-URL scan reports what a build would reach', async () => {
  const a = await asAdmin();
  const scan = await a.get('hub/apps/fixture/scan');
  assert.equal(scan.status, 200);
  const urls = scan.body.urls.map((u) => u.url);
  assert.ok(urls.some((u) => u.startsWith('https://plausible.io/')), 'stripped scripts listed');
  assert.ok(urls.some((u) => u.startsWith('https://fonts.googleapis.com/')), 'stripped stylesheets listed');
  assert.ok(urls.some((u) => u.startsWith('https://js.puter.com/v2')), 'puter loader listed (rewritten at serve time)');
  assert.ok(urls.some((u) => u.startsWith('https://fonts.gstatic.com/')), 'bundle URLs listed');
  assert.equal((await (await as('person1')).get('hub/apps/fixture/scan')).status, 403);
});

test('cross-origin mutations are refused; CSP reports land; removal is clean', async () => {
  const a = await asAdmin();

  assert.equal(
    (await a.call('PUT', 'hub/apps/fixture', { json: { enabled: false }, headers: { Origin: 'https://evil.example' } })).status,
    403,
  );
  const evil = await fetch(`${running.base}/hub/csp-report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: '{}',
  });
  assert.equal(evil.status, 403);

  const report = await a.call('POST', '/hub/csp-report', {
    headers: { 'Content-Type': 'application/csp-report', Origin: running.base },
    body: JSON.stringify({ 'csp-report': { 'violated-directive': 'script-src', 'blocked-uri': 'https://evil.example/x.js' } }),
    raw: true,
  });
  assert.equal(report.status, 204);
  const reports = await a.get('hub/csp-reports');
  assert.ok(reports.body.some((r) => r.directive === 'script-src' && r.blocked.includes('evil.example')));

  const home = await a.get('/hub/');
  assert.equal(home.status, 200);
  assert.match(String(home.body), /\/h\/fixture\//);
  assert.match(String((await (await as('person1')).get('/hub/')).body), /\/h\/fixture\//);

  assert.equal((await a.del('hub/apps/fixture')).status, 200);
  assert.equal(hub.listApps().filter((x) => x.name === 'fixture').length, 0); // cad stays installed alongside
  assert.equal((await a.get('/h/fixture/')).status, 404);
  assert.equal((await a.del('hub/apps/fixture')).status, 404);
});

test('Admin to Hub: hub AI settings save the default model and alias map', async () => {
  const a = await asAdmin();
  // fixture removes the only app above; reinstall, install doesn't matter here
  const put = await a.call('PUT', 'hub/ai-settings', { json: { defaultModel: 'test:demo', aliases: '{"gpt-4o":"test:demo"}' } });
  assert.equal(put.status, 200);
  const get = await a.get('hub/ai-settings');
  assert.equal(get.body.defaultModel, 'test:demo');
  assert.equal(JSON.parse(get.body.aliases)['gpt-4o'], 'test:demo');

  const bad = await a.call('PUT', 'hub/ai-settings', { json: { defaultModel: 'test:demo', aliases: 'not json' } });
  assert.equal(bad.status, 400);
  const badModel = await a.call('PUT', 'hub/ai-settings', { json: { defaultModel: 'no-colon-here', aliases: '' } });
  assert.equal(badModel.status, 400);

  // cleared again so other processes see defaults
  const clear = await a.call('PUT', 'hub/ai-settings', { json: { defaultModel: '', aliases: '' } });
  assert.equal(clear.status, 200);
  const after = await a.get('hub/ai-settings');
  assert.equal(after.body.defaultModel, '');
});

test('external embeds are closed by default and open through one admin setting (m4)', async () => {
  install();
  const a = await asAdmin();
  const p = await as('person1');

  const off = await a.get('hub/external-embeds');
  assert.equal(off.status, 200);
  assert.equal(off.body.enabled, false);
  const closed = await p.get('/h/fixture/');
  assert.match(String(closed.headers.get('content-security-policy')), /frame-src 'self';/);
  assert.doesNotMatch(String(closed.headers.get('content-security-policy')), /youtube|vimeo/);

  const on = await a.call('PUT', 'hub/external-embeds', { json: { enabled: true } });
  assert.equal(on.status, 200);
  assert.equal((await a.get('hub/external-embeds')).body.enabled, true);
  const open = await p.get('/h/fixture/');
  const csp = String(open.headers.get('content-security-policy'));
  assert.match(csp, /frame-src 'self' https:\/\/www\.youtube-nocookie\.com https:\/\/player\.vimeo\.com/);
  assert.match(csp, /https:\/\/docs\.google\.com/);
  assert.match(csp, /https:\/\/drive\.google\.com/);

  // A person who is not an admin cannot flip the setting.
  assert.equal((await p.call('PUT', 'hub/external-embeds', { json: { enabled: false } })).status, 403);

  await a.call('PUT', 'hub/external-embeds', { json: { enabled: false } });
  const closedAgain = await p.get('/h/fixture/');
  assert.match(String(closedAgain.headers.get('content-security-policy')), /frame-src 'self';/);
  assert.doesNotMatch(String(closedAgain.headers.get('content-security-policy')), /youtube|vimeo/);
});
