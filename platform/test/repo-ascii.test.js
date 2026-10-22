/**
 * Repo hygiene: every .md and .js file we author is English (or French where
 * an interface string needs it) — no CJK characters should survive a copy
 * from a design chat into a source file. Kana/Hangul/fullwidth forms fail the
 * same way: they are the usual shape of an accidental paste.
 */
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ROOT } from '../lib/paths.js';

const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;

const SKIP_DIRS = new Set(['node_modules', 'data', 'app', 'dist', '.git', 'worker-tmp', 'workers']);

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.isDirectory() && entry.name !== '.well-known') continue;
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(rel);
    } else if (/\.(md|js|mjs|cjs)$/i.test(entry.name)) {
      yield rel;
    }
  }
}

test('repo sources are CJK-free (no accidental paste)', () => {
  const bad = [];
  for (const abs of walk(ROOT)) {
    const rel = path.relative(ROOT, abs);
    // The vendored fixture-app sources are upstream data, not our prose.
    if (rel.startsWith('test' + path.sep + 'fixtures')) continue;
    const text = fs.readFileSync(abs, 'utf8');
    if (CJK.test(text)) {
      for (const [i, line] of text.split('\n').entries()) {
        if (CJK.test(line)) bad.push(`${rel}:${i + 1}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});
