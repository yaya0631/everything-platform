#!/usr/bin/env node
/**
 * Chromium acceptance for the 3d app's Python runtime (M6):
 *
 *   served   the built assets/index-*.js carries /hub/pyodide/, never the
 *            jsDelivr URL;
 *   runtime  a signed-in page can load the vendored Pyodide and run Python
 *            (6*7, json round-trip) under the app's CSP;
 *   offline  no request leaves the hub origin for the runtime.
 *
 * Run: node pyodide-e2e.mjs   (needs Chrome and upstream/src/3d/dist; evidence
 * lands in pyodide-e2e-results.json)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, '.tmp-pyodide-e2e');
fs.rmSync(DATA, { recursive: true, force: true });
process.env.CAD_DATA_DIR = DATA;
process.env.CAD_TEST = '1';
const PORT = Number(process.env.PYODIDE_E2E_PORT || 18221);
const PUB_PORT = PORT + 1;
const USER = 'pyoe2e';
const PASS = 'pyodide-e2e-pass-1';
const chrome = [
  process.env.BROWSER_EXE,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean).find((p) => { try { fs.accessSync(p); return true; } catch { return false; } });
if (!chrome) throw new Error('Chrome is required for the Pyodide E2E.');

const [server, store, hub] = await Promise.all([
  import('./server.js'), import('./lib/store.js'), import('./lib/hub.js'),
]);

const steps = [];
const check = (step, ok, detail = '') => {
  steps.push({ step, pass: !!ok, detail: String(detail).slice(0, 1600) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step}${detail ? `: ${String(detail).slice(0, 400)}` : ''}`);
};

async function login(base, username, password) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CAD-Request': '1' },
    body: JSON.stringify({ username, password }),
  });
  const token = (res.headers.get('set-cookie') || '').split(';')[0].split('=')[1];
  if (!res.ok || !token) throw new Error(`login ${username}: HTTP ${res.status}`);
  return token;
}

let running;
let browser;
try {
  running = await server.startServer({ port: PORT, publicPort: PUB_PORT, host: '127.0.0.1', tls: null });
  store.addUser(USER, PASS, { admin: true });
  hub.installFromDist('3d', path.join(here, '..', 'upstream', 'src', '3d', 'dist'), {
    sha: 'e'.repeat(40), source: 'import', title: '3D',
  });
  const base = `http://127.0.0.1:${running.privatePort}`;
  const token = await login(base, USER, PASS);
  check('throwaway account and installed 3d app', true);

  const pageHtml = await (await fetch(`${base}/h/3d/`, { headers: { Cookie: `cad_session=${token}` } })).text();
  const src = /<script[^>]+src="([^"]+\.js)"/i.exec(pageHtml)?.[1];
  check('3d page names a local module bundle', !!src, src || pageHtml.slice(0, 300));
  const bundle = await (await fetch(`${base}${src}`, { headers: { Cookie: `cad_session=${token}` } })).text();
  const localRuntime = bundle.includes('aw=`/hub/pyodide/`');
  const executableRemote = bundle.includes('https://cdn.jsdelivr.net/pyodide/v${iw}/full/');
  check('the served 3d bundle points its runtime at /hub/pyodide/',
    localRuntime && !executableRemote,
    `local=${localRuntime} executableRemote=${executableRemote}`);

  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-first-run', '--enable-unsafe-swiftshader'],
  });
  const ctx = await browser.createBrowserContext();
  await ctx.setCookie({ name: 'cad_session', value: token, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' });
  const page = await ctx.newPage();
  const outside = [];
  const runtimeErrors = [];
  page.on('request', (req) => {
    const u = req.url();
    if (/^https?:\/\/(?:cdn\.jsdelivr\.net|js\.puter\.com|openrouter\.ai)\//i.test(u)) outside.push(u);
  });
  page.on('pageerror', (e) => runtimeErrors.push(String(e.message || e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && /content security policy|webassembly|pyodide/i.test(m.text())) {
      runtimeErrors.push(m.text());
    }
  });

  await page.goto(`${base}/h/3d/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const py = await page.evaluate(async () => {
    try {
      const mod = await import('/hub/pyodide/pyodide.mjs');
      const runtime = await mod.loadPyodide({ indexURL: '/hub/pyodide/' });
      const answer = runtime.runPython('6 * 7');
      const json = runtime.runPython("import json; json.dumps({'ok': True, 'n': 42})");
      const python = runtime.runPython('import sys; sys.version.split()[0]');
      return { answer, json, version: runtime.version, python };
    } catch (e) {
      return { error: String(e?.stack || e), name: e?.name, message: e?.message };
    }
  });
  check('vendored Pyodide loads and runs Python under the 3d CSP',
    !py.error && py.answer === 42 && py.json === '{"ok": true, "n": 42}',
    JSON.stringify(py));
  check('the runtime is the vendored Pyodide release', !py.error && py.version === '314.0.7', py.version);
  check('the Python runtime is the expected 3.14 line', !py.error && /^3\.14\./.test(py.python || ''), py.python);
  check('no runtime request leaves the hub origin', outside.length === 0, outside.join(' | '));
  check('no Pyodide/CSP runtime errors', runtimeErrors.length === 0, runtimeErrors.join(' | '));
} finally {
  try { await browser?.close(); } catch { /* already gone */ }
  try { await running?.close(); } catch { /* already gone */ }
  fs.rmSync(DATA, { recursive: true, force: true });
}

const failed = steps.filter((s) => !s.pass);
const evidence = {
  ranAt: new Date().toISOString(),
  runner: 'pyodide-e2e.mjs',
  chrome,
  steps,
  passed: steps.length - failed.length,
  total: steps.length,
  ok: failed.length === 0,
};
fs.writeFileSync(path.join(here, 'pyodide-e2e-results.json'), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`\n${evidence.passed}/${evidence.total} Pyodide browser checks passed`);
process.exit(evidence.ok ? 0 : 1);
