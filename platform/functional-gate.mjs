#!/usr/bin/env node
/** Generic easy-tier shim gate: real Chromium page load, Puter-call log,
 * KV persistence across server restart, and fs write/read round trip. */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import * as hub from './lib/hub.js';
import * as serverm from './server.js';
import * as store from './lib/store.js';
import * as db from './lib/db.js';
import { DATA_DIR } from './lib/paths.js';
import { appSourceDir } from './lib/hub-build.js';

process.env.CAD_TEST = '1';
const selected = process.argv[2] ? process.argv[2].split(',') : null;
const port = Number(process.env.FUNCTIONAL_GATE_PORT || 18120);
const user = 'functional-gate';
const password = 'functional-gate-local-only';
const chrome = [process.env.BROWSER_EXE, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
  .filter(Boolean).find((p) => { try { fs.accessSync(p); return true; } catch { return false; } });
if (!chrome) throw new Error('No Chrome found. Set BROWSER_EXE to the local Chrome executable.');

const gatesDir = path.resolve('data/hub/test-gates');
fs.mkdirSync(gatesDir, { recursive: true });
const hasEvidence = (name) => ['-suite.json', '.json'].some((suffix) => fs.existsSync(path.join(gatesDir, `${name}${suffix}`)));
// Only the 51 upstream apps carry a functional-gate tier verdict; non-upstream
// installed hosted apps (outside the census, e.g. old import tests) are skipped,
// not judged.
for (const a of [...hub.listApps()].filter((x) => x.enabled)) {
  try { appSourceDir(a.name); } catch { console.log(`skip (not an upstream app, no tier verdict): ${a.name}`); }
}
const installed = hub.listApps().filter((a) => a.enabled && !hasEvidence(a.name) && (() => { try { appSourceDir(a.name); return true; } catch { return false; } })());
const targets = selected ? installed.filter((a) => selected.includes(a.name)) : installed;
if (!targets.length) throw new Error(`No installed easy-tier apps selected (${selected?.join(',') || 'all'}).`);

if (!store.getAccount(user)) store.addUser(user, password, { admin: true });
else store.setPassword(user, password);
const dataRoot = DATA_DIR;
let running = await serverm.startServer({ port, publicPort: 0, host: '127.0.0.1', tls: null });
const base = `http://127.0.0.1:${running.privatePort}`;
const auth = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CAD-Request': '1' }, body: JSON.stringify({ username: user, password }) });
const token = (auth.headers.get('set-cookie') || '').split(';')[0].split('=')[1];
if (!token) throw new Error('Functional gate login failed.');
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-first-run', '--mute-audio'] });
const context = await browser.createBrowserContext();
const results = new Map();
// First-run policy (declared 2026-10-23, in the gate + status): a rejected
// READ that the app handles as an expected empty-drive miss (`code:
// 'not_found'` on puter.fs.read) is healthy first-run behavior — notes,
// expense and circuits catch it and seed defaults. Every other rejection
// (writes, perms, timeouts, unexpected codes) still fails the gate, as do
// uncaught page errors. The full call log stays in the evidence file.
// Same poke table as browser-smoke.mjs: control clicks that make on-demand
// loaders surface window.puter before the generic probe runs.
const POKE = {
  chess: 'Online',
  checkers: 'Online',
  backgammon: 'Online',
  // 3d runs its own main loop; no documented control raises its loader.
};
const firstRunMiss = (c) => c.method === 'puter.fs.read' && c.code === 'not_found';
const failingCalls = (calls) => calls.filter((c) => c.status !== 'resolved' && !firstRunMiss(c));
try {
  for (const app of targets) {
    const page = await context.newPage();
    await page.setCookie({ name: 'cad_session', value: token, url: base });
    await page.evaluateOnNewDocument(() => { window.__CAD_FUNCTIONAL_GATE__ = true; });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error.message || error)));
    // One failing app must not abort the wave: every failure becomes that
    // app's own honest record, and the run continues (exit code 1 at the end).
    try {
      try {
        await page.goto(`${base}/h/${app.name}/`, { waitUntil: 'networkidle2', timeout: 45000 });
      } catch (navErr) {
        // Some apps keep persistent connections (streams/sockets), so
        // network-idle never settles. That is not a probe failure: continue
        // as long as the document itself is usable and judge the shim wait.
        if (!await page.evaluate(() => document.readyState === 'complete' || document.readyState === 'interactive').catch(() => false)) throw navErr;
        console.log(`note: ${app.name} never reached network-idle; continuing on DOM state`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      // Apps with an on-demand loader need a control click before window.puter
      // exists (measured in browser-smoke.mjs POKE). Click it, if present,
      // then let the shim wait below judge the result.
      const poke = POKE[app.name];
      if (poke) {
        await page.evaluate((label) => {
          const els = [...document.querySelectorAll('button,[role="button"],a,[role="tab"],li,div')]
            .filter((e) => e.offsetParent !== null && (e.innerText || '').trim().toLowerCase() === label.toLowerCase());
          if (els.length) els[0].click();
          return els.length > 0;
        }, poke).catch(() => false);
        await new Promise((resolve) => setTimeout(resolve, 4000));
      }
      // Some apps load the shim on demand (their own script decides when);
      for (let i = 0; i < 20 && !(await page.evaluate(() => typeof window.puter === 'object')); i++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const hasPuter = await page.evaluate(() => typeof window.puter === 'object');
      if (!hasPuter) {
        results.set(app.name, { app: app.name, pass: false, initialCalls: [], errors: [...errors, 'puter shim not loaded within 10s of page load'], probe: { kvSet: false, fsRoundTrip: false, key: '', marker: '', file: '' } });
        results.get(app.name).shimMissing = true;
        continue;
      }
      // cad ships its own adapter (window.puter built in the app bundle), so
      // the platform shim's call log does not exist there; the round trips and
      // restart checks still prove the KV/FS surface, and page errors still
      // apply. Recorded so the verdict is explainable, not a hidden exemption.
      const appLocalPuter = !(await page.evaluate(() => Array.isArray(window.__CAD_PUTER_CALLS__)));
      const probe = await page.evaluate(async (name) => {
        // Key must fit the server settings-kv contract ([\w.-]{1,64}): cad's
        // own adapter (unlike the platform shim's /kv/set route) maps kv to
        // that route, so colons in the probe key would 404 there.
        const key = `__cad_functional_gate.${name}`;
        const marker = `cad-functional-${name}-${Date.now()}`;
        await puter.kv.set(key, marker);
        const found = await puter.kv.get(key);
        const file = `functional-gate/${name}-roundtrip.txt`;
        await puter.fs.write(file, marker, { createMissingParents: true, overwrite: true });
        const blob = await puter.fs.read(file);
        const text = await blob.text();
        return { key, marker, file, kvSet: found === marker, fsRoundTrip: text === marker };
      }, app.name);
      const calls = await page.evaluate(() => window.__CAD_PUTER_CALLS__ || []);
      results.set(app.name, { app: app.name, pass: !errors.length && probe.kvSet && probe.fsRoundTrip, initialCalls: calls, errors, probe, page, appLocalPuter });
    } catch (err) {
      results.set(app.name, { app: app.name, pass: false, initialCalls: [], errors: [...errors, `gate probe failed: ${String(err.message || err).slice(0, 200)}`], probe: { kvSet: false, fsRoundTrip: false, key: '', marker: '', file: '' } });
      try { await page.close(); } catch {}
    }
  }

  // Stop and restart the same server/data directory. The same session and
  // browser pages then prove each app's KV entry survives process restart.
  await running.close();
  running = await serverm.startServer({ port, publicPort: 0, host: '127.0.0.1', tls: null });
  const base2 = `http://127.0.0.1:${running.privatePort}`;
  for (const record of results.values()) {
    const page = record.page;
    if (!page) continue; // already failed in pass A (shim missing / probe threw) — verdict is written as-is
    try {
      try {
        await page.setCookie({ name: 'cad_session', value: token, url: base2 });
        await page.goto(`${base2}/h/${record.app}/`, { waitUntil: 'networkidle2', timeout: 45000 });
      } catch (navErr) {
        if (!await page.evaluate(() => document.readyState === 'complete' || document.readyState === 'interactive').catch(() => false)) throw navErr;
      }
      const kvRestart = await page.evaluate(async (key, marker) => ({ pass: (await puter.kv.get(key)) === marker }), record.probe.key, record.probe.marker);
      const calls = await page.evaluate(() => window.__CAD_PUTER_CALLS__ || []);
      record.kvRestart = kvRestart;
      record.calls = [...record.initialCalls, ...calls];
      const bad = failingCalls(record.calls);
      record.failingCalls = bad;
      record.pass = record.pass && kvRestart.pass && (record.calls.length > 0 || record.appLocalPuter === true) && bad.length === 0;
    } catch (err) {
      record.pass = false;
      record.errors = [...(record.errors || []), `restart phase failed: ${String(err.message || err).slice(0, 200)}`];
    }
    delete record.page; delete record.initialCalls;
  }
  // Every target gets a verdict on disk and on stdout — including apps that
  // already failed in phase A (no page), so a wave failure is never silent.
  for (const record of results.values()) {
    const out = { ...record, fsRoundTrip: { pass: record.probe.fsRoundTrip }, at: new Date().toISOString(), serverDataDir: dataRoot };
    fs.writeFileSync(path.join(gatesDir, `${record.app}-functional.json`), JSON.stringify(out, null, 2));
    const badN = out.failingCalls ? out.failingCalls.length : 0;
    const kvr = out.kvRestart ? out.kvRestart.pass : false;
    console.log(`${record.app}: ${out.pass ? 'PASS' : 'FAIL'} calls=${(out.calls || []).length} kv-restart=${kvr} fs-roundtrip=${out.probe.fsRoundTrip}${record.shimMissing ? ' shim-missing' : ''}${!out.pass && badN ? ` failing-calls=${badN}` : ''}`);
  }
  if ([...results.values()].some((x) => !x.pass)) process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
  await running?.close();
}
