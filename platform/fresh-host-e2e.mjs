#!/usr/bin/env node
/**
 * Fresh-host acceptance: start the platform against an empty data directory,
 * create the first owner, install one app, call the shim, restart the server,
 * and prove the KV value survived. Also proves the local engines are reported
 * missing (not faked) on a host that has not run `npm run engines:install`.
 *
 * This test never touches platform/data; it deletes its own temp directory.
 * Run: node fresh-host-e2e.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-fresh-host-'));
process.env.CAD_DATA_DIR = DATA;
process.env.CAD_TEST = '1';
process.env.CAD_PRIVATE_URL = '';
process.env.CAD_PUBLIC_URL = '';

const chrome = [
  process.env.BROWSER_EXE,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean).find((p) => { try { fs.accessSync(p); return true; } catch { return false; } });
if (!chrome) throw new Error('No Chrome found. Set BROWSER_EXE to the local Chrome executable.');

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};

let running;
let browser;
const USER = 'freshowner';
const PASS = 'fresh-host-pass-1';
const APP = 'fresh-probe';
const KEY = 'fresh.host.key';
const MARKER = `survives-restart-${Date.now()}`;

const login = async (base) => {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CAD-Request': '1' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const token = (res.headers.get('set-cookie') || '').split(';')[0].split('=')[1];
  return { status: res.status, token };
};

try {
  const server = await import('./server.js');
  const store = await import('./lib/store.js');
  const hub = await import('./lib/hub.js');

  check('empty data directory starts with zero apps', (await import('./lib/hub.js')).listApps().length === 0);
  store.addUser(USER, PASS, { admin: true });
  running = await server.startServer({ port: 0, publicPort: 0, host: '127.0.0.1', tls: null });
  const base = `http://127.0.0.1:${running.privatePort}`;

  const anon = await fetch(`${base}/api/hub/apps`);
  check('anonymous admin API is refused', anon.status === 401 || anon.status === 403, `status=${anon.status}`);

  const session = await login(base);
  check('the first owner can sign in', session.status === 200 && !!session.token, `status=${session.status}`);
  const cookie = `cad_session=${session.token}`;
  const missing = await fetch(`${base}/h/${APP}/`, { headers: { Cookie: cookie }, redirect: 'manual' });
  check('an app is not served before it is installed', missing.status === 404, `status=${missing.status}`);

  hub.installFromDist(APP, path.join(here, 'test', 'fixtures', 'hub', 'peer-dist'), {
    sha: 'e'.repeat(40), source: 'import', title: 'Fresh host probe',
  });
  check('the fixture app installs into the empty hub', hub.listApps().some((a) => a.name === APP));

  const enginesRes = await fetch(`${base}/api/hub/engines`, {
    headers: { Cookie: cookie, 'X-CAD-Request': '1' },
  });
  const enginesText = await enginesRes.text();
  let engines = {};
  try { engines = JSON.parse(enginesText); } catch { /* report the raw body below */ }
  check('admin engine status is readable', enginesRes.status === 200 && !!engines.ocr,
    `status=${enginesRes.status} body=${enginesText.slice(0, 160)}`);
  check('OCR is reported missing, not faked, on a fresh host',
    engines.ocr?.available === false && /engines:install/.test(engines.ocr?.hint || ''));
  check('speech is reported missing, not faked, on a fresh host',
    engines.tts?.available === false && /engines:install/.test(engines.tts?.hint || ''));

  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-first-run', '--mute-audio'],
  });
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  await context.setCookie({ name: 'cad_session', value: session.token, url: base });
  await page.goto(`${base}/h/${APP}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(() => typeof puter === 'object' && typeof puter.kv?.set === 'function', { timeout: 30000 });
  const first = await page.evaluate(async ({ key, marker }) => {
    await puter.kv.set(key, marker);
    return { value: await puter.kv.get(key), shim: !!window.puter.fs && !!window.puter.ai };
  }, { key: KEY, marker: MARKER });
  check('the installed app gets the real shim and writes KV', first.value === MARKER && first.shim, JSON.stringify(first));
  check('no page errors on the fresh install', errors.length === 0, errors.join(' | '));

  await running.close();
  running = await server.startServer({ port: 0, publicPort: 0, host: '127.0.0.1', tls: null });
  const base2 = `http://127.0.0.1:${running.privatePort}`;
  await context.setCookie({ name: 'cad_session', value: session.token, url: base2 });
  await page.goto(`${base2}/h/${APP}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(() => typeof puter === 'object' && typeof puter.kv?.get === 'function', { timeout: 30000 });
  const survived = await page.evaluate(async (key) => puter.kv.get(key), KEY);
  check('the session and KV value survive a server restart', survived === MARKER, JSON.stringify(survived));
  check('no page errors after restart', errors.length === 0, errors.join(' | '));
  await context.close();
} finally {
  await browser?.close();
  await running?.close();
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(DATA, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 150)); }
  }
}

const passed = checks.filter((c) => c.ok).length;
const results = { at: new Date().toISOString(), checks, passed, total: checks.length };
fs.writeFileSync(path.join(here, 'fresh-host-e2e-results.json'), JSON.stringify(results, null, 2));
console.log(`\n${passed}/${checks.length} fresh-host checks passed`);
if (passed !== checks.length) process.exitCode = 1;
