// Documents-suite compact deep probe: spreadsheet formulas, documents text, presentation slides, pdf open.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('D:/Stream/everything/platform/package.json');
const puppeteer = require('puppeteer-core');
const BASE = 'http://127.0.0.1:8080';
fs.mkdirSync('evidence/docs-suite', { recursive: true });
const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CAD-Request': '1' }, body: JSON.stringify({ username: 'ftester8', password: 'F!Wave8-Pass' }) });
const token = (login.headers.get('set-cookie') || '').split(';')[0].split('=')[1];
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-first-run', '--mute-audio'] });
const results = {};

async function newPage() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950 });
  await page.setCookie({ name: 'cad_session', value: token, url: BASE });
  page.on('pageerror', e => (results._pageErrors ||= []).push(String(e).slice(0, 120)));
  return page;
}

// --- spreadsheet: click cells, type values, formula, check computed
{
  const page = await newPage();
  const r = {};
  try {
    await page.goto(BASE + '/h/spreadsheet/', { waitUntil: 'domcontentloaded' });
    await new Promise(s => setTimeout(s, 8000));
    // heuristics: spreadsheet grids vary; try clicking where A1 header suggests or first cell element
    const gridInfo = await page.evaluate(() => {
      const canvases = document.querySelectorAll('canvas').length;
      const tables = document.querySelectorAll('table').length;
      const gridEls = document.querySelectorAll('[class*=grid], [class*=cell], [data-cell], [role=gridcell]').length;
      const inputs = document.querySelectorAll('input, textarea, [contenteditable]').length;
      return { canvases, tables, gridEls, inputs, sampleCells: [...document.querySelectorAll('[role=gridcell], [class*=cell]')].slice(0, 3).map(e => e.className) };
    });
    r.grid = gridInfo;
    // click center-ish of first canvas or first grid cell to focus, then type
    const cv = await page.$('canvas');
    if (cv) {
      const bb = await cv.boundingBox();
      await page.mouse.click(bb.x + 120, bb.y + 80);
      await page.keyboard.type('10', { delay: 30 });
      await page.keyboard.press('Enter');
      await page.mouse.click(bb.x + 120, bb.y + 80);
      // try moving down via keyboard navigation
      await page.keyboard.press('ArrowDown');
      await page.keyboard.type('32', { delay: 30 });
      await page.keyboard.press('Enter');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.type('=SUM(A1:A2)', { delay: 30 });
      await page.keyboard.press('Enter');
      await new Promise(s => setTimeout(s, 2500));
      await page.screenshot({ path: 'evidence/docs-suite/spreadsheet-formula.png' });
      const text = await page.evaluate(() => (document.body.innerText || ''));
      r.sumVisible = /42/.test(text);
      r.hasFormulaEcho = text.includes('SUM');
    }
  } catch (e) { r.err = String(e).slice(0, 200); }
  results.spreadsheet = r;
  await page.close();
}

// --- documents: type into editor, save, reload
{
  const page = await newPage();
  const r = {};
  try {
    await page.goto(BASE + '/h/documents/', { waitUntil: 'domcontentloaded' });
    await new Promise(s => setTimeout(s, 8000));
    const ed = await page.$('[contenteditable=true], .editor, [class*=canvas], textarea');
    r.editorFound = !!ed;
    if (ed) {
      await ed.click().catch(() => {});
      await page.keyboard.type('VT-DOC-MARKER verification paragraph.', { delay: 15 });
      await new Promise(s => setTimeout(s, 1500));
      await page.screenshot({ path: 'evidence/docs-suite/documents-typed.png' });
      await page.keyboard.down('Control'); await page.keyboard.press('s'); await page.keyboard.up('Control');
      await new Promise(s => setTimeout(s, 3000));
      await page.screenshot({ path: 'evidence/docs-suite/documents-save.png' });
      const dlg = await page.evaluate(() => (document.body.innerText || '').slice(0, 300));
      r.saveDialogText = dlg.replace(/\n+/g, '|').slice(0, 220);
      const nameInput = await page.$('input[placeholder*="name" i], dialog input');
      if (nameInput) {
        await nameInput.evaluate ? null : null;
        await page.evaluate(() => { const i = document.querySelector('input[placeholder*="name" i], dialog input'); if (i) { i.focus(); } });
        await page.keyboard.type('vt-verify-doc', { delay: 20 });
        const sb = await page.evaluateHandle(() => { const c = [...document.querySelectorAll('button')].filter(b => /^save$/i.test(b.textContent.trim())); return c[0] || null; });
        if (sb?.asElement()) { await sb.asElement().click(); await new Promise(s => setTimeout(s, 3000)); r.savedWithName = true; }
      }
      await page.reload({ waitUntil: 'domcontentloaded' });
      await new Promise(s => setTimeout(s, 6000));
      const back = await page.evaluate(() => (document.body.innerText || ''));
      r.markerAfterReload = back.includes('VT-DOC-MARKER');
      await page.screenshot({ path: 'evidence/docs-suite/documents-reloaded.png' });
    }
  } catch (e) { r.err = String(e).slice(0, 200); }
  results.documents = r;
  await page.close();
}

// --- presentation: add slide with text (toolbar heuristics)
{
  const page = await newPage();
  const r = {};
  try {
    await page.goto(BASE + '/h/presentation/', { waitUntil: 'domcontentloaded' });
    await new Promise(s => setTimeout(s, 8000));
    const slideBtn = await page.evaluateHandle(() => { const c = [...document.querySelectorAll('button,[role=button]')].filter(e => /new slide|add slide|slide/i.test(e.textContent || '') && e.textContent.trim().length < 20); return c[0] || null; });
    r.slideBtn = !!slideBtn?.asElement;
    const before = await page.evaluate(() => document.querySelectorAll('[class*=slide]').length);
    if (slideBtn?.asElement()) { await slideBtn.asElement().click(); await new Promise(s => setTimeout(s, 1500)); }
    const after = await page.evaluate(() => document.querySelectorAll('[class*=slide]').length);
    r.slidesBefore = before; r.slidesAfter = after;
    await page.screenshot({ path: 'evidence/docs-suite/presentation.png' });
  } catch (e) { r.err = String(e).slice(0, 200); }
  results.presentation = r;
  await page.close();
}

// --- pdf: app opens with empty doc; try a toolbar tool + export presence
{
  const page = await newPage();
  const r = {};
  try {
    await page.goto(BASE + '/h/pdf/', { waitUntil: 'domcontentloaded' });
    await new Promise(s => setTimeout(s, 8000));
    r.toolbar = await page.evaluate(() => [...document.querySelectorAll('button,[role=button]')].map(b => b.textContent.trim()).filter(Boolean).filter(t => t.length < 22).slice(0, 18));
    await page.screenshot({ path: 'evidence/docs-suite/pdf.png' });
  } catch (e) { r.err = String(e).slice(0, 200); }
  results.pdf = r;
  await page.close();
}
fs.writeFileSync('evidence/docs-suite/results.json', JSON.stringify(results, null, 1));
console.log(JSON.stringify(results, null, 1).slice(0, 2600));
await browser.close();
