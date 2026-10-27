import { createRequire } from 'node:module';
const require = createRequire('D:/Stream/everything/platform/package.json');
const puppeteer = require('puppeteer-core');
const BASE = 'http://127.0.0.1:8080';
const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CAD-Request': '1' }, body: JSON.stringify({ username: 'vtest1', password: 'V3rify!Pass1' }) });
const token = (login.headers.get('set-cookie') || '').split(';')[0].split('=')[1];
const browser = await puppeteer.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-first-run'] });
const page = await browser.newPage();
page.on('console', m => { const t = String(m.text?.() ?? ''); if (!/Manifest|401|Failed to load resource/.test(t)) console.log('[pg]', t.slice(0, 250)); });
page.on('pageerror', e => console.log('[PAGEERR]', String(e).slice(0, 250)));
await page.setCookie({ name: 'cad_session', value: token, url: BASE });
await page.goto(BASE + '/h/cap-table/', { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 5000));
const res = await page.evaluate(async () => {
  const out = {};
  for (const k of ['captable:companies:v1', 'captable:rounds:v1', 'totally_missing']) {
    try { out[k] = JSON.stringify(await window.puter.kv.get(k)); } catch (e) { out[k] = 'THROW: ' + String(e).slice(0, 200); }
  }
  try { out.setObj = JSON.stringify(await window.puter.kv.set('captable:companies:v1', { a: 1 })); } catch (e) { out.setObj = 'THROW: ' + String(e).slice(0, 200); }
  try { out.afterSet = String(await window.puter.kv.get('captable:companies:v1')).slice(0, 150); } catch (e) { out.afterSet = 'THROW: ' + String(e).slice(0, 200); }
  // fs side too
  try { out.fsMkdir = JSON.stringify(await window.puter.fs.mkdir('captable-test', { createMissingParents: true })); } catch (e) { out.fsMkdir = 'THROW: ' + String(e).slice(0, 200); }
  return out;
});
console.log(JSON.stringify(res, null, 1));
await browser.close();
