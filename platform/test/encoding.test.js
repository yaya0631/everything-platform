// Encoding guard: nothing in this repository's text files may contain the
// Unicode replacement character U+FFFD (mojibake/failed decoding) or a UTF-8
// BOM. File writes go through Node tooling, never PowerShell redirection,
// which produces exactly these artifacts when a UTF-8 file is re-saved as ANSI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
// Only generated/vendored content may be skipped; everything we author is scanned.
const EXCLUDE = new Set(['node_modules', 'data', '.git', 'dist', 'coverage', '.vite']);
const SCAN_EXT = /\.(js|mjs|cjs|html|css|md|json|webmanifest)$/i;
const JSON_TMP = path.join(ROOT, 'data', 'bom-probe.json');

function collect(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (EXCLUDE.has(e.name) || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collect(full, out);
    else if (SCAN_EXT.test(e.name)) out.push(full);
  }
  return out;
}

test('repo text files carry no U+FFFD and no BOM', () => {
  const files = collect(ROOT, []);
  // Author-written trees to include explicitly when they sit inside excluded dirs.
  collect(path.join(ROOT, 'app', 'src'), []);
  const appSrc = collect(path.join(ROOT, 'app', 'src'), []);
  const all = [...new Set([...files, ...appSrc])];
  assert.ok(all.length > 60, `scan should cover the repo (found ${all.length} files)`);

  const bad = [];
  for (const f of all) {
    const buf = readFileSync(f);
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      bad.push(`${path.relative(ROOT, f)} has a UTF-8 BOM`);
    }
    const text = buf.toString('utf8');
    const fffd = (text.match(/\uFFFD/g) || []).length;
    if (fffd > 0) bad.push(`${path.relative(ROOT, f)} has ${fffd} × U+FFFD`);
  }
  assert.deepEqual(bad, [], 'encoding damage in: ' + bad.join('; '));
});

test('JSON state readers tolerate a UTF-8 BOM (build-state.json robustness)', () => {
  mkdirSync(path.dirname(JSON_TMP), { recursive: true });
  const state = { apps: { sudoku: { ok: true, ms: 15970 } } };
  // PowerShell-style re-save: EF BB BF then normal UTF-8.
  writeFileSync(JSON_TMP, Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(JSON.stringify(state, null, 2)),
  ]));
  return import('../lib/jsonread.js').then(({ readJsonFile, stripBom }) => {
    assert.deepEqual(readJsonFile(JSON_TMP), state);
    writeFileSync(JSON_TMP, JSON.stringify(state)); // no-BOM case still parses
    assert.deepEqual(readJsonFile(JSON_TMP), state);
    assert.equal(stripBom('\uFEFFx'), 'x');
    assert.equal(stripBom('y'), 'y');
    unlinkSync(JSON_TMP);
  });
});
