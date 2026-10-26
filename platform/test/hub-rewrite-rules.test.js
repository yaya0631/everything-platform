/** §22 zero-match rewrite rule: every serve-time rewrite rule must keep
 * matching something upstream, or the build fails with the rule name (and
 * the honest retirement path via the leave list). */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { REWRITE_RULES, countRuleHits, zeroMatchVerdict, cspHeader, CSP_SCRIPT_EXTRAS, applyAppJsRules, APP_JS_RULES } from '../lib/hub-rewrite.js';

test('the rule counter measures the real built dists (all rules match today)', () => {
  const counts = countRuleHits(path.join('data', 'hub', 'apps'));
  for (const r of REWRITE_RULES) {
    assert.ok(counts[r.name] > 0, `rule "${r.name}" matches zero files across all built dists — its check must fire`);
  }
});

test('M12: root-absolute collab worker fetches are rewritten onto the hub mount', () => {
  // The built share/deploy bundles fetch their worker sources from
  // root-absolute paths; serve time must point those fetches at /h/<app>/ or
  // sharing a board/album 404s.
  const cases = [
    ['whiteboard', 'wb-worker-path'],
    ['photo-studio', 'photo-worker-path'],
  ];
  for (const [app, ruleName] of cases) {
    const rule = APP_JS_RULES[app].find((r) => r.name === ruleName);
    const root = path.join('data', 'hub', 'apps', app);
    let hit = null;
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.js$/.test(e.name)) {
          const text = fs.readFileSync(full, 'utf8');
          if (text.includes(rule.old)) hit = text;
        }
      }
    })(root);
    assert.ok(hit, `${app}: the built bundle still carries the root-absolute worker fetch (rebuild data/hub/apps)`);
    const out = applyAppJsRules(hit, app);
    assert.deepEqual(out.applied, [ruleName], `${app} applied=${JSON.stringify(out.applied)} missed=${JSON.stringify(out.missed)}`);
    assert.ok(out.text.includes(rule.replacement));
    assert.ok(!out.text.includes(rule.old), `${app}: the root-absolute form must not survive`);
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
