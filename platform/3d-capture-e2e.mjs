/**
 * 3D assistant capture: the shared WebGL drawing buffer must survive the
 * browser's compositing step, or the assistant's "What the assistant saw"
 * image is pure black even though the viewport looks fine. The platform keeps
 * preserveDrawingBuffer on at serve time; this test proves the served bundle
 * carries that rule and that a copy taken after compositing still has pixels.
 *
 * Run from platform/: node 3d-capture-e2e.mjs
 * Nothing touches data/: test/helpers.js starts with a fresh CAD_DATA_DIR.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { start, cleanup, client } from './test/helpers.js';
import * as store from './lib/store.js';
import * as hub from './lib/hub.js';
import puppeteer from 'puppeteer-core';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);
const chromeExe = CHROME_CANDIDATES.find((p) => {
  try { fs.accessSync(p); return true; } catch { return false; }
});
if (!chromeExe) {
  console.error(`3d-capture-e2e: no Chrome found (${CHROME_CANDIDATES.join(', ')})`);
  process.exit(2);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const running = await start();
let browser;
try {
  store.addUser('viewer', 'viewer-password', { admin: true });
  const c = client(running.base);
  await c.login('viewer', 'viewer-password');
  hub.installFromDist('3d', path.join('data', 'hub', 'apps', '3d'), {
    sha: 'e'.repeat(40),
    source: 'import',
    title: '3D',
  });

  browser = await puppeteer.launch({ executablePath: chromeExe, headless: true, args: ['--no-first-run', '--mute-audio', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
  const session = c.cookie.split(';')[0].split('=').slice(1).join('=');
  await page.setCookie({ name: 'cad_session', value: session, url: running.base, path: '/' });
  await page.goto(`${running.base}/h/3d/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(2500);
  // First run: a setup dialog, then the splash's "General" entry.
  await page.evaluate(() => {
    [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Continue')?.click();
  });
  await wait(700);
  await page.evaluate(() => {
    [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'General')?.click();
  });
  await page.waitForFunction(() => {
    const canvas = document.querySelector('canvas.gl-canvas');
    return canvas && canvas.width > 300 && canvas.height > 300;
  }, { timeout: 30000 });
  await wait(700);

  const result = await page.evaluate(async () => {
    const bundle = [...document.scripts].map((s) => s.src).find((s) => /\/assets\/index-.*\.js$/.test(s));
    const served = bundle ? await (await fetch(bundle)).text() : '';
    const canvas = document.querySelector('canvas.gl-canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const attrs = gl?.getContextAttributes?.() ?? null;

    const views = [...document.querySelectorAll('.view3d')].filter((v) => v.offsetWidth > 100 && v.offsetHeight > 100);
    const view = views.sort((a, b) => b.offsetWidth * b.offsetHeight - a.offsetWidth * a.offsetHeight)[0];
    const measure = (el) => {
      const g = el.getContext('2d');
      const data = g.getImageData(0, 0, el.width, el.height).data;
      let sum = 0;
      let nonblack = 0;
      for (let i = 0; i < data.length; i += 4) {
        const l = (data[i] + data[i + 1] + data[i + 2]) / 3;
        sum += l;
        if (l > 5) nonblack++;
      }
      return { w: el.width, h: el.height, avg: sum / (data.length / 4), nonblack };
    };

    // Draw the current scene, then let the browser composite it. With
    // preserveDrawingBuffer:false this next copy is pure black; with the
    // serve-time rule it still holds the rendered frame.
    window.app.changed('doc', 'ui');
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const rect = view.getBoundingClientRect();
    const base = canvas.getBoundingClientRect();
    const sx = canvas.width / base.width;
    const sy = canvas.height / base.height;
    const w = Math.round(rect.width * sx);
    const h = Math.round(rect.height * sy);
    const copy = document.createElement('canvas');
    copy.width = w;
    copy.height = h;
    copy.getContext('2d').drawImage(
      canvas,
      Math.round((rect.left - base.left) * sx),
      Math.round((rect.top - base.top) * sy),
      w,
      h,
      0,
      0,
      w,
      h,
    );
    return {
      servedOld: served.includes('preserveDrawingBuffer:!1,stencil:!0'),
      servedNew: served.includes('preserveDrawingBuffer:!0,stencil:!0'),
      attrs,
      copy: measure(copy),
    };
  });

  assert.equal(result.servedOld, false, 'the served 3D bundle still asks for a non-preserved drawing buffer');
  assert.equal(result.servedNew, true, 'the served 3D bundle is missing the preserveDrawingBuffer rule');
  assert.equal(result.attrs?.preserveDrawingBuffer, true, `context attrs: ${JSON.stringify(result.attrs)}`);
  assert.ok(result.copy.avg > 5, `the viewport copy after compositing is black: ${JSON.stringify(result.copy)}`);
  assert.ok(result.copy.nonblack > 1000, `the viewport copy has almost no pixels: ${JSON.stringify(result.copy)}`);
  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`);
  console.log(`3d-capture-e2e: PASS (${result.copy.w}x${result.copy.h}, avg ${result.copy.avg.toFixed(1)}, preserveDrawingBuffer=true)`);
} finally {
  try { await browser?.close(); } catch {}
  await cleanup(running);
}
