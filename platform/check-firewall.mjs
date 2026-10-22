/**
 * Firewall check for the dedicated worker node binary (README §1 step 5).
 * Two probes, one verdict:
 *
 *   control — the normal node.exe makes the same outbound connection
 *             (proves the PC is actually online);
 *   worker  — data\bin\node-worker.exe must FAIL the same connection.
 *
 * Prints "RULE OK" only when both hold. If the CONTROL is blocked, the
 * result says nothing about the rule: prints "NO INTERNET — INCONCLUSIVE".
 *
 * Usage:  node check-firewall.mjs [path\to\node-worker.exe]
 * (run with the normal node.exe, as Administrator)
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const PROBE_URL = process.env.CAD_FW_PROBE_URL || 'https://example.com/';
const CHILD_TIMEOUT = 20_000;
const SELF = path.resolve(fileURLToPath(import.meta.url));

function probe(binaryPath) {
  const r = spawnSync(binaryPath, [SELF, '--child'], {
    timeout: CHILD_TIMEOUT,
    encoding: 'utf8',
    env: { ...process.env, CAD_FW_PROBE_URL: PROBE_URL },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (out.includes('CHILD_OUTBOUND_OK')) return 'ok';
  if (out.includes('CHILD_OUTBOUND_BLOCKED')) return 'blocked';
  const code = (r.error && r.error.code) || String(r.status);
  if (r.error && code === 'ENOENT') return 'missing-binary';
  return `unreadable (${code}: ${out.trim().slice(0, 120)})`;
}

if (process.argv.includes('--child')) {
  // Child probe: one straightforward outbound HTTPS GET.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort('timeout'), 12_000);
  try {
    const res = await fetch(PROBE_URL, { signal: ctl.signal });
    clearTimeout(timer);
    await res.body?.cancel?.();
    console.log('CHILD_OUTBOUND_OK');
    process.exit(0);
  } catch (e) {
    clearTimeout(timer);
    console.log(`CHILD_OUTBOUND_BLOCKED (${String(e && e.message).slice(0, 60)})`);
    process.exit(3);
  }
}

const workerBin = path.resolve(process.argv[2] || path.join('data', 'bin', 'node-worker.exe'));
const serverBin = path.resolve(process.execPath);

if (path.relative(serverBin, workerBin) === '' || serverBin.toLowerCase().endsWith('node-worker.exe')) {
  console.error('Run this with the NORMAL node.exe, not the worker copy. E.g.: node check-firewall.mjs data\\bin\\node-worker.exe');
  process.exit(2);
}

console.log(`probing ${PROBE_URL} (timeout ${CHILD_TIMEOUT / 1000} s per probe) …`);
const control = probe(serverBin);
const worker = probe(workerBin);
console.log(`control  (${serverBin}): ${control}`);
console.log(`worker   (${workerBin}): ${worker}`);

if (control !== 'ok') {
  console.log('NO INTERNET — INCONCLUSIVE (the control could not connect either; fix the PC\'s online state first)');
  process.exit(4);
}
if (worker === 'blocked') {
  console.log('RULE OK');
  process.exit(0);
}
if (worker === 'missing-binary') {
  console.log('RULE NOT SET UP — the worker binary does not exist yet; copy node.exe to it first (README §1 step 5)');
  process.exit(6);
}
console.log(`RULE FAILED — outbound from node-worker.exe was not blocked (worker probe: ${worker})`);
process.exit(5);
