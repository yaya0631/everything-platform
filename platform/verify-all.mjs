#!/usr/bin/env node
/**
 * One command for the host checks.
 *
 *   node verify-all.mjs          lint, suite, engine install check, hub smoke,
 *                                fresh-host acceptance
 *   node verify-all.mjs --full   also the real-browser engine/Pyodide/peer/
 *                                chess checks, the admin bulk-model UI, the
 *                                installed-app smoke and the infrastructure
 *                                gate. The app checks run on a throwaway copy
 *                                of data/ and copy only the gate evidence back,
 *                                so no test account or test data touches the
 *                                live DB.
 *
 * A failure exits non-zero. The full run is intentionally long; it is the
 * hosting acceptance, not the edit loop.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, 'data');
const full = process.argv.includes('--full');
const failures = [];

const run = (label, command, args, { env = process.env, timeout = 0, allowFail = false } = {}) => {
  console.log(`\n=== ${label} ===`);
  const r = spawnSync(command, args, {
    cwd: here,
    env,
    stdio: 'inherit',
    timeout: timeout || undefined,
    shell: process.platform === 'win32' && /\.cmd$/i.test(command),
  });
  if (r.error) {
    failures.push(`${label}: ${r.error.message}`);
    console.error(`FAIL ${label}: ${r.error.message}`);
    if (!allowFail) process.exitCode = 1;
    return false;
  }
  if (r.status !== 0) {
    failures.push(`${label}: exit ${r.status}`);
    console.error(`FAIL ${label}: exit ${r.status}`);
    if (!allowFail) process.exitCode = 1;
    return false;
  }
  console.log(`PASS ${label}`);
  return true;
};

const node = (label, script, args = [], opts = {}) => run(label, process.execPath, [path.join(here, script), ...args], opts);
const npm = (label, args, opts = {}) => run(label, process.platform === 'win32' ? 'npm.cmd' : 'npm', args, opts);

const copyData = (dest) => {
  fs.mkdirSync(dest, { recursive: true });
  for (const f of ['cad.db', 'cad.db-wal', 'cad.db-shm']) {
    const src = path.join(DATA, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dest, f));
  }
  for (const dir of ['hub', 'hub-users', 'files']) {
    const src = path.join(DATA, dir);
    if (!fs.existsSync(src)) continue;
    const isHub = dir === 'hub';
    fs.cpSync(src, path.join(dest, dir), {
      recursive: true,
      force: true,
      filter: (from) => {
        if (!isHub) return true;
        const rel = path.relative(src, from);
        return !rel.startsWith('test-gates') && !rel.startsWith('worker-tmp');
      },
    });
  }
};

const copyGateEvidence = (from, to) => {
  if (!fs.existsSync(from)) return 0;
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(from)) {
    if (!f.endsWith('.json')) continue;
    fs.copyFileSync(path.join(from, f), path.join(to, f));
    n += 1;
  }
  return n;
};

try {
  npm('lint', ['run', 'lint']);
  npm('unit + integration suite', ['test']);
  run('engine install check', process.execPath, ['engines/install.mjs', '--check']);
  node('hub HTTP smoke', 'smoke-hub.mjs');
  node('fresh-host acceptance', 'fresh-host-e2e.mjs');

  if (full) {
    node('local engines in Chrome', 'engine-e2e.mjs');
    node('vendored Pyodide in Chrome', 'pyodide-e2e.mjs');
    node('peer relay/media in Chrome', 'peer-e2e.mjs');
    node('chess Online against the real build', 'chess-online-e2e.mjs');
    node('admin bulk model UI in Chrome', 'admin-bulk-e2e.mjs');
    node('3D assistant capture keeps pixels in Chrome', '3d-capture-e2e.mjs');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-verify-data-'));
    try {
      copyData(tmp);
      const env = { ...process.env, CAD_DATA_DIR: tmp, CAD_TEST: '1' };
      const smokeOk = node('installed apps load in Chrome', 'browser-smoke.mjs', ['load'], { env, allowFail: true });
      if (!smokeOk) failures.push('installed apps load in Chrome');
      const gateOk = node('installed apps infrastructure gate', 'functional-gate.mjs', [], { env, allowFail: true, timeout: 0 });
      const copied = copyGateEvidence(path.join(tmp, 'hub', 'test-gates'), path.join(DATA, 'hub', 'test-gates'));
      console.log(`copied ${copied} gate evidence file(s) back to platform/data/hub/test-gates`);
      if (!gateOk) failures.push('installed apps infrastructure gate');
    } finally {
      for (let i = 0; i < 5; i++) {
        try { fs.rmSync(tmp, { recursive: true, force: true }); break; } catch { /* child may still hold a file */ }
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    node('app status report', 'build-hub.mjs', ['status']);
  }
} catch (err) {
  failures.push(String(err?.stack || err));
  console.error(err);
  process.exitCode = 1;
}

console.log('\n=== verify-all result ===');
if (failures.length) {
  console.log(`FAILED (${failures.length}):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log(full ? 'PASS: full hosting acceptance' : 'PASS: host checks');
}
