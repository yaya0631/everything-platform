/**
 * Admin -> AI bulk model management: check the multi-select bar against a
 * throwaway server and the system Chrome. This is UI evidence, not a unit
 * test: it seeds 30 models, filters, shift-selects a range, keeps a subset,
 * disables it, removes it, and verifies each save through the admin API.
 *
 * Run from platform/: node admin-bulk-e2e.mjs
 * Nothing touches data/: test/helpers.js starts with a fresh CAD_DATA_DIR.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { start, cleanup, client } from './test/helpers.js';
import * as store from './lib/store.js';
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
  console.error(`admin-bulk-e2e: no Chrome found (${CHROME_CANDIDATES.join(', ')})`);
  process.exit(2);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, message, tries = 50) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return;
    await wait(100);
  }
  throw new Error(message);
}

const running = await start();
let browser;
try {
  store.addUser('boss', 'boss-password', { admin: true });
  const c = client(running.base);
  await c.login('boss', 'boss-password');
  const seeded = Array.from({ length: 30 }, (_, i) => ({
    id: `openai:m-${String(i + 1).padStart(2, '0')}`,
    label: '',
    enabled: (i + 1) % 4 === 0,
    tools: true,
  }));
  await c.put('admin/ai/models', { models: seeded });

  browser = await puppeteer.launch({ executablePath: chromeExe, headless: true, args: ['--no-first-run', '--mute-audio'] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
  const session = c.cookie.split(';')[0].split('=').slice(1).join('=');
  await page.setCookie({ name: 'cad_session', value: session, url: running.base, path: '/' });
  await page.goto(`${running.base}/admin/#/ai`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[title="Select all shown models"]');
  await page.waitForSelector('table.table tbody tr');

  const rowCount = () => page.$$eval('table.table tbody tr', (rows) => rows.length);
  const countText = () => page.$eval('.bulk-models [aria-live="polite"]', (el) => el.textContent);
  const setFilter = async (text) => {
    await page.$eval('input[placeholder="Filter models"]', (el, value) => {
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
    await wait(50);
  };
  const clickRow = async (index, shift = false) => {
    const boxes = await page.$$('input[data-model-id]');
    if (shift) await page.keyboard.down('Shift');
    await boxes[index].click();
    if (shift) await page.keyboard.up('Shift');
    await wait(30);
  };
  const clickBulk = async (label) => {
    await page.evaluate((text) => {
      const b = [...document.querySelectorAll('.bulk-models button')].find((x) => x.textContent.trim() === text);
      if (!b) throw new Error(`no bulk button: ${text}`);
      b.click();
    }, label);
    await wait(50);
  };
  const confirm = async (label) => {
    await waitFor(() => page.evaluate(() => !!document.querySelector('dialog[open]')), 'confirmation dialog did not open');
    await page.evaluate((text) => {
      const b = [...document.querySelectorAll('dialog[open] button')].find((x) => x.textContent.trim() === text);
      if (!b) throw new Error(`no dialog button: ${text}`);
      b.click();
    }, label);
    await wait(50);
  };
  const save = async (expected, label) => {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('.card-actions button')].find((x) => x.textContent.trim() === 'Save models');
      if (!b) throw new Error('no Save models button');
      b.click();
    });
    await waitFor(async () => {
      const models = (await c.get('admin/ai')).body.models;
      return expected(models);
    }, `save did not persist: ${label}`);
  };

  assert.equal(await rowCount(), 30, 'all seeded models are shown');

  // Filter to 9, anchor a shift range at 5, then select the rest of the view.
  await setFilter('m-0');
  assert.equal(await rowCount(), 9, 'filter narrows the table');
  await clickRow(0);
  await clickRow(4, true);
  assert.equal(await countText(), '5 of 30 selected');
  assert.equal(await page.$eval('input[title="Select all shown models"]', (el) => el.indeterminate), true, 'header shows a partial selection');
  await page.click('input[title="Select all shown models"]');
  assert.equal(await countText(), '9 of 30 selected');
  assert.equal(await page.$eval('input[title="Select all shown models"]', (el) => el.checked), true);

  // The header toggles the current view off and on, even after row clicks.
  await page.click('input[title="Select all shown models"]');
  assert.equal(await countText(), 'No models selected');
  assert.equal(await page.$eval('input[title="Select all shown models"]', (el) => el.checked), false);
  await page.click('input[title="Select all shown models"]');
  assert.equal(await countText(), '9 of 30 selected');

  // Clear the filter: the 9 stay selected while all 30 are shown.
  await setFilter('');
  assert.equal(await rowCount(), 30);
  assert.equal(await countText(), '9 of 30 selected');
  await clickBulk('Keep only selected');
  await confirm('Remove others');
  assert.equal(await rowCount(), 9, 'keep-only leaves the selected models');
  await save((models) => models.length === 9, 'keep-only');

  // Select the kept models again and disable all of them.
  await page.click('input[title="Select all shown models"]');
  assert.equal(await countText(), '9 of 9 selected');
  await clickBulk('Disable selected');
  const allowed = await page.$$eval('input[aria-label^="Allow "]', (boxes) => boxes.map((b) => b.checked));
  assert.ok(allowed.every((on) => !on), 'every model is disabled in the view');
  await save((models) => models.every((m) => !m.enabled), 'bulk disable');

  // Remove what is still selected.
  await clickBulk('Remove selected');
  await confirm('Remove');
  assert.equal(await rowCount(), 0, 'remove-selected empties the view');
  await save((models) => models.length === 0, 'remove-selected');

  assert.deepEqual(pageErrors, [], 'the panel reported no page errors');
  console.log('admin bulk selection: PASS');
} finally {
  await browser?.close();
  await cleanup(running);
}
