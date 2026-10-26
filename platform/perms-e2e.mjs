#!/usr/bin/env node
/**
 * M8 acceptance in real Chromium: `puter.perms.request('folder')` is a consent
 * moment, not a silent auto-grant.
 *
 *   - the request mounts the same closed shadow-root dialog a Drive write uses;
 *   - nothing is granted until a decision (and the dialog cannot be clicked by
 *     page script: the shadow root is closed, buttons demand trusted events);
 *   - Deny resolves `false` and creates no grant;
 *   - a later Allow resolves with `/<user>/Documents`, creates the grant, and
 *     leaves an audit row (`hub.perms_granted`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, '.tmp-perms-e2e');
fs.rmSync(DATA, { recursive: true, force: true });
process.env.CAD_DATA_DIR = DATA;
process.env.CAD_TEST = '1';
const PORT = Number(process.env.PERMS_E2E_PORT || 18191);
const PUB_PORT = PORT + 1;
const USER = 'permse2e';
const PASS = 'perms-e2e-pass-1';
const chrome = [process.env.BROWSER_EXE, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
  .filter(Boolean).find((p) => { try { fs.accessSync(p); return true; } catch { return false; } });
if (!chrome) throw new Error('Chrome is required for the permissions E2E.');

const [server, store, hub, db] = await Promise.all([
  import('./server.js'), import('./lib/store.js'), import('./lib/hub.js'), import('./lib/db.js'),
]);

const steps = [];
const check = (step, ok, detail = '') => {
  steps.push({ step, pass: !!ok, detail: String(detail).slice(0, 1200) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step}${detail ? `: ${String(detail).slice(0, 300)}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let running;
let browser;
try {
  running = await server.startServer({ port: PORT, publicPort: PUB_PORT, host: '127.0.0.1', tls: null });
  store.addUser(USER, PASS, { admin: true });
  hub.installFromDist('fixture', path.join(here, 'test', 'fixtures', 'hub', 'fixture-dist'), {
    sha: 'c'.repeat(40), source: 'import', title: 'Fixture',
  });
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
  await page.goto(`${base}/h/fixture/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(() => window.puter && window.puter.perms, { timeout: 30000 });
  check('the shim is live on the fixture page', true);

  const ask = () => page.evaluate(() => {
    window.__perm = { state: 'pending' };
    puter.perms.request('folder').then(
      (v) => { window.__perm = { state: 'resolved', value: v }; },
      (e) => { window.__perm = { state: 'rejected', message: String(e && e.message) }; },
    );
  });

  async function overlay(allow) {
    await page.waitForSelector('.cad-consent-host[data-cad-consent="pending"]', { timeout: 15000 });
    const info = await page.evaluate((wantAllow) => {
      const host = document.querySelector('.cad-consent-host');
      return {
        state: host.dataset.cadConsent,
        app: host.dataset.cadApp,
        path: host.dataset.cadPath,
        need: host.dataset.cadNeed,
        aim: wantAllow ? host.dataset.cadAim : host.dataset.cadDenyAim,
        closed: host.shadowRoot === null,
      };
    }, allow);
    return info;
  }
  async function decide(info) {
    const [x, y] = String(info.aim || '').split(',').map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('the dialog published no aim point');
    await page.mouse.click(x, y);
  }

  // 1. Deny.
  await ask();
  const first = await overlay(false);
  check('the folder request opens the trusted consent dialog',
    first.state === 'pending' && first.app === 'fixture' && first.path === 'Documents' && first.need === 'write',
    JSON.stringify(first));
  check('the dialog is closed to page script (no shadowRoot)', first.closed === true, JSON.stringify(first));
  await sleep(300);
  const pending = await page.evaluate(() => window.__perm);
  check('no silent auto-grant before a decision', pending.state === 'pending', JSON.stringify(pending));
  const before = await page.evaluate(() => puter.perms.check('folder'));
  check('perms.check agrees no grant exists yet', before === false, String(before));
  await decide(first);
  await page.waitForFunction(() => window.__perm && window.__perm.state !== 'pending', { timeout: 15000 });
  const denied = await page.evaluate(() => window.__perm);
  check('Deny resolves false', denied.state === 'resolved' && denied.value === false, JSON.stringify(denied));
  const gone = await page.evaluate(() => !document.querySelector('.cad-consent-host'));
  check('the dialog closes after Deny', gone === true);
  const afterDeny = await page.evaluate(() => puter.perms.check('folder'));
  check('Deny created no grant', afterDeny === false, String(afterDeny));

  // 2. Allow.
  await ask();
  const second = await overlay(true);
  check('a second request asks again after a Deny', second.state === 'pending', JSON.stringify(second));
  await decide(second);
  await page.waitForFunction(() => window.__perm && window.__perm.state !== 'pending', { timeout: 15000 });
  const allowed = await page.evaluate(() => window.__perm);
  check('Allow resolves with the granted folder path',
    allowed.state === 'resolved' && typeof allowed.value === 'string' && /Documents/.test(allowed.value),
    JSON.stringify(allowed));
  const afterAllow = await page.evaluate(() => puter.perms.check('folder'));
  check('Allow creates the grant', afterAllow === true, String(afterAllow));
  const audit = db.get("SELECT actor, detail FROM audit WHERE action = 'hub.perms_granted' ORDER BY at DESC LIMIT 1");
  let detail = null;
  try { detail = audit ? JSON.parse(audit.detail) : null; } catch { detail = null; }
  check('the grant is in the audit log', !!audit && audit.actor === USER && detail && detail.app === 'fixture', JSON.stringify({ audit, detail }));

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
fs.writeFileSync(path.join(here, 'perms-e2e-results.json'), JSON.stringify(report, null, 2));
console.log(`${steps.filter((s) => s.pass).length}/${steps.length} steps passed; evidence in perms-e2e-results.json`);
if (!report.pass) process.exitCode = 1;
