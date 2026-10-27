// Targeted probe: cap-table + email + fs-consent flows, interactive-ish.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire('D:/Stream/everything/platform/package.json');
const puppeteer = require('puppeteer-core');
const BASE = 'http://127.0.0.1:8080';
const OUT = path.resolve('evidence/probe');
fs.mkdirSync(OUT, { recursive: true });

const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CAD-Request': '1' }, body: JSON.stringify({ username: 'vtest1', password: 'V3rify!Pass1' }) });
const token = (login.headers.get('set-cookie') || '').split(';')[0].split('=')[1];
const browser = await puppeteer.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-first-run', '--mute-audio'] });

async function run(name, url, actions) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.setCookie({ name: 'cad_session', value: token, url: BASE });
  const log = [];
  page.on('console', m => log.push(`[${m.type()}] ${String(m.text?.() ?? '').slice(0, 300)}`));
  page.on('pageerror', e => log.push(`[PAGEERROR] ${String(e).slice(0, 300)}`));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 4000));
  try { await actions(page, log); } catch (e) { log.push(`[ACTION-FAIL] ${String(e).slice(0, 300)}`); }
  await page.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {});
  fs.writeFileSync(path.join(OUT, `${name}.log`), log.join('\n'));
  await page.close();
}

// cap-table: dump visible text + any consent overlay + what fs calls it made
await run('cap-table-probe', `${BASE}/h/cap-table/`, async (page, log) => {
  await new Promise(r => setTimeout(r, 5000));
  const body = await page.evaluate(() => document.body.innerText.slice(0, 1200));
  log.push('[BODY] ' + body.replace(/\n+/g, ' | ').slice(0, 800));
});

// email: confirm whoami error and check what auth functions the shim exposes
await run('email-probe', `${BASE}/h/email/`, async (page, log) => {
  await new Promise(r => setTimeout(r, 3000));
  const shimFns = await page.evaluate(() => {
    const p = window.puter;
    return p ? { authKeys: Object.keys(p.auth || {}), hasWhoami: typeof p.auth?.whoami, aiKeys: Object.keys(p.ai || {}), peer: typeof p.peer, events: typeof p.events, net: Object.keys(p.net || {}) } : null;
  });
  log.push('[SHIM] ' + JSON.stringify(shimFns));
});

// audio-studio consent: look for consent overlay and click allow, then re-check fs errors
await run('audio-studio-consent', `${BASE}/h/audio-studio/`, async (page, log) => {
  await new Promise(r => setTimeout(r, 3000));
  const overlay = await page.evaluate(() => {
    const txt = document.body.innerText;
    const btns = [...document.querySelectorAll('button')].map(b => b.innerText.trim()).filter(Boolean);
    return { hasConsent: /allow|grant|permission|consent/i.test(txt), btns: btns.slice(0, 15) };
  });
  log.push('[OVERLAY] ' + JSON.stringify(overlay).slice(0, 600));
});
await browser.close();
console.log('probe done');
