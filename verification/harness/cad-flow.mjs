// CAD flagship flow: draw, save, reopen, AI assistant with tools.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire('D:/Stream/everything/platform/package.json');
const puppeteer = require('puppeteer-core');
const BASE = 'http://127.0.0.1:8080';
const OUT = path.resolve('evidence/cad');
fs.mkdirSync(OUT, { recursive: true });
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CAD-Request': '1' }, body: JSON.stringify({ username: 'ftester8', password: 'F!Wave8-Pass' }) });
const token = (login.headers.get('set-cookie') || '').split(';')[0].split('=')[1];
if (!token) { console.log('LOGIN FAILED'); process.exit(1); }
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--mute-audio'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
await page.setCookie({ name: 'cad_session', value: token, url: BASE });
const log = [];
page.on('console', m => { const t = String(m.text?.() ?? ''); if (!/Manifest|favicon/.test(t)) log.push('[console.' + m.type() + '] ' + t.slice(0, 300)); });
page.on('pageerror', e => log.push('[PAGEERR] ' + String(e).slice(0, 300)));
page.on('response', r => { if (r.status() >= 400) log.push('[HTTP ' + r.status() + '] ' + r.url().slice(0, 160)); });

await page.goto(BASE + '/h/cad/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise(r => setTimeout(r, 6000));
await page.screenshot({ path: path.join(OUT, '01-loaded.png') });
const booted = await page.evaluate(() => ({ title: document.title, hasCanvas: !!document.querySelector('canvas'), bodySnippet: (document.body.innerText || '').slice(0, 300) }));
log.push('[BOOT] ' + JSON.stringify(booted));

// Find ribbon buttons
const ribbon = await page.evaluate(() => [...document.querySelectorAll('button, [role=button], .ribbon *, tool-bar *')].map(e => e.textContent?.trim()).filter(t => t && t.length < 24).slice(0, 60));
log.push('[RIBBON] ' + JSON.stringify(ribbon));

// Try to click a rectangle tool then drag on canvas
try {
  const rectBtn = await page.evaluateHandle(() => {
    const cands = [...document.querySelectorAll('button,[role=button],a,div')].filter(e => /^(rect|rectangle)$/i.test((e.textContent || '').trim()) || (e.title || e.getAttribute('aria-label') || '').match(/rect/i));
    return cands[0] || null;
  });
  if (rectBtn && rectBtn.asElement()) { await rectBtn.asElement().click(); log.push('[TOOL] clicked rectangle tool'); }
  else log.push('[TOOL] rectangle button not found by name — listing alternatives above');
  const cv = await page.$('canvas');
  const bb = await cv.boundingBox();
  await page.mouse.move(bb.x + bb.width * 0.4, bb.y + bb.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(bb.x + bb.width * 0.6, bb.y + bb.height * 0.6, { steps: 8 });
  await page.mouse.up();
  log.push('[DRAW] dragged on canvas');
  await new Promise(r => setTimeout(r, 1500));
  await page.screenshot({ path: path.join(OUT, '02-after-draw.png') });
} catch (e) { log.push('[DRAW-FAIL] ' + String(e).slice(0, 250)); }

// Save via UI (Ctrl+S or File>Save)
try {
  await page.keyboard.down('Control'); await page.keyboard.press('s'); await page.keyboard.up('Control');
  await new Promise(r => setTimeout(r, 2500));
  await page.screenshot({ path: path.join(OUT, '03-after-ctrl-s.png') });
  const dlg = await page.evaluate(() => (document.body.innerText || '').slice(0, 400));
  log.push('[AFTER-SAVE] ' + dlg.replace(/\n+/g, ' | ').slice(0, 350));
} catch (e) { log.push('[SAVE-FAIL] ' + String(e).slice(0, 200)); }

// AI assistant
try {
  const aiBtn = await page.evaluateHandle(() => {
    const cands = [...document.querySelectorAll('button,[role=button],a')].filter(e => /assist|ai/i.test((e.textContent || '') + (e.title || '') + (e.getAttribute('aria-label') || '')));
    return cands[0] || null;
  });
  if (aiBtn && aiBtn.asElement()) {
    await aiBtn.asElement().click();
    await new Promise(r => setTimeout(r, 2000));
    await page.screenshot({ path: path.join(OUT, '04-ai-panel.png') });
    const panel = await page.evaluate(() => (document.body.innerText || '').slice(0, 500));
    log.push('[AI-PANEL] ' + panel.replace(/\n+/g, ' | ').slice(0, 400));
    // type a prompt
    const ta = await page.$('textarea, [contenteditable=true]');
    if (ta) {
      await ta.type('Draw a rectangle from 0,0 to 200,100', { delay: 10 });
      await page.keyboard.press('Enter');
      const t0 = Date.now();
      let done = false;
      while (!done && Date.now() - t0 < 90000) {
        await new Promise(r => setTimeout(r, 3000));
        done = await page.evaluate(() => { const t = document.body.innerText; return /done|drew|added|rectangle created|error|failed/i.test(t); });
      }
      await page.screenshot({ path: path.join(OUT, '05-ai-result.png') });
      const after = await page.evaluate(() => (document.body.innerText || '').slice(0, 600));
      log.push('[AI-AFTER ' + (Date.now() - t0) + 'ms] ' + after.replace(/\n+/g, ' | ').slice(0, 500));
    } else log.push('[AI] no textarea found');
  } else log.push('[AI] assistant button not found');
} catch (e) { log.push('[AI-FAIL] ' + String(e).slice(0, 250)); }

fs.writeFileSync(path.join(OUT, 'cad-flow.log'), log.join('\n'));
console.log(log.join('\n').slice(0, 4000));
await browser.close();
