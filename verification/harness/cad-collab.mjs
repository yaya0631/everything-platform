// CAD live co-editing: two users, same drawing, watch sync.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('D:/Stream/everything/platform/package.json');
const puppeteer = require('puppeteer-core');
const BASE = 'http://127.0.0.1:8080';
fs.mkdirSync('evidence/cad', { recursive: true });

async function mkPage(browser, user, pass) {
  const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CAD-Request': '1' }, body: JSON.stringify({ username: user, password: pass }) });
  const token = (login.headers.get('set-cookie') || '').split(';')[0].split('=')[1];
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  await page.setCookie({ name: 'cad_session', value: token, url: BASE });
  return page;
}
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-first-run', '--mute-audio'] });
const A = await mkPage(browser, 'ftester8', 'F!Wave8-Pass');
const B = await mkPage(browser, 'vtest2', 'V3rify!Pass2');
const errsA = [], errsB = [];
A.on('pageerror', e => errsA.push(String(e).slice(0, 150)));
B.on('pageerror', e => errsB.push(String(e).slice(0, 150)));

// A: create a drawing, draw a rectangle, get its share state
await A.goto(BASE + '/h/cad/', { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 6000));
// Save with a name via Ctrl+S then typing a filename if dialog appears
await A.keyboard.down('Control'); await A.keyboard.press('s'); await A.keyboard.up('Control');
await new Promise(r => setTimeout(r, 2000));
// look for a filename input in a save dialog
const hasDialog = await A.evaluate(() => !!document.querySelector('input[placeholder*="name" i], dialog input, .dialog input, input.save'));
console.log('save dialog visible:', hasDialog);
if (hasDialog) {
  await A.evaluate(() => { const i = document.querySelector('input[placeholder*="name" i], dialog input, .dialog input, input.save'); i.value = 'collab-test'; });
  const saveBtn = await A.evaluateHandle(() => { const c = [...document.querySelectorAll('button')].filter(b => /^save$/i.test(b.textContent.trim())); return c[0] || null; });
  if (saveBtn?.asElement()) await saveBtn.asElement().click();
  await new Promise(r => setTimeout(r, 2500));
}
// Draw a rectangle in A
const rectBtn = await A.evaluateHandle(() => { const c = [...document.querySelectorAll('button,[role=button]')].filter(e => /^rectangle$/i.test((e.textContent || '').trim())); return c[0] || null; });
if (rectBtn?.asElement()) await rectBtn.asElement().click();
const cv = await A.$('canvas');
if (cv) {
  const bb = await cv.boundingBox();
  await A.mouse.move(bb.x + bb.width * 0.35, bb.y + bb.height * 0.35);
  await A.mouse.down();
  await A.mouse.move(bb.x + bb.width * 0.55, bb.y + bb.height * 0.55, { steps: 6 });
  await A.mouse.up();
}
await new Promise(r => setTimeout(r, 1500));
await A.screenshot({ path: 'evidence/cad/collab-A-drew.png' });
const wsA = await A.evaluate(() => performance.getEntriesByType('resource').filter(r => r.name.includes('ws') || r.name.startsWith('ws')).length);
console.log('A drew. ws resources:', wsA, 'errors:', errsA.slice(0, 3));

// B: list drawings and open the same file — via File > Open dialog is complex; try recent list in home panel
await B.goto(BASE + '/h/cad/', { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 6000));
const bText = await B.evaluate(() => (document.body.innerText || '').slice(0, 400));
console.log('B home shows:', bText.replace(/\n+/g, ' | ').slice(0, 250));
// try clicking any drawing named collab-test or a recent item
const item = await B.evaluateHandle(() => { const c = [...document.querySelectorAll('button, a, li, div[role=button]')].filter(e => /collab-test|Drawings/i.test(e.textContent || '') && e.childElementCount < 4); return c[0] || null; });
let opened = false;
if (item?.asElement()) { try { await item.asElement().click(); await new Promise(r => setTimeout(r, 3000)); opened = true; } catch {} }
console.log('B clicked drawings entry:', opened);
await B.screenshot({ path: 'evidence/cad/collab-B-view.png' });
// Check presence: does A see B's cursor? Sample A's DOM for presence indicators after B interaction
await new Promise(r => setTimeout(r, 3000));
const presence = await A.evaluate(() => { const t = document.body.innerText; return { mentionsVtest2: /vtest2/i.test(t), liveBadge: /live|online|editing now/i.test(t) }; });
console.log('A presence sees vtest2:', JSON.stringify(presence));
await A.screenshot({ path: 'evidence/cad/collab-A-after-B.png' });
console.log('errors A:', JSON.stringify(errsA.slice(0, 5)), 'errors B:', JSON.stringify(errsB.slice(0, 5)));
await browser.close();
