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
import * as config from './lib/config.js';

process.env.CAD_TEST = '1';
const selected = process.argv[2] ? process.argv[2].split(',') : null;
const port = Number(process.env.FUNCTIONAL_GATE_PORT || 18120);
const user = 'functional-gate';
const password = 'functional-gate-local-only';
const chrome = [process.env.BROWSER_EXE, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
  .filter(Boolean).find((p) => { try { fs.accessSync(p); return true; } catch { return false; } });
if (!chrome) throw new Error('No Chrome found. Set BROWSER_EXE to the local Chrome executable.');

const gatesDir = path.join(DATA_DIR, 'hub', 'test-gates');
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
// AI parity (owner directive 2026-10-24): every app must be able to use the
// same server-side AI the cad assistant uses. CAD_TEST exposes the built-in
// test provider (canned replies, no network); point hub apps' default model
// at it so `puter.ai.chat` answers through the platform shim in every page,
// and cad's own adapter resolves the same provider id directly. CONFIG SETS
// PERSIST TO THE REAL DB (the gate's data dir is the live one unless the
// caller overrides CAD_DATA_DIR) — the finally block restores the previous
// value, so the wave never leaves a test provider behind in production
// (apps would answer "That model is not set up on this server." forever).
const PREV_HUB_AI_DEFAULT = config.get('hubAiDefaultModel');
config.set('hubAiDefaultModel', 'test:test-model');
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
  // 3d: the assistant panel is open by default (upstream e2e helper asserts
  // this); submitting a message is the real user path that raises its
  // on-demand Puter loader (assistant/puter.ts loadPuter via ready()).
  '3d': { fillSelector: '.as-input', text: 'make a cube', submit: 'Enter' },
};
const firstRunMiss = (c) => (c.method === 'puter.fs.read' || c.method === 'puter.fs.stat') && c.code === 'not_found';

/** Raise an app's on-demand Puter loader through a real user path, so the
 * shim-wait below judges the result. `label` = click the visible control with
 * that text; `{fillSelector, text, submit}` = type into the LIVE field and
 * press its submit (the loading happens through the app's own listeners). */
async function runPoke(page, poke) {
  if (!poke) return;
  if (typeof poke === 'string') {
    await page.evaluate((label) => {
      const els = [...document.querySelectorAll('button,[role="button"],a,[role="tab"],li,div')]
        .filter((e) => e.offsetParent !== null && (e.innerText || '').trim().toLowerCase() === label.toLowerCase());
      if (els.length) els[0].click();
      return els.length > 0;
    }, poke).catch(() => false);
  } else if (poke.fillSelector) {
    const el = await page.$(poke.fillSelector).catch(() => null);
    if (el) {
      await el.type(poke.text, { delay: 10 }).catch(() => {});
      await page.keyboard.press(poke.submit || 'Enter').catch(() => {});
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 4000));
}
const failingCalls = (app, calls) => calls.filter((c) => c.status !== 'resolved'
  && !firstRunMiss(c)
  // Email's first-run design asks to read the user's Mail folder. The shim
  // refuses before consent; the app handles that and renders its request-access
  // panel (M1 fixed the missing whoami that used to kill the page). All other
  // rejections, including every write, still fail.
  && !(app === 'email' && c.method === 'puter.fs.stat' && c.code === 'no_permission_for_app'));
/** App boot often starts async reads/gets after DOMContentLoaded. A pending
 * call is not a failure by itself; give the app's own startup work time to
 * settle, then judge whatever is still pending. */
