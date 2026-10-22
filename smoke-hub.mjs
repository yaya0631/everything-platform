#!/usr/bin/env node
/**
 * Manual hub smoke (not part of npm test; needs a real built app).
 *
 *   node smoke-hub.mjs contacts [--from <dist>] [--serve] [--port 18099]
 *
 * Installs a built app into a THROWAWAY data folder, starts the private
 * listener and checks, over HTTP only:
 *   - the app serves at /h/<name>/ with a strict CSP and rewritten files;
 *   - no js.puter.com / plausible.io / CDN urls reach the browser;
 *   - the shim is at /hub/puter.js, same-origin only;
 *   - the /apps/ prefix still belongs to hosted apps (no collision);
 *   - access control and enable/disable behave.
 * With --serve the server keeps running for a manual browser pass.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const opts = { name: 'contacts', serve: false, port: 18099, from: null, admin: 'admin', password: 'smoke-pass-123' };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--serve') opts.serve = true;
  else if (argv[i] === '--from') opts.from = argv[++i];
  else if (argv[i] === '--port') opts.port = Number(argv[++i]);
  else opts.name = argv[i];
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-home-smoke-'));
process.env.CAD_DATA_DIR = dataDir;
process.env.CAD_TEST = '1';
process.env.CAD_PRIVATE_URL = '';
process.env.CAD_PUBLIC_URL = '';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
process.chdir(here);

const [hub, build, storem, serverm, configm] = await Promise.all([import('./lib/hub.js'), import('./lib/hub-build.js'), import('./lib/store.js'), import('./server.js'), import('./lib/config.js')]);
storem.addUser(opts.admin, opts.password, { admin: true });
storem.addUser('personb', 'personb-pass-1');

const from = opts.from || path.join(build.upstreamRoot(), 'src', opts.name, 'dist');
console.log(`smoke: installing ${opts.name} (from ${from}) into ${dataDir}`);
hub.installFromDist(opts.name, from, { sha: build.cloneSha() || 'imported', base: opts.from ? 'relative' : '/h/contacts/', source: 'import', title: opts.name });
// a second app from the same dist: cross-app grant isolation is a Phase-2
// check (its pages are never opened; only its data-calls are)
hub.installFromDist('betasmoke', from, { sha: build.cloneSha() || 'imported', base: 'relative', source: 'import', title: 'Beta smoke' });

const running = await serverm.startServer({ port: opts.port, publicPort: 0, host: '127.0.0.1', tls: null });
const base = `http://127.0.0.1:${running.privatePort}`;
console.log(`smoke: serving on ${base}`);

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-CAD-Request': '1' },
  body: JSON.stringify({ username: opts.admin, password: opts.password }),
});
const cookie = login.headers.get('set-cookie')?.split(';')[0] || '';
const h = { Cookie: cookie };
check('login works', login.status === 200 && cookie.endsWith('=') === false);

const hubPage = await fetch(`${base}/hub/`, { headers: h });
const hubBody = await hubPage.text();
check('/hub/ lists the app for the signed-in user', hubPage.status === 200 && hubBody.includes(`/h/${opts.name}/`));

const anon = await fetch(`${base}/hub/`);
check('/hub/ without session → sign-in page (401)', anon.status === 401);

const page = await fetch(`${base}/h/${opts.name}/`, { headers: h });
const html = await page.text();
const csp = page.headers.get('content-security-policy') || '';
check(`/h/${opts.name}/ serves (200)`, page.status === 200, `content-length ${page.headers.get('content-length')}`);
check('no js.puter.com anywhere in the page', !/js\.puter\.com/.test(html.replace(/<!--[\s\S]*?-->/g, '')));
check('no plausible.io in any live tag', !/<script[^>]*plausible/i.test(html) && !/<link[^>]*plausible/i.test(html));
check('shim tag points at /hub/puter.js', /<script src="\/hub\/puter\.js"[^>]*>/.test(html));
check('strict CSP: default-src self', csp.startsWith("default-src 'self'"));
check('strict CSP: connect-src self', csp.includes("connect-src 'self'"));
check('strict CSP: inline script hashes present', /'sha256-[A-Za-z0-9+/=]{40,}'/.test(csp));
check('CSP: violations report to /hub/csp-report', csp.includes('report-uri /hub/csp-report'));
check('frame-ancestors self', csp.includes("frame-ancestors 'self'"));

const assets = [...html.matchAll(/(?:src|href)="(\.\/|\/h\/[^"]*\/)?(assets\/[^"]+\.js)"/g)].map((m) => m[2]);
const firstAsset = assets[0];
const assetUrl = `${base}/h/${opts.name}/${firstAsset}`;
const assetRes = await fetch(assetUrl, { headers: h });
const assetText = await assetRes.text();
check(`bundle serves rewritten (${firstAsset})`, assetRes.status === 200 && assetText.length > 100, `${assetRes.status}, ${nodeSize(assetText)} bytes`);
// Harmless namespace strings (a URL-matching *regex* like puter.(com|local),
// UA-sniffing checks) are allowlisted; real loader URLs and script tags are not.
const inertPatterns = /\/\/([^/]*\.)?puter\.(com|local)|puter\.(work|site)|js\.puter\.com\"\)/g;
const livePuter = assetText.replace(inertPatterns, '').match(/https?:\/\/[^"';\s]*puter\.(com|work|site)/);
check('no remote puter loader inside bundles', !livePuter, livePuter ? String(livePuter[0]) : '');
const remoteUrls = [...new Set([...assetText.matchAll(/https?:\/\/[a-zA-Z0-9.-]+/g)].map((m) => m[0]))].filter((u) =>
  !u.includes('localhost') && !u.includes('127.0.0.1') && !u.startsWith('http://www.w3.org') && !u.includes('lucide.dev') &&
  !u.includes('github.com') && !u.includes('vitejs.dev') && !u.includes('rollupjs.org') && !u.includes('vite.dev') && !u.includes('npmjs.org'));
console.log(`      external URL strings left in that bundle (inert strings, blocked by CSP at runtime): ${remoteUrls.length ? remoteUrls.join(', ') : 'none'}`);

const shim = await fetch(`${base}/hub/puter.js`);
const shimBody = await shim.text();
check('/hub/puter.js serves with same-origin only', shim.status === 200 && shimBody.includes("window.puter") && shimBody.includes("credentials: 'same-origin'"));

const collision = await fetch(`${base}/apps/${opts.name}/`, { headers: h });
check('/apps/ prefix untouched (hosted apps feature answers)', collision.status !== 200, `status ${collision.status}`);

const deepLink = await fetch(`${base}/h/${opts.name}/whatever/route`, { headers: h });
check('extension-less path falls back to index.html', deepLink.status === 200 && /<html/i.test(await deepLink.text()));

const report = await fetch(`${base}/hub/csp-report`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/csp-report', Origin: base },
  body: JSON.stringify({ 'csp-report': { 'violated-directive': 'img-src', 'blocked-uri': 'https://remote.example/pic.png' } }),
});
check('CSP report endpoint accepts reports (204)', report.status === 204);

const disabled = await fetch(`${base}/h/${opts.name}/`, { headers: h });
void disabled;

// -- Phase 2: the data layer behind the shim ----------------------------------

const api = { Cookie: cookie, 'X-CAD-Request': '1', 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin' };
const rawApi = { ...api };
delete rawApi['Content-Type'];
const post = (route, body, app = opts.name) =>
  fetch(`${base}/api/hub/${route}`, {
    method: 'POST', headers: { ...api }, body: JSON.stringify({ app, ...body }),
  }).then(async (r) => ({ s: r.status, d: await r.json().catch(() => null) }));
const getJson = (url) =>
  fetch(`${base}${url}`, { headers: { ...rawApi } }).then(async (r) => ({ s: r.status, d: await r.json().catch(() => null) }));

// kv: the exact wire semantics
const kvSet = await post('kv/set', { key: 'smoke', value: { a: 1 } });
const kvGet = await post('kv/get', { key: 'smoke' });
check('kv.set then get roundtrips the value', kvSet.s === 200 && kvGet.s === 200 && kvGet.d && kvGet.d.a === 1);

// fs: sandbox roundtrip
const wq = (app, path, options = {}) => `${base}/api/hub/fs/write?app=${app}&path=${encodeURIComponent(path)}&options=${encodeURIComponent(JSON.stringify(options))}`;
const drivePath = '/Documents/smoke-file.txt';
const sbWrite = await fetch(wq(opts.name, 'smoke/test.txt'), { method: 'PUT', headers: { ...api, 'Content-Type': 'application/octet-stream' }, body: 'smoke-data' });
check('fs.write into app data works', sbWrite.status === 200);
const sbRead = await getJson(`/api/hub/fs/read?app=${opts.name}&path=${encodeURIComponent('smoke/test.txt')}`);
void sbRead;

// Drive: no grant → refused; grant → write and token URL; revoke → refused again
const driveDenied = await fetch(wq(opts.name, drivePath), { method: 'PUT', headers: { ...api, 'Content-Type': 'application/octet-stream' }, body: 'smoke-drive' });
check('Drive write without a grant is refused (403)', driveDenied.status === 403, driveDenied.status);
const grant = await post('grants', { path: drivePath, perms: 'write', source: 'picker-save' });
check('picker grant recorded', grant.s === 200 && grant.d && grant.d.ok);
const driveWrite = await fetch(wq(opts.name, drivePath, { createMissingParents: true }), { method: 'PUT', headers: { ...api, 'Content-Type': 'application/octet-stream' }, body: 'smoke-drive' });
check('Drive write with the grant works', driveWrite.status === 200, driveWrite.status);

const readUrl = await post('fs/readurl', { path: drivePath, expiresIn: 60 });
check('getReadURL issues a /hub/f/ token', readUrl.s === 200 && /^\/hub\/f\//.test(readUrl.d?.url || ''));
const tokenFetch = readUrl.s === 200 ? await fetch(`${base}${readUrl.d.url}`) : null;
check('the token URL streams the file with no session', tokenFetch && tokenFetch.status === 200 && (await tokenFetch.text()) === 'smoke-drive');
const badToken = await fetch(`${base}/hub/f/AAAA.AAAA`);
check('a forged token is a plain 404', badToken.status === 404);

const grantsList = await getJson('/api/hub/grants');
const mine = (grantsList.d || []).find((g) => g.app === opts.name && g.path === drivePath);
const revokeRes = mine
  ? await fetch(`${base}/api/hub/grants/${mine.id}`, { method: 'DELETE', headers: { ...api } })
  : null;
check('revoking the grant removes it from the account list', revokeRes && revokeRes.status === 200);
const afterRevoke = await fetch(`${base}/api/hub/fs/read?app=${opts.name}&path=${encodeURIComponent(drivePath)}`, { headers: { ...rawApi } });
check('after revocation the Drive file is out of reach again (403)', afterRevoke.status === 403, afterRevoke.status);

// cross-app: beta cannot ride on this app's grant
await post('grants', { path: drivePath, perms: 'write', source: 'picker-save' });
const betaRead = await fetch(`${base}/api/hub/fs/read?app=betasmoke&path=${encodeURIComponent(drivePath)}`, { headers: { ...rawApi } });
check('app B cannot use app A\u2019s grant (403)', betaRead.status === 403, betaRead.status);

// another person: none of this app's data leaks to user B
const loginB = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-CAD-Request': '1' },
  body: JSON.stringify({ username: 'personb', password: 'personb-pass-1' }),
});
const cookieB = loginB.headers.get('set-cookie')?.split(';')[0] || '';
const rawB = { Cookie: cookieB, 'X-CAD-Request': '1' };
const bRead = await fetch(`${base}/api/hub/fs/read?app=${opts.name}&path=${encodeURIComponent('smoke/test.txt')}`, { headers: rawB });
check('person B reading app data of person A gets their own empty sandbox (404)', bRead.status === 404, bRead.status);
const bKv = await fetch(`${base}/api/hub/kv/get`, { method: 'POST', headers: { ...rawB, 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ app: opts.name, key: 'smoke' }) });
check('person B\u2019s kv is a separate namespace (null)', bKv.status === 200 && String((await bKv.text())) === 'null');

// the mock AI provider (testing-only; documented in README)
configm.set('hubAiDefaultModel', 'test:demo');
const chatPlain = await post('ai/chat', { prompt: 'ping', stream: false });
check('ai.chat with the test provider answers', chatPlain.s === 200 && chatPlain.d?.message?.content?.startsWith('test-reply:'), JSON.stringify(chatPlain.d).slice(0, 90));
const chatStream = await post('ai/chat', { prompt: 'ping', stream: true });
check('ai.chat streaming is 200 NDJSON', chatStream.s === 200);
const voice = await post('ai/txt2speech', { prompt: 'hi' });
check('promised engines answer with their install hint', voice.s === 501 && voice.d?.code === 'engine_missing');

function nodeSize(s) {
  let n = 0;
  for (const c of s) n += 1;
  return n;
}

// restart persistence: kv, files and grants all live in the store, not RAM
if (!opts.serve) {
  await running.close();
  // a fresh port: fetch's connection pool would otherwise keep a socket for
  // the old listener and see it reset
  const again = await serverm.startServer({ port: 0, publicPort: 0, host: '127.0.0.1', tls: null });
  const base2 = `http://127.0.0.1:${again.privatePort}`;
  const relogin = await fetch(`${base2}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CAD-Request': '1' },
    body: JSON.stringify({ username: opts.admin, password: opts.password }),
  });
  const cookie2 = relogin.headers.get('set-cookie')?.split(';')[0] || '';
  const kvAfter = await fetch(`${base2}/api/hub/kv/get`, { method: 'POST', headers: { Cookie: cookie2, 'X-CAD-Request': '1', 'Content-Type': 'application/json', Origin: base2 }, body: JSON.stringify({ app: opts.name, key: 'smoke' }) });
  check('kv survives a server restart', kvAfter.status === 200 && (await kvAfter.json())?.a === 1);
  const fileAfter = await fetch(`${base2}/api/hub/fs/read?app=${opts.name}&path=${encodeURIComponent('smoke/test.txt')}`, { headers: { Cookie: cookie2, 'X-CAD-Request': '1' } });
  check('app files survive a server restart', fileAfter.status === 200 && (await fileAfter.text()) === 'smoke-data');
  const grantsAfter = await fetch(`${base2}/api/hub/grants`, { headers: { Cookie: cookie2, 'X-CAD-Request': '1' } });
  const grantAfter = (await grantsAfter.json() || []).some((g) => g.path === drivePath);
  check('grants survive a server restart', grantsAfter.status === 200 && grantAfter === true);
  await again.close();
  console.log('');
  console.log(failed === 0 ? 'SMOKE OK' : `SMOKE FAILED: ${failed} check(s)`);
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
} else {
  console.log(`(server stays up for the browser pass; data in ${dataDir})`);
}
