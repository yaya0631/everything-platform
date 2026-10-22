#!/usr/bin/env node
/** Chromium acceptance for invoice sharing through the shared local hosting service. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
process.chdir(here);
process.env.CAD_TEST = '1';
const PORT = Number(process.env.INVOICE_E2E_PORT || 18151);
const PUB_PORT = Number(process.env.INVOICE_E2E_PORT_PUB || 18152);
const USER = 'inve2e';
const PASS = 'invoice-e2e-pass-1';
const chrome = [process.env.BROWSER_EXE, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
  .filter(Boolean).find((p) => { try { fs.accessSync(p); return true; } catch { return false; } });
if (!chrome) throw new Error('Chrome is required for invoicing E2E.');

const [server, store, config, db] = await Promise.all([
  import('./server.js'), import('./lib/store.js'), import('./lib/config.js'), import('./lib/db.js'),
]);
const prior = {
  enabled: config.get('hosting.enabled', false), quota: config.get('hosting.quota_bytes', 104857600),
  publicUrl: config.get('public_url'), workerBase: config.get('workers.public_base_url', ''),
};
const userRoot = path.join(here, 'data', 'hub-users', USER);
fs.rmSync(userRoot, { recursive: true, force: true });
db.run('DELETE FROM hub_kv WHERE user = ?', USER);
db.run('DELETE FROM hub_grants WHERE user = ?', USER);
db.run('DELETE FROM hub_sites WHERE user = ?', USER);
if (!store.getAccount(USER)) store.addUser(USER, PASS, { admin: true });
else store.setPassword(USER, PASS);
config.set('hosting.enabled', true);
config.set('hosting.quota_bytes', 104857600);
config.set('public_url', `http://127.0.0.1:${PUB_PORT}`);

const steps = [];
const check = (step, ok, detail = '') => {
  steps.push({ step, pass: !!ok, detail: String(detail).slice(0, 800) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step}${detail ? `: ${String(detail).slice(0, 240)}` : ''}`);
  if (!ok) throw new Error(step);
};
const clickText = async (page, selector, text) => {
  const handle = await page.evaluateHandle(({ selector, text }) => {
  const item = [...document.querySelectorAll(selector)].find((e) => (e.innerText || '').trim().includes(text));
    if (!item) return null;
    item.scrollIntoView({ block: 'center', inline: 'center' });
    return item;
  }, { selector, text });
  const item = handle.asElement();
  if (!item) return false;
  await item.click();
  return true;
};
let running;
let browser;
try {
  running = await server.startServer({ port: PORT, publicPort: PUB_PORT, host: '127.0.0.1', tls: null });
  const base = `http://127.0.0.1:${running.privatePort}`;
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CAD-Request': '1' }, body: JSON.stringify({ username: USER, password: PASS }) });
  const token = (login.headers.get('set-cookie') || '').split(';')[0].split('=')[1];
  check('fresh invoice owner signs in', login.ok && !!token);
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-first-run', '--mute-audio'] });
  const ownerContext = await browser.createBrowserContext();
  await ownerContext.setCookie({ name: 'cad_session', value: token, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' });
  const owner = await ownerContext.newPage();
  const errors = [];
  owner.on('pageerror', (e) => errors.push(e.message));
  owner.on('console', (m) => { if (m.type() === 'error') console.error('PAGE:', m.text()); });
  owner.on('requestfailed', (r) => console.error('REQUEST FAILED:', r.url(), r.failure()?.errorText));
  await owner.goto(`${base}/h/invoicing/`, { waitUntil: 'networkidle2', timeout: 45000 });
  const shimHostingBase = await owner.evaluate(async () => {
    const src = await (await fetch('/hub/puter.js?app=invoicing')).text();
    return src.match(/var HOSTING_BASE = ([^;]+)/)?.[1] || 'missing';
  });
  check('shim receives the configured public hosting base', shimHostingBase.includes(`http://127.0.0.1:${PUB_PORT}/site/`), shimHostingBase);
  if ((await owner.evaluate(() => document.body.innerText)).includes('Could not reach Puter')) throw new Error(`App boot failed; page errors: ${errors.join('; ')}`);
  const loadedSample = await clickText(owner, 'button', 'Explore with sample data');
  if (loadedSample) await owner.waitForFunction(() => !document.body.innerText.includes('Explore with sample data'), { timeout: 30000 });
  const startupText = await owner.evaluate(() => document.body.innerText);
  check('invoice app opens with sample data available', startupText.length > 80 && !startupText.includes('Could not load your data'), startupText.slice(0, 180));
  await owner.evaluate(() => { location.hash = '#/invoices'; });
  await owner.waitForFunction(() => location.hash === '#/invoices' && document.querySelector('.page-title')?.textContent === 'Invoices');
  if (!(await owner.$('.doc-row'))) {
    await owner.evaluate(() => { location.hash = '#/new/invoice'; });
    await owner.waitForSelector('.item-name', { timeout: 10000 });
    await owner.$eval('.item-name', (e) => { e.value = 'E2E design work'; e.dispatchEvent(new Event('input', { bubbles: true })); });
    await owner.$eval('.item-rate', (e) => { e.value = '1250'; e.dispatchEvent(new Event('input', { bubbles: true })); });
    if (!(await clickText(owner, 'button', 'Create'))) throw new Error(`Create invoice action was not found: ${JSON.stringify(await owner.$$eval('button', (xs) => xs.map((x) => x.innerText.trim())))}`);
    await owner.waitForFunction(() => location.hash.startsWith('#/doc/'), { timeout: 15000 });
  } else {
    const firstInvoice = await owner.$('.doc-row');
    await firstInvoice.click();
    await owner.waitForFunction(() => location.hash.startsWith('#/doc/'));
  }
  const detailText = await owner.evaluate(() => document.querySelector('#main')?.innerText || document.body.innerText);
  check('sample invoice opens in the real detail view', detailText.length > 80, detailText.slice(0, 240));
  if (!(await clickText(owner, 'button', 'Mark as sent'))) throw new Error('Mark as sent action was not found.');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const afterSendText = await owner.evaluate(() => document.body.innerText);
  check('invoice can be marked sent before publishing', /\nSent\n/.test(afterSendText), afterSendText.slice(0, 300));
  if (!(await clickText(owner, 'button', 'More'))) throw new Error('More actions menu was not found.');
  await owner.waitForFunction(() => document.body.innerText.includes('Share online'), { timeout: 10000 });
  if (!(await clickText(owner, 'button', 'Share online'))) throw new Error('Share online action was not found.');
  await owner.waitForFunction(() => document.body.innerText.includes('Public link'), { timeout: 30000 });
  const shareHref = await owner.$eval('a[href*="/site/"]', (a) => a.href).catch(() => '');
  const hrefs = await owner.$$eval('a[href]', (xs) => xs.map((a) => a.href).filter((h) => h.includes('puter.site') || h.includes('/site/')));
  check('share creates a hosting site and maps the .puter.site link to /site', !!shareHref && shareHref.startsWith(`http://127.0.0.1:${PUB_PORT}/site/`), JSON.stringify({ shareHref, hrefs }));

  const guestContext = await browser.createBrowserContext();
  const guest = await guestContext.newPage();
  const responses = [];
  guest.on('response', (r) => responses.push({ status: r.status(), url: r.url(), headers: r.headers() }));
  await guest.goto(shareHref, { waitUntil: 'networkidle2', timeout: 45000 });
  const text = await guest.$eval('body', (e) => e.innerText);
  check('anonymous public listener renders the shared invoice', text.length > 100 && /Invoice|Estimate/.test(text), text.slice(0, 300));
  const main = responses.find((r) => r.url === shareHref);
  check('public page has strict CSP and nosniff with no cookie', !!main && /default-src 'none'/.test(main.headers['content-security-policy'] || '') && main.headers['x-content-type-options'] === 'nosniff' && !main.headers['set-cookie']);
  check('guest context has no session cookie', (await guestContext.cookies()).length === 0);
  if (!(await clickText(owner, 'button', 'Stop sharing'))) throw new Error('Stop sharing action was not found.');
  await owner.waitForFunction(() => !document.body.innerText.includes('Public link'), { timeout: 15000 });
  const down = await fetch(shareHref);
  check('stop sharing removes public page', down.status === 404, `HTTP ${down.status}`);
  check('owner page reports no uncaught errors', errors.length === 0, errors.join('; '));
  await guestContext.close();
  await ownerContext.close();
} catch (err) {
  if (!steps.some((s) => !s.pass)) steps.push({ step: 'E2E run completed', pass: false, detail: err.stack || err.message });
  console.error(err.stack || err);
} finally {
  await browser?.close().catch(() => {});
  if (running) await running.close();
  config.set('hosting.enabled', prior.enabled);
  config.set('hosting.quota_bytes', prior.quota);
  config.set('public_url', prior.publicUrl);
  config.set('workers.public_base_url', prior.workerBase);
  db.run('DELETE FROM hub_sites WHERE user = ?', USER);
  db.run('DELETE FROM hub_kv WHERE user = ?', USER);
  db.run('DELETE FROM hub_grants WHERE user = ?', USER);
  if (store.getAccount(USER)) store.removeUser(USER, { deleteFiles: true });
}
const report = { at: new Date().toISOString(), pass: steps.length === 11 && steps.every((s) => s.pass), steps };
fs.writeFileSync(path.join(here, 'invoicing-e2e-results.json'), JSON.stringify(report, null, 2));
console.log(`${steps.filter((s) => s.pass).length}/${steps.length} steps passed; evidence in invoicing-e2e-results.json`);
if (!report.pass) process.exitCode = 1;
