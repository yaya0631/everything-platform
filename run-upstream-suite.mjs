#!/usr/bin/env node
/** Run an upstream app's own Vitest suite and persist its case-count evidence. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { upstreamRoot } from './lib/hub-build.js';

const apps = process.argv.slice(2);
if (!apps.length) {
  console.error('usage: node run-upstream-suite.mjs <app> [app ...]');
  process.exit(2);
}

const root = upstreamRoot();
const gates = path.resolve('data', 'hub', 'test-gates');
fs.mkdirSync(gates, { recursive: true });
let failed = false;

for (const app of apps) {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(app)) throw new Error(`bad app name: ${app}`);
  const dir = path.join(root, 'src', app);
  const runner = path.join(dir, 'node_modules', 'vitest', 'vitest.mjs');
  if (!fs.existsSync(runner)) throw new Error(`${app}: Vitest is not installed at ${runner}`);
  console.log(`\n== upstream ${app}: vitest run ==`);
  const locale = pathToFileURL(path.resolve('test', 'en-us-intl-default.mjs')).href;
  const nodeOptions = [process.env.NODE_OPTIONS || '', `--import=${locale}`].filter(Boolean).join(' ');
  const child = spawn(process.execPath, [runner, 'run'], { cwd: dir, env: { ...process.env, NODE_OPTIONS: nodeOptions }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { const text = chunk.toString(); output += text; process.stdout.write(text); });
  child.stderr.on('data', (chunk) => { const text = chunk.toString(); output += text; process.stderr.write(text); });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const cases = output.match(/Tests\s+(\d+)\s+passed(?:\s*\|\s*(\d+)\s+failed)?\s*\((\d+)\)/i);
  const files = output.match(/Test Files\s+(\d+)\s+passed(?:\s*\|\s*(\d+)\s+failed)?\s*\((\d+)\)/i);
  const report = {
    app,
    runner: 'vitest run',
    passed: Number(cases?.[1] || 0),
    failed: Number(cases?.[2] || 0),
    total: cases ? Number(cases[3]) : null,
    runtimeCovered: 0,
    execution: 'upstream app code and upstream test harness only; no cad-home runner, shim, or hub API executed',
    files_passed: Number(files?.[1] || 0),
    files_failed: Number(files?.[2] || 0),
    files_total: files ? Number(files[3]) : null,
    exit_code: code,
    locale_default: 'en-US',
    at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(gates, `${app}-suite.json`), JSON.stringify(report, null, 2));
  console.log(`upstream evidence ${app}: ${report.passed}/${report.total ?? '?'} cases; exit ${code}`);
  if (code !== 0 || !report.total || report.failed) failed = true;
}

process.exit(failed ? 1 : 0);
