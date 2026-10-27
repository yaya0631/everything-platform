// Generic core-action probe for tail apps: find New/Add, fill, save, reload, check.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('D:/Stream/everything/platform/package.json');
const puppeteer = require('puppeteer-core');
const BASE = 'http://127.0.0.1:8080';
fs.mkdirSync('evidence/tail', { recursive: true });
const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CAD-Request': '1' }, body: JSON.stringify({ username: 'ftester8', password: 'F!Wave8-Pass' }) });
const token = (login.headers.get('set-cookie') || '').split(';')[0].split('=')[1];
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-first-run', '--mute-audio'] });

async function probe(app, marker) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.setCookie({ name: 'cad_session', value: token, url: BASE });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e).slice(0, 120)));
  const out = { app };
  try {
    await page.goto(`${BASE}/h/${app}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 5000));
    // accept consent overlay if present
    const allow = await page.evaluateHandle(() => { const c = [...document.querySelectorAll('button')].filter(b => /^(allow|grant|yes|ok|accept)$/i.test(b.textContent.trim())); return c[0] || null; });
    if (allow?.asElement()) { await allow.asElement().click().catch(() => {}); await new Promise(r => setTimeout(r, 1500)); out.consentClicked = true; }
    // find a New/Add button
    const add = await page.evaluateHandle(() => { const c = [...document.querySelectorAll('button,[role=button],a')].filter(e => /^(new|add|\+|create|add .{0,20}|new .{0,20})/i.test((e.textContent || '').trim()) && (e.textContent || '').trim().length < 30); return c[0] || null; });
    if (!add?.asElement()) { out.addBtn = 'not-found'; }
    else {
      await add.asElement().click().catch(e => out.addClickErr = String(e).slice(0, 80));
      await new Promise(r => setTimeout(r, 2000));
      // fill text inputs with marker
      const filled = await page.evaluate((m) => {
        let n = 0;
        for (const i of document.querySelectorAll('input[type=text], input:not([type]), textarea')) {
          if (i.offsetParent === null) continue;
          if (/date|time|number|email|tel/i.test(i.type)) continue;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
          if (i.tagName === 'TEXTAREA') { i.value = m; i.dispatchEvent(new Event('input', { bubbles: true })); n++; }
          else if (setter) { setter.call(i, m); i.dispatchEvent(new Event('input', { bubbles: true })); n++; }
          if (n >= 2) break;
        }
        return n;
      }, marker).catch(e => -1);
      out.inputsFilled = filled;
      await page.screenshot({ path: `evidence/tail/${app}-form.png` }).catch(() => {});
      // click save/create/submit
      const save = await page.evaluateHandle(() => { const c = [...document.querySelectorAll('button,[role=button]')].filter(e => /^(save|create|add|submit|ok|done)/i.test((e.textContent || '').trim()) && e.offsetParent !== null); return c[c.length - 1] || null; });
      if (save?.asElement()) { await save.asElement().click().catch(() => {}); await new Promise(r => setTimeout(r, 2500)); out.saved = true; }
      else out.saveBtn = 'not-found';
      await page.screenshot({ path: `evidence/tail/${app}-saved.png` }).catch(() => {});
      // reload and search marker
      await page.reload({ waitUntil: 'domcontentloaded' });
      await new Promise(r => setTimeout(r, 5000));
      out.persisted = await page.evaluate((m) => (document.body.innerText || '').includes(m), marker);
    }
    out.pageErrors = errs.slice(0, 3);
    await page.screenshot({ path: `evidence/tail/${app}-reloaded.png` }).catch(() => {});
  } catch (e) { out.err = String(e).slice(0, 150); }
  await page.close();
  return out;
}
const results = [];
for (const [app, marker] of [['contacts', 'VT-Contact-Marker1'], ['records', 'VT-Record-Marker1'], ['expense', 'VT-Expense-Marker1'], ['contracts', 'VT-Contract-Marker1'], ['calendar', 'VT-Event-Marker1'], ['sudoku', 'VT-Sudoku-Marker1']]) {
  const r = await probe(app, marker);
  console.log(JSON.stringify(r));
  results.push(r);
}
fs.writeFileSync('evidence/tail/results.json', JSON.stringify(results, null, 1));
await browser.close();
