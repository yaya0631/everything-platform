#!/usr/bin/env node
/**
 * Chromium acceptance for the local engines, through the real hub shim:
 *
 *   OCR     puter.ai.img2txt(dataUrl) returns the text Tesseract read;
 *   speech  puter.ai.txt2speech(text) resolves an <audio> whose blob is a
 *           playable RIFF/WAV from Piper;
 *   honest  txt2img and txt2vid reject with engine_missing and the documented
 *           cloud-only/not-configured message (never a fake success).
 *
 * Run: node engine-e2e.mjs   (needs Chrome and data/engines installed; evidence
 * lands in engine-e2e-results.json)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, '.tmp-engine-e2e');
fs.rmSync(DATA, { recursive: true, force: true });
process.env.CAD_DATA_DIR = DATA;
process.env.CAD_TEST = '1';
const PORT = Number(process.env.ENGINE_E2E_PORT || 18211);
const PUB_PORT = PORT + 1;
const USER = 'enginee2e';
const PASS = 'engine-e2e-pass-1';
const chrome = [
  process.env.BROWSER_EXE,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean).find((p) => { try { fs.accessSync(p); return true; } catch { return false; } });
if (!chrome) throw new Error('Chrome is required for the engine E2E.');

const [server, store, hub, config] = await Promise.all([
  import('./server.js'), import('./lib/store.js'), import('./lib/hub.js'), import('./lib/config.js'),
]);

const steps = [];
const check = (step, ok, detail = '') => {
  steps.push({ step, pass: !!ok, detail: String(detail).slice(0, 1600) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step}${detail ? `: ${String(detail).slice(0, 400)}` : ''}`);
};

async function login(base, username, password) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CAD-Request': '1' },
    body: JSON.stringify({ username, password }),
  });
  const token = (res.headers.get('set-cookie') || '').split(';')[0].split('=')[1];
  if (!res.ok || !token) throw new Error(`login ${username}: HTTP ${res.status}`);
  return token;
}

let running;
let browser;
try {
  running = await server.startServer({ port: PORT, publicPort: PUB_PORT, host: '127.0.0.1', tls: null });
  const engines = path.join(here, 'data', 'engines');
  config.set('hubTessdataDir', path.join(engines, 'tesseract'));
  config.set('hubTessCacheDir', path.join(engines, 'cache'));
  config.set('hubOcrLanguage', 'eng');
  config.set('hubPiperBin', path.join(engines, 'piper', 'piper.exe'));
  config.set('hubPiperModel', path.join(engines, 'piper', 'en_US-ljspeech-medium.onnx'));
  config.set('hubPiperConfig', path.join(engines, 'piper', 'en_US-ljspeech-medium.onnx.json'));
  config.set('hubPiperEspeak', path.join(engines, 'piper', 'espeak-ng-data'));
  config.set('hubOcrEnabled', true);
  config.set('hubTtsEnabled', true);

  store.addUser(USER, PASS, { admin: true });
  hub.installFromDist('engine-probe', path.join(here, 'test', 'fixtures', 'hub', 'peer-dist'), {
    sha: 'f'.repeat(40), source: 'import', title: 'Engine probe',
  });
  // Two real builds, not a fixture: expense is the OCR caller and audio-studio
  // is the speech caller. Their own CSP and bundles must carry the shim.
  hub.installFromDist('expense', path.join(here, '..', 'upstream', 'src', 'expense', 'dist'), {
    sha: 'd'.repeat(40), source: 'import', title: 'Expense',
  });
  hub.installFromDist('audio-studio', path.join(here, '..', 'upstream', 'src', 'audio-studio', 'dist'), {
    sha: 'c'.repeat(40), source: 'import', title: 'Audio Studio',
  });
  const base = `http://127.0.0.1:${running.privatePort}`;
  const token = await login(base, USER, PASS);
  check('throwaway account signs in', !!token);

  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-first-run', '--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.createBrowserContext();
  await ctx.setCookie({ name: 'cad_session', value: token, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/h/engine-probe/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => typeof puter !== 'undefined' && typeof puter.ai?.img2txt === 'function', { timeout: 45000 });
  check('the served app exposes the real puter.ai shim', true);

  const ocrImage = `data:image/png;base64,${fs.readFileSync(path.join(here, 'test', 'fixtures', 'ocr-text.png')).toString('base64')}`;
  const ocr = await page.evaluate(async (image) => {
    try {
      return { text: await puter.ai.img2txt(image) };
    } catch (e) {
      return { error: e.message, code: e.code };
    }
  }, ocrImage);
  check('img2txt reads the local test image', !ocr.error && /LOCAL OCR WORKS/i.test(ocr.text), JSON.stringify(ocr));

  const tts = await page.evaluate(async () => {
    try {
      const audio = await puter.ai.txt2speech('Local speech works in the browser.');
      const blob = await (await fetch(audio.src)).blob();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return {
        tag: audio.tagName,
        blob: audio.src.startsWith('blob:'),
        bytes: bytes.length,
        riff: String.fromCharCode(...bytes.slice(0, 4)),
        ready: audio.readyState >= 1,
      };
    } catch (e) {
      return { error: e.message, code: e.code };
    }
  });
  check('txt2speech resolves a playable WAV audio element',
    !tts.error && tts.tag === 'AUDIO' && tts.blob && tts.bytes > 1000 && tts.riff === 'RIFF',
    JSON.stringify(tts));

  const img = await page.evaluate(async () => {
    try {
      await puter.ai.txt2img('a cat');
      return { ok: true };
    } catch (e) {
      return { code: e.code, message: e.message };
    }
  });
  check('txt2img refuses with the cloud-only explanation',
    img.code === 'engine_missing' && /cloud-only|Admin/.test(img.message), JSON.stringify(img));

  const vid = await page.evaluate(async () => {
    try {
      await puter.ai.txt2vid('a cat');
      return { ok: true };
    } catch (e) {
      return { code: e.code, message: e.message };
    }
  });
  check('txt2vid refuses instead of pretending', vid.code === 'engine_missing' && /video/i.test(vid.message), JSON.stringify(vid));

  // Real builds, real CSP: the fixture above proves the adapters; these pages
  // prove the same calls survive an actual app's bundle and policy.
  for (const app of ['expense', 'audio-studio']) {
    const p = await ctx.newPage();
    const appErrors = [];
    p.on('pageerror', (e) => appErrors.push(e.message));
    let result;
    try {
      await p.goto(`${base}/h/${app}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await p.waitForFunction(() => typeof puter !== 'undefined' && typeof puter.ai?.img2txt === 'function', { timeout: 45000 });
      if (app === 'expense') {
        result = await p.evaluate(async (image) => {
          try { return { text: await puter.ai.img2txt(image) }; }
          catch (e) { return { error: e.message, code: e.code }; }
        }, ocrImage);
      } else {
        result = await p.evaluate(async () => {
          try {
            const audio = await puter.ai.txt2speech('Speech in a real app.');
            const blob = await (await fetch(audio.src)).blob();
            const bytes = new Uint8Array(await blob.arrayBuffer());
            return {
              tag: audio.tagName,
              blob: audio.src.startsWith('blob:'),
              bytes: bytes.length,
              riff: String.fromCharCode(...bytes.slice(0, 4)),
            };
          } catch (e) {
            return { error: e.message, code: e.code };
          }
        });
      }
    } catch (e) {
      result = { error: String(e?.message || e) };
    }
    const ok = app === 'expense'
      ? !result.error && /LOCAL OCR WORKS/i.test(result.text || '')
      : !result.error && result.tag === 'AUDIO' && result.blob && result.bytes > 1000 && result.riff === 'RIFF';
    check(`real ${app} page: ${app === 'expense' ? 'img2txt reads the image' : 'txt2speech returns a WAV'}`,
      ok, `${JSON.stringify(result)}${appErrors.length ? ` pageErrors=${appErrors.slice(0, 3).join(' | ')}` : ''}`);
    await p.close();
  }

  check('no page errors', errors.length === 0, errors.join(' | '));
} finally {
  try { await browser?.close(); } catch { /* already gone */ }
  try { await running?.close(); } catch { /* already gone */ }
  fs.rmSync(DATA, { recursive: true, force: true });
}

const failed = steps.filter((s) => !s.pass);
const evidence = {
  ranAt: new Date().toISOString(),
  runner: 'engine-e2e.mjs',
  chrome,
  steps,
  passed: steps.length - failed.length,
  total: steps.length,
  ok: failed.length === 0,
};
fs.writeFileSync(path.join(here, 'engine-e2e-results.json'), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`\n${evidence.passed}/${evidence.total} engine browser checks passed`);
process.exit(evidence.ok ? 0 : 1);
