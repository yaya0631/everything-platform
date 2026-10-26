#!/usr/bin/env node
/**
 * Chromium acceptance for the real chess app's Online mode against the hub's
 * LAN peer relay (isolated data dir, two throwaway people, installed build).
 *
 * It drives the app the way a person does, not the shim: open Chess, switch to
 * Online, create a game, read the invite code, join from the second browser,
 * wait for the handshake, play a move as each side, and read the other side's
 * move list. This is the test that proves `puter.peer` fits a real consumer
 * (OnlineSession in upstream/src/chess/src/net/online.js) rather than only the
 * probe fixture.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, '.tmp-chess-online-e2e');
fs.rmSync(DATA, { recursive: true, force: true });
process.env.CAD_DATA_DIR = DATA;
process.env.CAD_TEST = '1';
const PORT = Number(process.env.CHESS_E2E_PORT || 18193);
const PUB_PORT = PORT + 1;
const HOST = 'chesshost';
const GUEST = 'chessguest';
const PASS = 'chess-e2e-pass-1';
const chrome = [process.env.BROWSER_EXE, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
  .filter(Boolean).find((p) => { try { fs.accessSync(p); return true; } catch { return false; } });
if (!chrome) throw new Error('Chrome is required for the chess online E2E.');

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
  store.addUser(HOST, PASS);
  store.addUser(GUEST, PASS);
  hub.installFromDist('chess', path.join(here, 'data', 'hub', 'apps', 'chess'), {
    sha: 'c'.repeat(40), source: 'import', title: 'Chess',
  });
  const base = `http://127.0.0.1:${running.privatePort}`;

  const login = async (username) => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CAD-Request': '1' },
      body: JSON.stringify({ username, password: PASS }),
    });
    return { ok: res.ok, token: (res.headers.get('set-cookie') || '').split(';')[0].split('=')[1] };
  };
  const hostLogin = await login(HOST);
  const guestLogin = await login(GUEST);
  check('both throwaway players sign in', hostLogin.ok && guestLogin.ok && !!hostLogin.token && !!guestLogin.token,
    JSON.stringify({ host: hostLogin.ok, guest: guestLogin.ok }));

  browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-first-run', '--mute-audio'] });
  const openPage = async (token, label) => {
    const ctx = await browser.createBrowserContext();
    await ctx.setCookie({ name: 'cad_session', value: token, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (/ServiceWorker|sw\.js|plausible\.io|manifest/i.test(m.text())) return;
      errors.push(`${label} console: ${m.text()}`);
    });
    await page.goto(`${base}/h/chess/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => !!document.querySelector('[data-mode="online"]'), { timeout: 45000 });
    return { page, errors, label };
  };
  const host = await openPage(hostLogin.token, 'host');
  const guest = await openPage(guestLogin.token, 'guest');
  check('both chess pages load through the hub',
    (await host.page.evaluate(() => document.body.innerText.length > 80))
      && (await guest.page.evaluate(() => document.body.innerText.length > 80)));

  const enterOnline = async (entry) => {
    await entry.page.click('[data-mode="online"]');
    await entry.page.waitForFunction(() => {
      const b = document.querySelector('#host-btn');
      return b && !b.closest('.hidden');
    }, { timeout: 15000 });
  };
  await enterOnline(host);
  await host.page.click('#host-btn');
  await host.page.waitForFunction(() => {
    const el = document.querySelector('#invite-code');
    return el && /^[A-Z2-9]{8}$/.test(el.textContent.trim());
  }, { timeout: 30000 });
  const code = (await host.page.$eval('#invite-code', (el) => el.textContent.trim()));
  check('the host creates a game and gets a real invite code', /^[A-Z2-9]{8}$/.test(code), code);

  await enterOnline(guest);
  await guest.page.type('#join-input', code);
  await guest.page.click('#join-btn');
  const playing = async (entry) => entry.page.waitForFunction(() => {
    const card = document.querySelector('#online-card');
    const resign = document.querySelector('#resign-btn');
    return card && card.classList.contains('hidden') && resign && !resign.classList.contains('hidden');
  }, { timeout: 45000 });
  await Promise.all([playing(host), playing(guest)]);
  check('both sides reach the playing state after the handshake', true);

  const status = await host.page.$eval('#sr-status', (el) => el.textContent.trim());
  const hostWhite = /you play white/i.test(status);
  const hostBlack = /you play black/i.test(status);
  check('the host is dealt a side and the handshake names it', hostWhite || hostBlack, status);
  const first = hostWhite ? ['e2', 'e4', 'e4'] : ['e7', 'e5', 'e5'];
  const reply = hostWhite ? ['e7', 'e5', 'e5'] : ['e2', 'e4', 'e4'];

  const play = async (entry, [from, to]) => {
    await entry.page.click(`[data-square="${from}"]`);
    await new Promise((r) => setTimeout(r, 120));
    await entry.page.click(`[data-square="${to}"]`);
  };
  const sawMove = async (entry, ply) => entry.page.waitForFunction((wanted) => {
    const list = document.querySelector('#move-list');
    return !!list && new RegExp(`\\b${wanted}\\b`).test(list.innerText);
  }, { timeout: 30000 }, ply);

  let hostMoveOk = false;
  let hostMoveDetail = '';
  try {
    await play(host, first);
    await sawMove(guest, first[2]);
    hostMoveOk = true;
  } catch (e) {
    hostMoveDetail = e.message;
  }
  check(`the host's move (${first[2]}) reaches the guest's board`, hostMoveOk, hostMoveDetail);

  let guestMoveOk = false;
  let guestMoveDetail = '';
  try {
    await play(guest, reply);
    await sawMove(host, reply[2]);
    guestMoveOk = true;
  } catch (e) {
    guestMoveDetail = e.message;
  }
  const readList = async (entry) => entry.page.$eval('#move-list', (el) => el.innerText.replace(/\s+/g, ' ').trim()).catch(() => '');
  const hostList = await readList(host);
  const guestList = await readList(guest);
  check(`the guest's reply (${reply[2]}) reaches the host's board`, guestMoveOk,
    [guestMoveDetail, JSON.stringify({ host: hostList, guest: guestList })].filter(Boolean).join(' | '));

  const allErrors = [...host.errors, ...guest.errors];
  check('no page errors on either side', allErrors.length === 0, allErrors.join(' | EOF | '));

  const results = { app: 'chess', steps, hostList, guestList, code, passed: steps.every((s) => s.pass) };
  fs.writeFileSync(path.join(here, 'chess-online-results.json'), JSON.stringify(results, null, 2));
  console.log(`\n${steps.filter((s) => s.pass).length}/${steps.length} checks passed`);
  if (!results.passed) process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (running) await running.close().catch(() => {});
  fs.rmSync(DATA, { recursive: true, force: true });
}
