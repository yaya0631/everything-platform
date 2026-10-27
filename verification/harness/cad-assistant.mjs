import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('D:/Stream/everything/platform/package.json');
const puppeteer = require('puppeteer-core');
const BASE = 'http://127.0.0.1:8080';
const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CAD-Request': '1' }, body: JSON.stringify({ username: 'ftester8', password: 'F!Wave8-Pass' }) });
const token = (login.headers.get('set-cookie') || '').split(';')[0].split('=')[1];
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-first-run', '--mute-audio'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
await page.setCookie({ name: 'cad_session', value: token, url: BASE });
const log = [];
page.on('console', m => { const t = String(m.text ?? ''); if (!/Manifest|401|Failed to load|text\(\)/.test(t)) log.push('[c] ' + t.slice(0, 250)); });
await page.goto(BASE + '/h/cad/', { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 5000));
// Click the View tab
const viewTab = await page.evaluateHandle(() => { const c = [...document.querySelectorAll('button,[role=tab],[role=button],.tab,*')].filter(e => e.childElementCount === 0 && (e.textContent || '').trim() === 'View'); return c[c.length - 1] || c[0] || null; });
if (viewTab?.asElement()) { await viewTab.asElement().click(); log.push('clicked View tab'); await new Promise(r => setTimeout(r, 1200)); }
const aBtn = await page.evaluateHandle(() => { const c = [...document.querySelectorAll('button,[role=button]')].filter(e => /assistant/i.test(e.textContent || '')); return c[0] || null; });
if (aBtn?.asElement()) { await aBtn.asElement().click(); log.push('clicked Assistant'); } else { log.push('STILL no Assistant btn'); }
await new Promise(r => setTimeout(r, 2500));
await page.screenshot({ path: 'evidence/cad/06-assistant-panel.png' });
const ta = await page.$('textarea, [contenteditable=true]');
if (ta) {
  await ta.type('Draw a rectangle from 0,0 to 200,100', { delay: 8 });
  await page.keyboard.press('Enter');
  log.push('prompt sent, waiting…');
  const t0 = Date.now();
  for (let i = 0; i < 45; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const snap = await page.evaluate(() => {
      const err = [...document.querySelectorAll('.error, [class*=error], [class*=Error]')].map(e => e.textContent?.trim()).filter(Boolean).slice(0, 2);
      const ents = document.querySelectorAll('canvas').length;
      const txt = document.body.innerText;
      return { err, ents, hasReply: /rectangle/i.test(txt) && /added|created|drew|drew|done/i.test(txt) };
    });
    if (snap.err?.length) { log.push('AI-ERR[' + (Date.now() - t0) + 'ms]: ' + JSON.stringify(snap.err).slice(0, 400)); break; }
    if (snap.hasReply && Date.now() - t0 > 6000) { log.push('AI-OK[' + (Date.now() - t0) + 'ms] reply mentions rectangle added'); break; }
  }
  await page.screenshot({ path: 'evidence/cad/07-ai-result.png' });
} else log.push('no textarea after Assistant');
fs.writeFileSync('evidence/cad/assistant.log', log.join('\n'));
console.log(log.join('\n').slice(0, 2000));
await browser.close();
