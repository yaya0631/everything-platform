#!/usr/bin/env node
/**
 * Chromium acceptance for two audit fixes, against the real meetings + calendar
 * builds (isolated data dir, throwaway account):
 *
 *   m1  no manifest 401 in the console: the served <link rel=manifest> points
 *       at the session-free /hub/app-manifest/ route, and that route answers a
 *       credential-less request (exactly how browsers fetch manifests).
 *   m5  puter.ui.launchApp({background:true}) opens a hidden calendar iframe;
 *       the calendar-api ready handshake, the meetings app's own list request
 *       and the response all cross the postMessage bridge, so the agenda is
 *       bound to Calendar instead of "Couldn't reach Calendar".
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, '.tmp-appconn-e2e');
fs.rmSync(DATA, { recursive: true, force: true });
process.env.CAD_DATA_DIR = DATA;
process.env.CAD_TEST = '1';
const PORT = Number(process.env.APPCONN_E2E_PORT || 18171);
const PUB_PORT = PORT + 1;
const USER = 'conne2e';
const PASS = 'conn-e2e-pass-1';
const chrome = [process.env.BROWSER_EXE, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
  .filter(Boolean).find((p) => { try { fs.accessSync(p); return true; } catch { return false; } });
if (!chrome) throw new Error('Chrome is required for the app-connection E2E.');

const [server, store, hub] = await Promise.all([
  import('./server.js'), import('./lib/store.js'), import('./lib/hub.js'),
]);

const steps = [];
const check = (step, ok, detail = '') => {
  steps.push({ step, pass: !!ok, detail: String(detail).slice(0, 1200) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step}${detail ? `: ${String(detail).slice(0, 300)}` : ''}`);
};

let running;
let browser;
try {
  running = await server.startServer({ port: PORT, publicPort: PUB_PORT, host: '127.0.0.1', tls: null });
  store.addUser(USER, PASS, { admin: true });
  const sha = 'a'.repeat(40);
  for (const app of ['meetings', 'calendar']) {
    hub.installFromDist(app, path.join(here, 'data', 'hub', 'apps', app), { sha, source: 'import', title: app });
  }
  const base = `http://127.0.0.1:${running.privatePort}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CAD-Request': '1' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const token = (login.headers.get('set-cookie') || '').split(';')[0].split('=')[1];
  check('throwaway owner signs in', login.ok && !!token, `HTTP ${login.status}`);

  browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-first-run', '--mute-audio'] });
  const ctx = await browser.createBrowserContext();
  await ctx.setCookie({ name: 'cad_session', value: token, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' });
  const page = await ctx.newPage();
  const consoleTail = [];
  const errors = [];
  const responses = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    consoleTail.push(`[${m.type()}] ${m.text()}`);
    if (consoleTail.length > 500) consoleTail.shift();
  });
  page.on('response', (r) => responses.push({ status: r.status(), url: r.url() }));
  // The app connection is a postMessage channel; log what reaches the page.
  await page.evaluateOnNewDocument(() => {
    window.__cadConnLog = [];
    window.addEventListener('message', (ev) => {
      const d = ev.data;
      if (d && d.__cadConn && d.dir === 'to-parent' && !d.ctrl) window.__cadConnLog.push(d.data);
    });
  });

  await page.goto(`${base}/h/meetings/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.body && document.body.innerText.length > 80, { timeout: 45000 }).catch(() => {});
  const body = await page.evaluate(() => document.body.innerText);
  check('meetings boots inside the hub', body.length > 80, body.slice(0, 200));

  // m1: the served link must point at the session-free route, and that route
  // must answer a credential-less request (the way browsers fetch manifests).
  const manifestHref = await page.evaluate(() => document.querySelector('link[rel="manifest"]')?.getAttribute('href') || null);
  check('the served HTML points the manifest at /hub/app-manifest/',
    !!manifestHref && manifestHref.startsWith('/hub/app-manifest/meetings/'), String(manifestHref));
  let manifestAnon = null;
  if (manifestHref) {
    const r = await fetch(`${base}${manifestHref}`);
    manifestAnon = { status: r.status, type: r.headers.get('content-type') };
  }
  check('the manifest route answers 200 without a session (m1)', !!manifestAnon && manifestAnon.status === 200 && /manifest\+json/.test(manifestAnon.type || ''), JSON.stringify(manifestAnon));
  const manifest401 = responses.filter((r) => r.url.includes('/manifest') && r.status === 401);
  check('no manifest request answers 401 (m1)', manifest401.length === 0, JSON.stringify(manifest401));
  const manifestConsole = consoleTail.filter((l) => /Manifest fetch .* failed|Manifest: .*error/i.test(l));
  check('no manifest console errors (m1)', manifestConsole.length === 0, manifestConsole.join(' | '));

  // m5: the background calendar iframe is up and answers.
  const frame = await page.evaluate(() => {
    const f = document.querySelector('iframe[title^="background app"]');
    return f ? { src: f.src, aria: f.getAttribute('aria-hidden'), w: f.style.width, h: f.style.height } : null;
  });
  check('a hidden background-app iframe exists (m5)', !!frame && frame.src.includes('/h/calendar/'), JSON.stringify(frame));

  let ready = null;
  try {
    await page.waitForFunction(
      () => (window.__cadConnLog || []).some((m) => m && m.$ === 'calendar-api' && m.type === 'ready'),
      { timeout: 45000 },
    );
    ready = await page.evaluate(() => (window.__cadConnLog || []).find((m) => m && m.$ === 'calendar-api' && m.type === 'ready'));
  } catch {
    ready = null;
  }
  check('calendar-api posts its ready handshake (m5)', !!ready && Array.isArray(ready.methods) && ready.methods.includes('list'), JSON.stringify(ready));

  let rpc = null;
  try {
    await page.waitForFunction(
      () => (window.__cadConnLog || []).some((m) => m && m.$ === 'calendar-api' && typeof m.id === 'string'),
      { timeout: 30000 },
    );
    rpc = await page.evaluate(() => (window.__cadConnLog || []).find((m) => m && m.$ === 'calendar-api' && typeof m.id === 'string'));
  } catch {
    rpc = null;
  }
  check('the app’s own calendar RPC round-trips (m5)', !!rpc && rpc.ok === true, JSON.stringify(rpc));

  const agenda = await page.evaluate(() => ({
    source: [...document.querySelectorAll('.agenda-source')].map((e) => e.innerText.trim()),
    emptyTitle: [...document.querySelectorAll('.agenda-empty-title')].map((e) => e.innerText.trim()),
  }));
  check('the agenda is bound to Calendar, not the failure state (m5)',
    agenda.source.includes('From Calendar') && !agenda.emptyTitle.some((t) => /reach Calendar/i.test(t)),
    JSON.stringify(agenda));

  const calendarWarn = consoleTail.filter((l) => /calendar unavailable|Calendar did not open|Calendar did not respond|reach Calendar/i.test(l));
  check('no calendar-unavailable warning (m5)', calendarWarn.length === 0, calendarWarn.join(' | '));
  check('no uncaught page errors', errors.length === 0, errors.join('; '));

  await ctx.close();
} catch (err) {
  steps.push({ step: 'E2E run completed', pass: false, detail: err.stack || err.message });
  console.error(err.stack || err);
} finally {
  await browser?.close().catch(() => {});
  if (running) await running.close();
  fs.rmSync(DATA, { recursive: true, force: true });
}
const report = { at: new Date().toISOString(), pass: steps.every((s) => s.pass), steps };
fs.writeFileSync(path.join(here, 'appconn-e2e-results.json'), JSON.stringify(report, null, 2));
console.log(`${steps.filter((s) => s.pass).length}/${steps.length} steps passed; evidence in appconn-e2e-results.json`);
if (!report.pass) process.exitCode = 1;
