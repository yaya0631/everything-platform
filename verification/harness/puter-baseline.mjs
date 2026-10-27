import { createRequire } from 'node:module';
const require = createRequire('D:/Stream/everything/platform/package.json');
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--mute-audio'] });
const page = await browser.newPage();
const prompts = ['What is 17*23? Answer with just the number.', 'Write one sentence about the sun.', 'Summarize: The Eiffel Tower is in Paris. It was built in 1889. It is 330 meters tall.'];
const out = [];
try {
  await page.goto('https://developer.puter.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.evaluate(() => { const s = document.createElement('script'); s.src = 'https://js.puter.com/v2/'; document.head.appendChild(s); return new Promise(r => setTimeout(r, 4000)); });
  const has = await page.evaluate(() => typeof window.puter?.ai?.chat);
  const signedIn = await page.evaluate(() => { try { return window.puter?.auth?.isSignedIn?.(); } catch { return 'err'; } });
  out.push({ step: 'sdk-load', puterAiChat: has, signedIn });
  if (has === 'function') {
    for (const p of prompts) {
      const t0 = Date.now();
      try {
        const res = await page.evaluate(async (prompt) => {
          try {
            const r = await window.puter.ai.chat(prompt);
            return (r?.message?.content ?? String(r)).slice(0, 400);
          } catch (e) { return 'ERR: ' + String(e).slice(0, 250); }
        }, p);
        out.push({ prompt: p.slice(0, 40), ms: Date.now() - t0, res: String(res).slice(0, 300) });
      } catch (e) { out.push({ prompt: p.slice(0, 40), err: String(e).slice(0, 200) }); }
    }
  }
} catch (e) { out.push({ fatal: String(e).slice(0, 300) }); }
console.log(JSON.stringify(out, null, 1));
await browser.close();
