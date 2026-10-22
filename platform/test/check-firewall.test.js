/** check-firewall.mjs child mode over loopback only: a dead local address
 * must report CHILD_OUTBOUND_BLOCKED (the blocked path of the firewall
 * verdict), with zero external traffic. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const SELF = path.resolve(fileURLToPath(import.meta.url));
const SCRIPT = path.join(path.dirname(SELF), '..', 'check-firewall.mjs');

test('the child probe reports blocked for an unreachable local address', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--child'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, CAD_FW_PROBE_URL: 'http://127.0.0.1:9/x' },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  assert.match(out, /CHILD_OUTBOUND_BLOCKED/, `the probe must report blocked: ${out.slice(0, 200)}`);
});
