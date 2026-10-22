/** §19: the CAD_WORKER_NODE copy must be the same node as the server — at
 * startup a drifted copy draws a warning naming both versions, telling the
 * admin to recopy (the copy runs worker code on a different runtime than
 * the server that shells it otherwise). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

test('workerNodeVersion / checkWorkerNodeVersion: same binary = no drift', async (t) => {
  const runm = await import('../lib/hub-workers-run.js');
  assert.equal(runm.workerNodeVersion(process.execPath), process.version);
  const saved = process.env.CAD_WORKER_NODE;
  t.after(() => { if (saved === undefined) delete process.env.CAD_WORKER_NODE; else process.env.CAD_WORKER_NODE = saved; });
  delete process.env.CAD_WORKER_NODE;
  assert.deepEqual(runm.checkWorkerNodeVersion({ warn() {} }), { drift: false, checked: false });
});

test('a stale (older-version) worker copy warns, naming both versions', { skip: process.platform !== 'win32' }, async (t) => {
  const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cad-drift-')), 'fake-node.cmd');
  fs.writeFileSync(bin, '@echo off\r\necho v0.0.0-drift\r\n');
  const saved = process.env.CAD_WORKER_NODE;
  t.after(() => { if (saved === undefined) delete process.env.CAD_WORKER_NODE; else process.env.CAD_WORKER_NODE = saved; });
  process.env.CAD_WORKER_NODE = bin;
  const runm = await import('../lib/hub-workers-run.js');
  const warns = [];
  const out = runm.checkWorkerNodeVersion({ warn: (m) => warns.push(m) });
  assert.equal(out.drift, true, JSON.stringify(out));
  assert.equal(out.workerVersion, 'v0.0.0-drift');
  assert.equal(warns.length, 1);
  assert.ok(warns[0].includes('v0.0.0-drift') && warns[0].includes(process.version), warns[0]);
  assert.ok(/recopy|copy node\.exe/.test(warns[0]), warns[0]);
});

test('a worker copy that answers nothing warns it needs recopying', { skip: process.platform !== 'win32' }, async (t) => {
  const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cad-drift-')), 'mute.cmd');
  fs.writeFileSync(bin, '@echo off\r\n');
  const saved = process.env.CAD_WORKER_NODE;
  t.after(() => { if (saved === undefined) delete process.env.CAD_WORKER_NODE; else process.env.CAD_WORKER_NODE = saved; });
  process.env.CAD_WORKER_NODE = bin;
  const runm = await import('../lib/hub-workers-run.js');
  const warns = [];
  const out = runm.checkWorkerNodeVersion({ warn: (m) => warns.push(m) });
  assert.equal(out.drift, true, JSON.stringify(out));
  assert.equal(out.workerVersion, null);
  assert.ok(warns[0].includes('did not answer'), warns[0]);
});
