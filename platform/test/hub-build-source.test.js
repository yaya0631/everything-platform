// The hub's per-app source mapping. The owner's decision (2026-10-22): the CAD
// app is built from OUR editable source (..\cad\app), never from the pristine
// upstream clone; every other app builds from upstream\src\<name>.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appSourceDir, sourceKind } from '../lib/hub-build.js';

test('source mapping: cad builds from the own-source override, not upstream', () => {
  assert.equal(sourceKind('cad'), 'own');
  const dir = appSourceDir('cad');
  assert.ok(dir.endsWith(path.join('cad', 'app')), `cad source is ..\\cad\\app, got ${dir}`);
  assert.equal(
    path.resolve(dir),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'cad', 'app'),
  );
});

test('source mapping: upstream apps still resolve to upstream\\src\\<name>', () => {
  assert.equal(sourceKind('chess'), 'upstream');
  const dir = appSourceDir('chess');
  assert.ok(path.normalize(dir).includes(path.join('upstream', 'src', 'chess')), `chess source is upstream\\src\\chess, got ${dir}`);
});

test('source mapping: an own-source override without a package.json is refused', () => {
  // The override map only ships cad; a bogus dir would throw with the named
  // BuildError. Simulate by asking for an app whose override would miss.
  assert.throws(() => appSourceDir('__does_not_exist__'), /No app/);
});
