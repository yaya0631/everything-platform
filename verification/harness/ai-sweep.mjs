// In-app AI sweep: for each AI-bearing app, call the app's OWN ai surface via
// window.puter.ai.* in the app page (exactly what the app's buttons use) and
// record outcome + the user-visible pattern. No CAD_TEST. Real providers.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('D:/Stream/everything/platform/package.json');
const puppeteer = require('puppeteer-core');
const BASE = 'http://127.0.0.1:8080';
fs.mkdirSync('evidence/ai-sweep', { recursive: true });
const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CAD-Request': '1' }, body: JSON.stringify({ username: 'ftester8', password: 'F!Wave8-Pass' }) });
const token = (login.headers.get('set-cookie') || '').split(';')[0].split('=')[1];
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-first-run', '--mute-audio'] });

const apps = ['notes', 'contacts', 'documents', 'spreadsheet', 'presentation', 'photo-studio', 'vector-studio', 'video-studio', 'audio-studio', 'survey', 'help-desk', 'crm', 'parametric', '3d'];
const results = {};
for (const app of apps) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.setCookie({ name: 'cad_session', value: token, url: BASE });
  const r = { app };
  try {
    await page.goto(`${BASE}/h/${app}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // wait for shim (lazy loaders poke: 3d needs a click on assistant? keep simple wait)
    for (let i = 0; i < 24 && !(await page.evaluate(() => typeof window.puter === 'object').catch(() => false)); i++) await new Promise(s => setTimeout(s, 500));
    r.hasPuter = await page.evaluate(() => typeof window.puter).catch(() => 'gone');
    if (r.hasPuter === 'object') {
      r.ai = await page.evaluate(async () => {
        const out = {};
        const one = async (name, fn) => {
          const t0 = performance.now();
          try { const v = await fn(); out[name] = { ok: true, ms: Math.round(performance.now() - t0), snippet: String(typeof v === 'string' ? v : JSON.stringify(v?.message?.content ?? v?.src ?? v)).slice(0, 140) }; }
          catch (e) { out[name] = { ok: false, ms: Math.round(performance.now() - t0), err: String(e && e.message || e).slice(0, 180) }; }
        };
        await one('chat', () => window.puter.ai.chat('Reply with exactly: PONG'));
        await one('txt2img', () => window.puter.ai.txt2img('a red circle on white background'));
        await one('txt2speech', () => window.puter.ai.txt2speech('hello world'));
        await one('img2txt', () => window.puter.ai.img2txt('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='));
        return out;
      }).catch(e => ({ evalErr: String(e).slice(0, 150) }));
    }
  } catch (e) { r.loadErr = String(e).slice(0, 150); }
  await page.screenshot({ path: `evidence/ai-sweep/${app}.png` }).catch(() => {});
  results[app] = r;
  await page.close();
  console.log(app, JSON.stringify(r.ai || r.loadErr || r.hasPuter).slice(0, 220));
}
fs.writeFileSync('evidence/ai-sweep/results.json', JSON.stringify(results, null, 1));
await browser.close();
console.log('ai sweep done');