async function waitForCallsSettled(page, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let quietSince = null;
  while (Date.now() < deadline) {
    const pending = await page.evaluate(() => (window.__CAD_PUTER_CALLS__ || []).filter((c) => c.status === 'pending').length).catch(() => 0);
    if (!pending) {
      if (quietSince === null) quietSince = Date.now();
      else if (Date.now() - quietSince >= 1500) return true;
    } else {
      quietSince = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/** Capture only after a quiet window; retry because a recurring poll can start
 * a new call in the gap between the check and the snapshot. */
async function readSettledCalls(page, timeoutMs = 12000) {
  let calls = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    await waitForCallsSettled(page, timeoutMs);
    calls = await page.evaluate(() => window.__CAD_PUTER_CALLS__ || []).catch(() => []);
    if (!calls.some((c) => c.status === 'pending')) return calls;
  }
  return calls;
}
try {
  for (const app of targets) {
    const page = await context.newPage();
    await context.setCookie({ name: 'cad_session', value: token, url: base });
    await page.evaluateOnNewDocument(() => { window.__CAD_FUNCTIONAL_GATE__ = true; });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error.message || error)));
    // One failing app must not abort the wave: every failure becomes that
    // app's own honest record, and the run continues (exit code 1 at the end).
    try {
      try {
        // Do not wait for network-idle: several apps keep a sync/SSE poll
        // running, which makes idle never settle. DOM readiness plus the shim
        // wait below is the actual gate; the separate browser smoke measures
        // the network.
        await page.goto(`${base}/h/${app.name}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      } catch (navErr) {
        if (!await page.evaluate(() => document.readyState === 'complete' || document.readyState === 'interactive').catch(() => false)) throw navErr;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      // Apps with an on-demand loader need a control click before window.puter
      // exists (measured in browser-smoke.mjs POKE). Click it, if present,
      // then let the shim wait below judge the result.
      await runPoke(page, POKE[app.name]);
      // Some apps load the shim on demand (their own script decides when);
      for (let i = 0; i < 20 && !(await page.evaluate(() => typeof window.puter === 'object')); i++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const hasPuter = await page.evaluate(() => typeof window.puter === 'object');
      if (!hasPuter) {
        results.set(app.name, { app: app.name, pass: false, initialCalls: [], errors: [...errors, 'puter shim not loaded within 10s of page load'], probe: { kvSet: false, fsRoundTrip: false, key: '', marker: '', file: '' } });
        results.get(app.name).shimMissing = true;
        await page.close().catch(() => {});
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
      // AI parity: the human-facing surface the cad assistant made mainstream
      // (`puter.ai.chat`) must answer in every app, through each page's real
      // adapter — the platform shim resolves server-side via hubAiDefaultModel;
      // cad's own adapter streams the core route's NDJSON inside a Response.
      const ai = await page.evaluate(async (localAdapter) => {
        try {
          let text = '';
          if (localAdapter) {
            const r = await puter.ai.chat({ model: 'test:test-model', messages: [{ role: 'user', content: 'gate-ping' }] });
            const raw = typeof r === 'string' ? r : await r.text();
            // The core route streams NDJSON: join the text deltas the way the
            // app's assistant does, instead of matching the raw wire format.
            const deltas = [...raw.matchAll(/"delta":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, '$1')).join('');
            text = deltas || raw;
          } else {
            const r = await puter.ai.chat([{ role: 'user', content: 'gate-ping' }], { model: 'test:test-model' });
            const c = r && r.message && r.message.content;
            text = typeof c === 'string' ? c : (typeof r === 'string' ? r : JSON.stringify(c ?? r ?? ''));
          }
          return { ok: /test-reply/.test(text), text: String(text).slice(0, 160) };
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
        }
      }, appLocalPuter);
      // The gate forces the built-in test provider (CAD_TEST), so this proves
      // the wiring and the page's adapter, not a real model. Say so in the
      // evidence: `ai=echo`, never "AI works" (M10).
      ai.mode = 'echo';
      ai.model = 'test:test-model';
      ai.note = 'canned test provider; proves the puter.ai.chat wiring, not a real model answer';
      const callsSettled = await waitForCallsSettled(page);
      const calls = await readSettledCalls(page);
      results.set(app.name, { app: app.name, pass: !errors.length && probe.kvSet && probe.fsRoundTrip && ai.ok, initialCalls: calls, callsSettled, errors, probe, ai, appLocalPuter });
      await page.close().catch(() => {});
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
    if (!record.probe || !record.probe.key) continue; // already failed in pass A (shim missing / probe threw)
    const page = await context.newPage();
    await page.evaluateOnNewDocument(() => { window.__CAD_FUNCTIONAL_GATE__ = true; });
    try {
      try {
        await context.setCookie({ name: 'cad_session', value: token, url: base2 });
        await page.goto(`${base2}/h/${record.app}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      } catch (navErr) {
        if (!await page.evaluate(() => document.readyState === 'complete' || document.readyState === 'interactive').catch(() => false)) throw navErr;
      }
      await runPoke(page, POKE[record.app]);
      const kvRestart = await page.evaluate(async (key, marker) => ({ pass: (await puter.kv.get(key)) === marker }), record.probe.key, record.probe.marker);
      const calls = await readSettledCalls(page);
      record.kvRestart = kvRestart;
      record.calls = [...record.initialCalls, ...calls];
      const bad = failingCalls(record.app, record.calls);
      record.failingCalls = bad;
      record.pass = record.pass && kvRestart.pass && (record.calls.length > 0 || record.appLocalPuter === true) && bad.length === 0;
    } catch (err) {
      record.pass = false;
      record.errors = [...(record.errors || []), `restart phase failed: ${String(err.message || err).slice(0, 200)}`];
    } finally {
      await page.close().catch(() => {});
    }
    delete record.page; delete record.initialCalls;
  }
  // Every target gets a verdict on disk and on stdout — including apps that
  // already failed in phase A (no page), so a wave failure is never silent.
  for (const record of results.values()) {
    const out = {
      ...record,
      kind: 'infrastructure',
      scope: 'page boots with the shim; kv/fs round-trip and restart; canned AI echo. App-specific features (editing, gameplay, invoices, ...) are NOT exercised by this gate (M10).',
      fsRoundTrip: { pass: record.probe.fsRoundTrip },
      at: new Date().toISOString(),
      serverDataDir: dataRoot,
    };
    fs.writeFileSync(path.join(gatesDir, `${record.app}-functional.json`), JSON.stringify(out, null, 2));
    const badN = out.failingCalls ? out.failingCalls.length : 0;
    const kvr = out.kvRestart ? out.kvRestart.pass : false;
    console.log(`${record.app}: ${out.pass ? 'PASS' : 'FAIL'} gate=infra calls=${(out.calls || []).length} kv-restart=${kvr} fs-roundtrip=${out.probe.fsRoundTrip} ai=echo${record.shimMissing ? ' shim-missing' : ''}${!out.pass && badN ? ` failing-calls=${badN}` : ''}${out.ai && !out.ai.ok ? ` ai-fail=${JSON.stringify(out.ai.text || out.ai.error || '').slice(0, 120)}` : ''}`);
  }
  if ([...results.values()].some((x) => !x.pass)) process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
  await running?.close();
  // Leave the owner's hub AI default exactly as it was (see comment above).
  config.set('hubAiDefaultModel', PREV_HUB_AI_DEFAULT);
}
