/** §22 zero-match rewrite rule: every serve-time rewrite rule must keep
 * matching something upstream, or the build fails with the rule name (and
 * the honest retirement path via the leave list). */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { REWRITE_RULES, countRuleHits, zeroMatchVerdict, cspHeader, CSP_SCRIPT_EXTRAS } from '../lib/hub-rewrite.js';

test('the rule counter measures the real built dists (all rules match today)', () => {
  const counts = countRuleHits(path.join('data', 'hub', 'apps'));
  for (const r of REWRITE_RULES) {
    assert.ok(counts[r.name] > 0, `rule "${r.name}" matches zero files across all built dists — its check must fire`);
  }
});

test('countRuleHits: fixture dist hits shim-swap and html-strip, misses the rest', () => {
  const counts = countRuleHits(path.join('test', 'fixtures', 'hub', 'fixture-dist'));
  assert.ok(counts['shim-swap'] >= 1, 'the fixture loads js.puter.com twice');
  assert.ok(counts['html-strip'] >= 1, 'the fixture carries a plausible.io tag to strip');
  assert.equal(counts['sw-guard'], 0, 'fixture ships no sw.js');
  assert.equal(counts['manifest'], 0, 'fixture ships no manifest');
});

test('Parametric may compile wasm and its Emscripten glue; other apps stay strict', () => {
  const csp = cspHeader({ hashes: ['sha256-test'], extras: CSP_SCRIPT_EXTRAS.parametric });
  assert.match(csp, /script-src 'self' 'sha256-test' 'wasm-unsafe-eval' 'unsafe-eval'/);
  assert.doesNotMatch(cspHeader({ hashes: ['sha256-test'] }), /wasm-unsafe-eval|unsafe-eval/);
});

test('zeroMatchVerdict: a dist matching nothing fails unless the rule was retired', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-rules-'));
  try {
    fs.writeFileSync(path.join(root, 'app.js'), 'console.log("no js.puter.com here");\n');
    const verdict = zeroMatchVerdict(root, { leave: [] });
    assert.ok(verdict.bad.length >= 1, `should flag unretired zero rules: ${JSON.stringify(verdict)}`);
    assert.ok(verdict.bad.includes('shim-swap'));
    assert.ok(verdict.bad.includes('sw-guard'));
    // Retire everything → verdict is clean.
    const clean = zeroMatchVerdict(root, { leave: REWRITE_RULES.map((r) => r.name) });
    assert.deepEqual(clean.bad, []);
    assert.equal(clean.retired.length, REWRITE_RULES.length);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
