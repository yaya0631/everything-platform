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
const installed = hub.listApps().filter((a) => a.enabled && !hasEvidence(a.name));
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
try {
  for (const app of targets) {
    const page = await context.newPage();
    await page.setCookie({ name: 'cad_session', value: token, url: base });
    await page.evaluateOnNewDocument(() => { window.__CAD_FUNCTIONAL_GATE__ = true; });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error.message || error)));
    await page.goto(`${base}/h/${app.name}/`, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const probe = await page.evaluate(async (name) => {
      const key = `__cad_functional_gate__:${name}`;
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
    results.set(app.name, { app: app.name, pass: !errors.length && probe.kvSet && probe.fsRoundTrip, initialCalls: calls, errors, probe, page });
  }

  // Stop and restart the same server/data directory. The same session and
  // browser pages then prove each app's KV entry survives process restart.
  await running.close();
  running = await serverm.startServer({ port, publicPort: 0, host: '127.0.0.1', tls: null });
  const base2 = `http://127.0.0.1:${running.privatePort}`;
  for (const record of results.values()) {
    const page = record.page;
    await page.setCookie({ name: 'cad_session', value: token, url: base2 });
    await page.goto(`${base2}/h/${record.app}/`, { waitUntil: 'networkidle2', timeout: 45000 });
    const kvRestart = await page.evaluate(async (key, marker) => ({ pass: (await puter.kv.get(key)) === marker }), record.probe.key, record.probe.marker);
    const calls = await page.evaluate(() => window.__CAD_PUTER_CALLS__ || []);
    record.kvRestart = kvRestart;
    record.calls = [...record.initialCalls, ...calls];
    record.pass = record.pass && kvRestart.pass && record.calls.length > 0 && record.calls.every((c) => c.status === 'resolved');
    delete record.page; delete record.initialCalls;
    const out = { ...record, fsRoundTrip: { pass: record.probe.fsRoundTrip }, at: new Date().toISOString(), serverDataDir: dataRoot };
    fs.writeFileSync(path.join(gatesDir, `${record.app}-functional.json`), JSON.stringify(out, null, 2));
    console.log(`${record.app}: ${out.pass ? 'PASS' : 'FAIL'} calls=${out.calls.length} kv-restart=${out.kvRestart.pass} fs-roundtrip=${out.probe.fsRoundTrip}`);
  }
  if ([...results.values()].some((x) => !x.pass)) process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
  await running?.close();
}
