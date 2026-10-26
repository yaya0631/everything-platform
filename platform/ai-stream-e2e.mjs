#!/usr/bin/env node
/**
 * m2 acceptance in real Chromium: when the server or connection dies around an
 * AI stream, the shim must reject with one designed, named error
 * (`ai_stream_interrupted`) instead of surfacing the browser's raw
 * "TypeError: fetch failed". `fetch` is replaced inside the page, so no
 * provider and no real server kill is involved:
 *
 *   before  fetch rejects before the first byte (server killed early)
 *   mid     the NDJSON body errors after one chunk (server killed mid-stream)
 *   ok      a normal short stream still parses and finishes
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, '.tmp-ai-stream-e2e');
fs.rmSync(DATA, { recursive: true, force: true });
process.env.CAD_DATA_DIR = DATA;
process.env.CAD_TEST = '1';
const PORT = Number(process.env.AISTREAM_E2E_PORT || 18181);
const PUB_PORT = PORT + 1;
const USER = 'aie2e';
const PASS = 'ai-e2e-pass-1';
const chrome = [process.env.BROWSER_EXE, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
  .filter(Boolean).find((p) => { try { fs.accessSync(p); return true; } catch { return false; } });
if (!chrome) throw new Error('Chrome is required for the AI stream E2E.');

const [server, store, hub] = await Promise.all([
  import('./server.js'), import('./lib/store.js'), import('./lib/hub.js'),
]);

const steps = [];
const check = (step, ok, detail = '') => {
  steps.push({ step, pass: !!ok, detail: String(detail).slice(0, 1200) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step}${detail ? `: ${String(detail).slice(0, 300)}` : ''}`);
};

let running;
let browser;
try {
  running = await server.startServer({ port: PORT, publicPort: PUB_PORT, host: '127.0.0.1', tls: null });
  store.addUser(USER, PASS, { admin: true });
  hub.installFromDist('fixture', path.join(here, 'test', 'fixtures', 'hub', 'fixture-dist'), {
    sha: 'b'.repeat(40), source: 'import', title: 'Fixture',
  });
  const base = `http://127.0.0.1:${running.privatePort}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CAD-Request': '1' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const token = (login.headers.get('set-cookie') || '').split(';')[0].split('=')[1];
  check('throwaway owner signs in', login.ok && !!token, `HTTP ${login.status}`);

  browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-first-run', '--mute-audio'] });
  const ctx = await browser.createBrowserContext();
  await ctx.setCookie({ name: 'cad_session', value: token, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.evaluateOnNewDocument(() => {
    const orig = window.fetch.bind(window);
    window.__aiFail = 'ok';
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (!url.includes('/ai/chat')) return orig(input, init);
      const mode = window.__aiFail || 'ok';
      if (mode === 'before') return Promise.reject(new TypeError('fetch failed'));
      const enc = new TextEncoder();
      const lines = mode === 'mid'
        ? [{ type: 'text', text: 'Hel' }]
        : [
            { type: 'text', text: 'Hel' },
            { type: 'text', text: 'lo' },
            { message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' },
          ];
      const body = new ReadableStream({
        start(controller) {
          for (const line of lines) controller.enqueue(enc.encode(JSON.stringify(line) + '\n'));
          if (mode === 'mid') setTimeout(() => controller.error(new TypeError('network error')), 30);
          else controller.close();
        },
      });
      return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } }));
    };
  });
  await page.goto(`${base}/h/fixture/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(() => window.puter && window.puter.ai, { timeout: 30000 });
  check('the shim is live on the fixture page', true);

  const run = (mode) => page.evaluate(async (m) => {
    window.__aiFail = m;
    const out = { mode: m };
    try {
      const it = await puter.ai.chat('hi', { stream: true });
      out.gotIterator = true;
      const chunks = [];
      out.chunks = chunks;
      try {
        for await (const chunk of it) chunks.push(chunk && (chunk.text || (chunk.message && chunk.message.content) || chunk.type || 'object'));
        out.finished = true;
      } catch (e) {
        out.streamError = { name: e.name, code: e.code, message: e.message };
      }
    } catch (e) {
      out.startError = { name: e.name, code: e.code, message: e.message };
    }
    return out;
  }, mode);

  const before = await run('before');
  check('a dead server before the first byte is a named error (m2)',
    !!before.startError && before.startError.code === 'ai_stream_interrupted' && /interrupted/i.test(before.startError.message) && !/fetch failed/i.test(before.startError.message),
    JSON.stringify(before));

  const mid = await run('mid');
  check('a stream that dies mid-body is a named error (m2)',
    !!mid.streamError && mid.streamError.code === 'ai_stream_interrupted' && /interrupted/i.test(mid.streamError.message),
    JSON.stringify(mid));
  check('chunks before the break still reach the app', Array.isArray(mid.chunks) && mid.chunks.includes('Hel'), JSON.stringify(mid.chunks));

  const ok = await run('ok');
  check('a normal stream is unaffected', !!ok.finished && Array.isArray(ok.chunks) && ok.chunks.includes('Hello'), JSON.stringify(ok));
  // The fixture's bundle registers a service worker that the fixture does not
  // ship; that 404 is fixture noise, not stream handling.
  const realErrors = errors.filter((e) => !/ServiceWorker|sw\.js/i.test(e));
  check('no uncaught page errors', realErrors.length === 0, realErrors.join('; '));

  await ctx.close();
} catch (err) {
  steps.push({ step: 'E2E run completed', pass: false, detail: err.stack || err.message });
  console.error(err.stack || err);
} finally {
  await browser?.close().catch(() => {});
  if (running) await running.close();
  fs.rmSync(DATA, { recursive: true, force: true });
}
const report = { at: new Date().toISOString(), pass: steps.every((s) => s.pass), steps };
fs.writeFileSync(path.join(here, 'ai-stream-e2e-results.json'), JSON.stringify(report, null, 2));
console.log(`${steps.filter((s) => s.pass).length}/${steps.length} steps passed; evidence in ai-stream-e2e-results.json`);
if (!report.pass) process.exitCode = 1;
