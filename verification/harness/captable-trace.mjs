import { createRequire } from 'node:module';
const require = createRequire('D:/Stream/everything/platform/package.json');
const puppeteer = require('puppeteer-core');
const BASE = 'http://127.0.0.1:8080';
const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CAD-Request': '1' }, body: JSON.stringify({ username: 'vtest2', password: 'V3rify!Pass2' }) });
const token = (login.headers.get('set-cookie') || '').split(';')[0].split('=')[1];
const browser = await puppeteer.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-first-run'] });
const page = await browser.newPage();
page.on('console', m => { const t = String(m.text?.() ?? ''); if (!/Manifest|401|Failed to load resource/.test(t)) console.log('[pg]', t.slice(0, 400)); });
page.on('pageerror', e => console.log('[PAGEERR]', String(e?.stack || e).slice(0, 700)));
await page.setCookie({ name: 'cad_session', value: token, url: BASE });
await page.evaluateOnNewDocument(() => {
  window.__kvLog = [];
  const wrap = (obj) => {
    for (const k of Object.keys(obj)) {
      if (typeof obj[k] === 'function') {
        const orig = obj[k];
        obj[k] = async (...a) => {
          try { const r = await orig(...a); window.__kvLog.push(`${k}(${JSON.stringify(a).slice(0, 120)}) -> ${JSON.stringify(r)?.slice(0, 120)}`); return r; }
          catch (e) { window.__kvLog.push(`${k}(${JSON.stringify(a).slice(0, 120)}) THROW ${String(e).slice(0, 150)}`); throw e; }
        };
      }
    }
  };
  let tries = 0;
  const iv = setInterval(() => { if (window.puter?.kv) { wrap(window.puter.kv); clearInterval(iv); } else if (++tries > 200) clearInterval(iv); }, 10);
});
await page.goto(BASE + '/h/cap-table/', { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 6000));
const log = await page.evaluate(() => window.__kvLog);
console.log('--- kv calls:'); for (const l of log.slice(0, 40)) console.log(' ', l);
await browser.close();
