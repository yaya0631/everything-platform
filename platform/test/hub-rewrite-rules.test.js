/** §22 zero-match rewrite rule: every serve-time rewrite rule must keep
 * matching something upstream, or the build fails with the rule name (and
 * the honest retirement path via the leave list). */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { REWRITE_RULES, countRuleHits, zeroMatchVerdict, cspHeader, CSP_SCRIPT_EXTRAS, EXTERNAL_EMBED_SOURCES, applyAppJsRules, APP_JS_RULES, rewriteJs, rewriteCss } from '../lib/hub-rewrite.js';

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

test('frame-src is closed at home and opens only to the embed allowlist (m4)', () => {
  const closed = cspHeader({ hashes: ['sha256-test'] });
  assert.match(closed, /frame-src 'self'/);
  assert.doesNotMatch(closed, /youtube|vimeo|docs\.google/);
  const open = cspHeader({ hashes: ['sha256-test'], frameExtras: EXTERNAL_EMBED_SOURCES });
  assert.ok(open.includes("frame-src 'self' " + EXTERNAL_EMBED_SOURCES.join(' ')), open);
  assert.match(open, /https:\/\/www\.youtube-nocookie\.com/);
  assert.match(open, /https:\/\/player\.vimeo\.com/);
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

test('M6: the 3d bundle\'s Pyodide CDN URL is rewritten to the vendored runtime', () => {
  const bundle = 'let aw=`https://cdn.jsdelivr.net/pyodide/v${iw}/full/`, load=()=>import(`${aw}pyodide.mjs`); const pin="https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide.asm.wasm"; const font="/assets/inter-latin-400-normal-CyCys3Eg.woff";';
  const out = rewriteJs(bundle, { name: '3d' }).text;
  assert.match(out, /aw=`\/hub\/pyodide\/`/);
  assert.match(out, /import\(`\$\{aw\}pyodide\.mjs`\)/);
  assert.match(out, /\/hub\/pyodide\/pyodide\.asm\.wasm/);
  assert.match(out, /font="\/h\/3d\/assets\/inter-latin-400-normal-CyCys3Eg\.woff"/);
  assert.doesNotMatch(out, /cdn\.jsdelivr\.net\/pyodide/, out);
});

test('M6: 3d may compile the vendored wasm; no external script origin is allowed', () => {
  const csp = cspHeader({ extras: CSP_SCRIPT_EXTRAS['3d'] });
  assert.match(csp, /script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'/);
  assert.doesNotMatch(csp, /cdn\.jsdelivr|https:\/\/cdn\./);
});

test('root-absolute CSS assets get the app prefix; hub and external URLs stay', () => {
  const css = [
    '@font-face{src:url(/assets/demo.woff2)format("woff2")}',
    'body{background:url("/assets/bg.png")}',
    '.keep{background:url(/hub/pyodide/x)}',
    '.ext{background:url(https://example.com/x.png)}',
    '.cdn{background:url(//example.com/y.png)}',
    '@import "/assets/theme.css";',
  ].join('\n');
  const out = rewriteCss(css, { name: '3d' });
  assert.match(out, /url\(\/h\/3d\/assets\/demo\.woff2\)/);
  assert.match(out, /url\("\/h\/3d\/assets\/bg\.png"\)/);
  assert.match(out, /url\(\/hub\/pyodide\/x\)/);
  assert.match(out, /url\(https:\/\/example\.com\/x\.png\)/);
  assert.match(out, /url\(\/\/example\.com\/y\.png\)/);
  assert.match(out, /@import "\/h\/3d\/assets\/theme\.css"/);
  assert.equal(rewriteCss(css), css, 'no app name means no rewrite');
});

test('fleet NHTSA lookups point at the opt-in proxy and keep an honest offline message', () => {
  const src = [
    'const K="https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/",M="https://api.nhtsa.gov/recalls/recallsByVehicle";',
    'throw new Error("The VIN lookup service could not be reached. Check your connection.");',
    'throw new Error("The VIN lookup service did not answer. Try again later.");',
    'throw new Error("The recall service could not be reached. Check your connection.");',
    'throw new Error("The recall service did not answer. Try again later.");',
  ].join('\n');
  const out = applyAppJsRules(src, 'fleet');
  assert.deepEqual(out.missed, []);
  assert.equal(out.applied.length, APP_JS_RULES.fleet.length);
  assert.ok(out.text.includes('"/hub/nhtsa/vpic/"'));
  assert.ok(out.text.includes('"/hub/nhtsa/recalls"'));
  assert.ok(!out.text.includes('vpic.nhtsa.dot.gov'));
  assert.ok(!out.text.includes('api.nhtsa.gov'));
  assert.match(out.text, /Vehicle lookups are unavailable on this server/);
  assert.match(out.text, /Recall lookups are unavailable on this server/);
  assert.match(out.text, /Admin → Hub/);
});
