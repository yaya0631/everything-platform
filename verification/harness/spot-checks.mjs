import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('D:/Stream/everything/platform/package.json');
const puppeteer = require('puppeteer-core');
const BASE = 'http://127.0.0.1:8080';
const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CAD-Request': '1' }, body: JSON.stringify({ username: 'ftester8', password: 'F!Wave8-Pass' }) });
const token = (login.headers.get('set-cookie') || '').split(';')[0].split('=')[1];
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-first-run', '--mute-audio'] });
fs.mkdirSync('evidence/spot', { recursive: true });

// 1. sign-in page (signed-out view)
{
  const p = await (await browser.createBrowserContext()).newPage();
  await p.setViewport({ width: 1440, height: 900 });
  await p.goto(BASE + '/h/notes/', { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 2500));
  await p.screenshot({ path: 'evidence/spot/signin-page.png' });
  const t = await p.evaluate(() => (document.body.innerText || '').slice(0, 300));
  console.log('SIGNIN PAGE:', t.replace(/\n+/g, ' | ').slice(0, 250));
}

// 2. 3d app: python scripting (Pyodide)
{
  const p = await browser.newPage();
  await p.setViewport({ width: 1600, height: 1000 });
  await p.setCookie({ name: 'cad_session', value: token, url: BASE });
  const errs = [];
  p.on('console', m => { const t = String(m.text ?? ''); if (/pyodide|python|error|failed| CSP|Refused/i.test(t)) errs.push(t.slice(0, 250)); });
  p.on('requestfailed', r => errs.push('REQFAIL ' + r.url().slice(0, 120) + ' ' + (r.failure()?.errorText || '')));
  await p.goto(BASE + '/h/3d/', { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 6000));
  // find scripting/python UI
  const btns = await p.evaluate(() => [...document.querySelectorAll('button,[role=button],.tab,li')].map(e => (e.textContent || '').trim()).filter(t => /script|python|console|code/i.test(t)).slice(0, 8));
  console.log('3D scripting UI candidates:', JSON.stringify(btns));
  const pyBtn = await p.evaluateHandle(() => { const c = [...document.querySelectorAll('button,[role=button],.tab,li,a')].filter(e => /python|script/i.test((e.textContent || '') + (e.title || ''))); return c[0] || null; });
  if (pyBtn?.asElement()) {
    await pyBtn.asElement().click();
    await new Promise(r => setTimeout(r, 9000)); // pyodide download attempt window
    await p.screenshot({ path: 'evidence/spot/3d-python.png' });
    console.log('3D python panel opened; errors:', JSON.stringify(errs.slice(0, 6), null, 0).slice(0, 600));
  } else console.log('3D: no python button found; console:', JSON.stringify(errs.slice(0, 4)));
  await p.close();
}

// 3. meetings UI
{
  const p = await browser.newPage();
  await p.setViewport({ width: 1440, height: 900 });
  await p.setCookie({ name: 'cad_session', value: token, url: BASE });
  const errs = [];
  p.on('pageerror', e => errs.push('PAGEERR ' + String(e).slice(0, 150)));
  p.on('console', m => { const t = String(m.text ?? ''); if (m.type() === 'error') errs.push(t.slice(0, 150)); });
  await p.goto(BASE + '/h/meetings/', { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 5000));
  await p.screenshot({ path: 'evidence/spot/meetings.png' });
  const t = await p.evaluate(() => (document.body.innerText || '').slice(0, 400));
  console.log('MEETINGS:', t.replace(/\n+/g, ' | ').slice(0, 300));
  console.log('MEETINGS errors:', JSON.stringify(errs.slice(0, 5)));
  // try creating/joining
  const btn = await p.evaluateHandle(() => { const c = [...document.querySelectorAll('button')].filter(e => /start|create|join|new/i.test(e.textContent || '')); return c[0] || null; });
  if (btn?.asElement()) { await btn.asElement().click(); await new Promise(r => setTimeout(r, 5000)); await p.screenshot({ path: 'evidence/spot/meetings-after-click.png' }); const t2 = await p.evaluate(() => (document.body.innerText || '').slice(0, 400)); console.log('MEETINGS after click:', t2.replace(/\n+/g, ' | ').slice(0, 300)); console.log('errors after click:', JSON.stringify(errs.slice(0, 8))); }
  await p.close();
}
await browser.close();
