// Adversarial load pass: real Chrome against the live platform server.
// Captures per-app: console msgs, page errors, failed requests, external-host
// attempts, CSP violations, render metrics, screenshot. NO CAD_TEST (real AI only).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('D:/Stream/everything/platform/package.json');
const puppeteer = require('puppeteer-core');

const BASE = process.env.BASE || 'http://127.0.0.1:8080';
const OUT = path.resolve('evidence/load-pass');
const SHOTS = path.resolve('evidence/screenshots');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

const USER = process.env.VUSER || 'vtest1';
const PASS = process.env.VPASS || 'V3rify!Pass1';

const CHROME = 'C:\\Program Files\\Google\\Google Chrome\\Application\\chrome.exe';
const chromeExe = fs.existsSync(CHROME) ? CHROME : 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// login
const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-CAD-Request': '1' },
  body: JSON.stringify({ username: USER, password: PASS }),
});
const setCookie = login.headers.get('set-cookie') || '';
const token = setCookie.split(';')[0].split('=')[1];
if (!token) { console.error('LOGIN FAILED', login.status, await login.text()); process.exit(2); }
console.log('logged in as', USER, 'status', login.status);

const appArg = process.argv[2];
const ALL = process.argv.includes('--all');
let apps;
if (ALL || !appArg) {
  const hubLs = await fetch(`${BASE}/api/hub/apps`, { headers: { 'X-CAD-Request': '1', Cookie: `cad_session=${token}` } }).then(r => r.json()).catch(() => null);
  apps = Array.isArray(hubLs?.apps) ? hubLs.apps.map(a => a.name) : fs.readdirSync('D:/Stream/everything/platform/data/hub/apps');
} else apps = appArg.split(',');
console.log('apps to test:', apps.length);

const launchArgs = ['--no-first-run', '--mute-audio', '--disable-features=TranslateUI'];
if (process.env.BLACKHOLE_PROXY) {
  launchArgs.push(`--proxy-server=${process.env.BLACKHOLE_PROXY}`, '--proxy-bypass-list=127.0.0.1;localhost');
}
const browser = await puppeteer.launch({ executablePath: chromeExe, headless: true, args: launchArgs });

const summary = [];
for (const app of apps) {
  const url = `${BASE}/h/${app}/`;
  const result = { app, url, console: [], pageerrors: [], failed: [], external: [], csp: [], responses4xx5xx: [], sw: [] };
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.setCookie({ name: 'cad_session', value: token, url: BASE });
  page.on('console', (m) => {
    const t = m.type(), txt = String(m.text?.() ?? '').slice(0, 500);
    result.console.push({ t, txt });
    if (/Content Security Policy|Refused to/i.test(txt)) result.csp.push(txt);
  });
  page.on('pageerror', (e) => result.pageerrors.push(String(e).slice(0, 500)));
  page.on('requestfailed', (r) => {
    const u = r.url();
    result.failed.push({ u: u.slice(0, 300), err: r.failure()?.errorText });
    if (!/127\.0\.0\.1|localhost/.test(u)) result.external.push({ u: u.slice(0, 300), err: r.failure()?.errorText, phase: 'request' });
  });
  page.on('request', (r) => {
    const u = r.url();
    if (!/127\.0\.0\.1|localhost|^data:|^blob:/.test(u)) result.external.push({ u: u.slice(0, 300), phase: 'request' });
  });
  page.on('response', (r) => { if (r.status() >= 400) result.responses4xx5xx.push({ u: r.url().slice(0, 300), s: r.status() }); });
  const swTargets = [];
  try {
    const ctx = page.browserContext();
    // SW registrations observed via console + worker target events
    browser.on('targetcreated', (t) => { if (t.type() === 'service_worker') swTargets.push(t.url()); });
  } catch {}
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 9000)); // settle: lazy loads, SW, canvases
    const metrics = await page.evaluate(() => ({
      elements: document.querySelectorAll('*').length,
      text: (document.body?.innerText || '').length,
      title: document.title,
      hasPuter: typeof window.puter,
      puterIsShim: !!(window.puter && window.puter.__isLocalShim),
      canvas: document.querySelectorAll('canvas').length,
      lsKeys: Object.keys(localStorage).length,
    })).catch(e => ({ err: String(e) }));
    result.metrics = metrics;
    result.swRegistered = swTargets.filter(u => u.includes(app));
    await page.screenshot({ path: path.join(SHOTS, `${app}.png`) }).catch(() => {});
  } catch (e) {
    result.loadError = String(e).slice(0, 400);
  }
  // dedupe external
  result.external = [...new Map(result.external.map(e => [e.u + (e.err || ''), e])).values()];
  fs.writeFileSync(path.join(OUT, `${app}.json`), JSON.stringify(result, null, 1));
  const bad = result.pageerrors.length + result.failed.length + result.responses4xx5xx.length;
  summary.push({ app, elements: result.metrics?.elements, title: result.metrics?.title, puter: result.metrics?.hasPuter, shim: result.metrics?.puterIsShim, ext: result.external.length, errs: bad, loadError: result.loadError ? 'LOAD-FAIL' : '' });
  await page.close();
}
await browser.close();
fs.writeFileSync(path.join(OUT, '_summary.json'), JSON.stringify(summary, null, 1));
console.table(summary);
console.log('done. results in', OUT);
