// The hub's per-app source mapping. The owner's unified layout (2026-10-22):
// EVERY app - including the cad client - builds from the same home,
// upstream\src\<name>. The cad app there is the local-fork commit of this
// platform's rework (clone commit c2a28773 replacing the original at 0fc4d361;
// the original stays recoverable in the clone's history).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { appSourceDir, sourceKind } from '../lib/hub-build.js';

test('source mapping: all apps - cad included - build from upstream\\src\\<name>', () => {
  for (const name of ['cad', 'chess', 'calendar']) {
    assert.equal(sourceKind(name), 'upstream');
    const dir = appSourceDir(name);
    assert.ok(
      path.normalize(dir).includes(path.join('upstream', 'src', name)),
      `${name} source is upstream\\src\\${name}, got ${dir}`,
    );
  }
});

test('source mapping: the cad dir is OUR fork of it (platform-native rework markers)', () => {
  const dir = appSourceDir('cad');
  assert.ok(path.normalize(dir).endsWith(path.join('upstream', 'src', 'cad')));
  // The fork's identity markers: our local-cloud stand-in instead of the
  // original Puter-SDK wiring, and the shipped test suite.
  assert.ok(fs.existsSync(path.join(dir, 'src', 'local-cloud.js')), 'local-cloud.js is present (our rework, not the pristine original)');
  assert.ok(fs.existsSync(path.join(dir, 'tests')), 'the cad suite moved with the app');
});

test('source mapping: an unknown app is refused with the named error', () => {
  assert.throws(() => appSourceDir('__does_not_exist__'), /No app/);
});
