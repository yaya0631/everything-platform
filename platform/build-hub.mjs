#!/usr/bin/env node
/**
 * Derives each app's tier from what puter.* APIs its source actually calls,
 * then (with `build-all`) installs the easy-tier apps one at a time:
 *
 *   node build-hub.mjs scan                 — the tier report, app by app
 *   node build-hub.mjs build-all [--prune] [--force] [--only name,name]
 *   node build-hub.mjs status              — what build-all did so far
 *
 * One app at a time, npm memory-capped, `npm ci` when a lockfile ships,
 * `--prune` after each build, and the upstream clone must be clean before
 * and after every build. State lives in data/hub/build-state.json so a
 * crashed run resumes with --resume semantics (done apps are skipped).
 */
import fs from 'node:fs';
import path from 'node:path';
import { stripBom } from './lib/jsonread.js';
import * as hub from './lib/hub.js';
import * as hubWorkersApi from './lib/hub-workers.js';
import { buildApp, upstreamRoot, cloneDirty, appSourceDir, sourceKind, BuildError, ROOT_DIR } from './lib/hub-build.js';
import { zeroMatchVerdict, REWRITE_RULES } from './lib/hub-rewrite.js';
import * as configm from './lib/config.js';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n) && { on: true };
const getArg = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const cmd = argv[0] || 'scan';

// -- the tier scan ----------------------------------------------------------------------

/** puter.* call names, collected per app dir from the bundled client sources. */
function apiUsage(dir) {
  const out = new Set();
  const RE = /puter\.(ai|kv|fs|ui|hosting|workers|net|email|perms|auth)\.([a-zA-Z_$][\w$]*)/g;
  const scan = (d) => {
    let list;
    try {
      list = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'build') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) scan(p);
      else if (/\.(js|jsx|ts|tsx|svelte|vue|mjs)$/.test(e.name)) {
        let text;
        try {
          text = fs.readFileSync(p, 'utf8');
        } catch {
          continue;
        }
        for (const m of text.matchAll(RE)) out.add(`${m[1]}.${m[2]}`);
      }
    }
  };
  scan(path.join(dir, 'src'));
  return [...out];
}

const EASY_UI = new Set([
  'ui.showOpenFilePicker', 'ui.showSaveFilePicker', 'ui.showDirectoryPicker', 'ui.alert', 'ui.prompt',
  'ui.setWindowTitle', 'ui.disableZoom', 'ui.contextMenu',
]);
const EASY_UI_PREFIX = ['ui.onWindowClose', 'ui.showWindow', 'ui.hideWindow'];
const HARD_PREFIX = ['hosting.', 'workers.', 'net.', 'email.', 'perms.'];

function tierOf(dir) {
  const raw = apiUsage(dir);
  const calls = new Set(raw);
  const hard = [...calls].filter((c) => HARD_PREFIX.some((p) => c.startsWith(p)));
  const aiEngines = [...calls].filter((c) => /^ai\./.test(c) && !/^ai\.chat$/.test(c));
  const launchedWithItems = [...calls].some((c) => c === 'ui.onLaunchedWithItems' || c === 'ui.onItemsOpened');
  const suspiciousUi = [...calls].filter((c) => c.startsWith('ui.') && !EASY_UI.has(c) && !EASY_UI_PREFIX.some((p) => c.startsWith(p)));
  // Vision is fine (lib/ai.js carries it); only the promised engines are missing features.
  let tier = 'easy';
  const reasons = [];
  if (hard.length) {
    tier = 'does not';
    reasons.push(`needs ${hard.join(', ')}`);
  } else if (aiEngines.length) {
    tier = 'partly';
    reasons.push(`engines missing: ${aiEngines.join(', ')}`);
  } else if (launchedWithItems) {
    tier = 'partly';
    reasons.push('UI.onLaunchedWithItems is a no-op (ledger)');
  } else if (suspiciousUi.length) {
    tier = 'partly';
    reasons.push(`window UI beyond this phase: ${suspiciousUi.join(', ')}`);
  }
  return { calls: [...calls].sort(), tier, reasons, suspiciousUi };
}

function allApps() {
  const srcDir = path.join(upstreamRoot(), 'src');
  const out = [];
  for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const dir = path.join(srcDir, e.name);
    const pkg = path.join(dir, 'package.json');
    if (!e.isDirectory() || !fs.existsSync(pkg)) continue;
    const manifest = JSON.parse(stripBom(fs.readFileSync(pkg, 'utf8')));
    if (manifest.scripts?.build) out.push(e.name);
  }
  return out;
}

// -- building ---------------------------------------------------------------------------

const stateFile = path.join(ROOT_DIR, 'data', 'hub', 'build-state.json');
function readState() {
  try {
    return JSON.parse(stripBom(fs.readFileSync(stateFile, 'utf8')));
  } catch {
    return { apps: {} };
  }
}
function writeState(state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

async function buildOne(name, opts, state) {
  const t0 = Date.now();
  console.log(`\n=== ${name} ===`);
  // Own-source apps (SOURCE_OVERRIDES in lib\hub-build.js) build from this
  // repo, so the pristine-clone guards below do not apply to them.
  const own = sourceKind(name) === 'own';
  if (!own && cloneDirty()) throw new BuildError('the upstream clone is dirty — commit or clean it before building');
  let built;
  try {
    built = buildApp(name, { prune: opts.prune });
  } catch (err) {
    state.apps[name] = { ok: false, at: Date.now(), error: String(err.message || err).slice(0, 500) };
    writeState(state);
    throw err;
  }
  if (!own && cloneDirty()) throw new BuildError('the upstream clone went dirty during the build — aborting install');
  const info = hub.installFromDist(name, built.distDir, {
    sha: built.sha || 'imported', base: built.base, source: 'build', title: built.title, description: built.description,
  });
  // §10: the app's own workers/<name>.js files become server-owned packaged
  // workers (calendar-email, field-service-email, invoicing-email,
  // puter-meetings-rooms …) — resolved first on exec, re-approved on sha
  // change, deleted by no member.
  let packaged;
  try {
    packaged = await hubWorkersApi.installPackagedFromDist(name, built.distDir, { log: (m) => console.log(`  ${m}`) });
  } catch (err) {
    console.log(`  packaged workers: ${err.message || err}`);
    packaged = [];
  }
  state.apps[name] = { ok: true, at: Date.now(), ms: Date.now() - t0, files: info?.files ?? undefined, workers: packaged };
  writeState(state);
  console.log(`  installed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

async function buildAll() {
  const opts = { prune: !!flag('--prune'), force: !!flag('--force') };
  const only = (getArg('--only') || '').split(',').filter(Boolean);
  const easy = [];
  const skip = [];
  for (const name of allApps()) {
    const { tier, reasons } = tierOf(appSourceDir(name));
    if (tier === 'easy') easy.push(name);
    else skip.push(`${name} (${tier}${reasons.length ? ': ' + reasons.join('; ') : ''})`);
  }
  console.log(easy.length ? `easy tier (${easy.length}): ${easy.join(', ')}` : 'no easy-tier apps found');
  if (skip.length) console.log(`skipped by tier:\n  - ${skip.join('\n  - ')}`);

  const state = readState();
  for (const name of easy) {
    if (only.length && !only.includes(name)) continue;
    if (!opts.force && state.apps[name]?.ok) {
      console.log(`\n=== ${name} ===\n  already built (data/hub/build-state.json) — use --force to rebuild`);
      continue;
    }
    try {
      await buildOne(name, opts, state);
    } catch (err) {
      console.error(`BUILD FAILED: ${name}: ${err.message || err}`);
      // keep going: one bad app must not stop the batch
    }
  }
  console.log('\nBatch finished. Summary:');
  for (const [name, s] of Object.entries(state.apps)) console.log(`  ${s.ok ? 'OK   ' : 'FAIL '} ${name}`);
  // §22: a rule matching zero built dists fails the build run loudly.
  zeroMatchCheck();
}

async function buildOneOffTier() {
  const names = (getArg('--only') || '').split(',').filter(Boolean);
  if (!names.length) {
    console.error('build-one needs --only a,b — apps whose tier is not easy are built here DELIBERATELY (their productization lands beside the build; the tier flips only after the §15/§24 gate passes)');
    process.exitCode = 2;
    return;
  }
  const state = readState();
  for (const name of names) {
    const { tier, reasons } = tierOf(appSourceDir(name));
    console.log(`tier: ${tier}${reasons.length ? ` (${reasons.join('; ')})` : ''}`);
    try {
      await buildOne(name, { prune: !!flag('--prune') }, state);
    } catch (err) {
      console.error(`BUILD FAILED: ${name}: ${err.message || err}`);
      process.exitCode = 1;
    }
  }
}

// -- §22 zero-match rule check -----------------------------------------------------------

/**
 * Runs every serve-time rewrite rule over all built dists; a rule matching
 * ZERO times across all of them fails the build with the rule name — an
 * upstream change silently obsoleting a rewrite instead of it failing open.
 * A deliberately retired rule goes through `hub.zero_match_leave` (comma
 * list, config or CAD_ZERO_MATCH_LEAVE env), which is itself audited by the
 * printed counts.
 */
function zeroMatchCheck({ print = true } = {}) {
  const root = path.join('data', 'hub', 'apps');
  const leave = [
    ...String(configm.get('hub.zero_match_leave', '') ?? '').split(','),
    ...String(process.env.CAD_ZERO_MATCH_LEAVE ?? '').split(','),
  ];
  const { counts, bad } = zeroMatchVerdict(root, { leave, print });
  if (bad.length) {
    throw new BuildError(`serve-time rewrite rule(s) match ZERO files across all built dists: ${bad.join(', ')} — the upstream shape changed; fix or retire the rule via hub.zero_match_leave`);
  }
  return counts;
}

// -- commands ---------------------------------------------------------------------------

if (cmd === 'scan') {
  for (const name of allApps()) {
    const { tier, reasons, calls } = tierOf(appSourceDir(name));
    console.log(`${tier.padEnd(9)} ${name.padEnd(22)} ${reasons.join('; ') || calls.join(', ')}`);
  }
} else if (cmd === 'rules') {
  const counts = zeroMatchCheck({ print: true });
  const zeros = REWRITE_RULES.map((r) => r.name).filter((n) => !counts[n]);
  console.log(zeros.length ? `zero-match rule(s) left to retirement: ${zeros.join(', ')}` : 'every rewrite rule still matches something upstream');
  process.exitCode = 0;
} else if (cmd === 'build-all') {
  await buildAll();
} else if (cmd === 'build-one') {
  await buildOneOffTier();
} else if (cmd === 'status') {
  statusCommand({ json: flag('--json') });
} else {
  console.log('usage: node build-hub.mjs [scan | rules | build-all [--prune] [--force] [--only a,b] | build-one --only a,b | status [--json]]');
}

// -- status: per-app ground truth, read from the artifacts of real runs -------

/**
 * One row per upstream app that has a build script (51): tier (scan), built
 * state (data/hub/build-state.json), installed state (hub_apps registry) and
 * the LATEST smoke verdict per app across the browser-smoke-results*.json
 * files a real Chromium pass wrote — nothing here is hand-typed or carried
 * between reports; every number is read from disk at run time. `--json`
 * emits { apps: [...] } for scripts.
 */
function statusCommand({ json = false } = {}) {
  const names = allApps();
  const state = readState();
  const installed = new Map(hub.listApps().map((a) => [a.name, a]));

  // latest smoke verdict per app over every results file the smoke pass
  // wrote (guard on/off runs coexist; the newest `at` per app wins).
  const smoke = new Map();
  for (const f of fs.readdirSync(ROOT_DIR).filter((f) => /^browser-smoke-results.*\.json$/.test(f))) {
    let parsed;
    try {
      parsed = JSON.parse(stripBom(fs.readFileSync(path.join(ROOT_DIR, f), 'utf8')));
    } catch {
      continue; // a half-written results file must not break status
    }
    for (const r of parsed.results ?? []) {
      const at = Date.parse(parsed.at ?? 0) || 0;
      const prev = smoke.get(r.name);
      if (!prev || at > prev.at) smoke.set(r.name, { at, file: f, mode: parsed.mode, swGuard: r.swGuard, loads: r.loads, external: r.net?.externalCount, bad: r.net?.badCount, failed: r.net?.failedCount, errors: r.net?.otherErrors?.length ?? null, csp: r.csp?.count || 0 });
    }
  }

  const gatesDir = path.join(ROOT_DIR, 'data', 'hub', 'test-gates');
  const readEvidence = (file) => {
    try { return JSON.parse(fs.readFileSync(path.join(gatesDir, file), 'utf8')); } catch { return null; }
  };
  const e2eEvidence = new Map();
  for (const f of fs.readdirSync(ROOT_DIR).filter((f) => /^[a-z0-9-]+-e2e-results\.json$/i.test(f) || f === 'sign-e2e-results.json')) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, f), 'utf8'));
      const cases = Array.isArray(data.steps) ? data.steps : (Array.isArray(data.results) ? data.results : []);
      const app = f === 'sign-e2e-results.json' ? 'signatures' : f.replace(/-e2e-results\.json$/i, '');
      e2eEvidence.set(app, { passed: cases.filter((x) => x.pass === true || x.passed === true).length, total: cases.length, pass: !!data.pass && cases.length > 0, at: data.at ?? null, file: f });
    } catch { /* ignore an incomplete result file */ }
  }

  const provided = (api) => {
    if (api.startsWith('workers.')) return new Set(['create', 'list', 'get', 'delete', 'exec']).has(api.slice(8));
    if (api.startsWith('hosting.')) return new Set(['create', 'list', 'get', 'update', 'delete']).has(api.slice(8));
    if (api === 'email.send') return true; // worker SMTP bridge is implemented; SMTP configuration remains an admin setting.
    return false;
  };
  const rows = names.map((name) => {
    const scan = tierOf(appSourceDir(name));
    const b = state.apps[name];
    const inst = installed.get(name);
    const s = smoke.get(name);
    const suite = readEvidence(`${name}-suite.json`);
    const adapter = readEvidence(`${name}.json`);
    // Upstream suites and adapters run upstream code in upstream harnesses.
    // Only a case explicitly marked runtimeCovered after exercising this
    // server's runner/shim/hub API counts toward server coverage.
    const upstreamSuite = suite?.total != null
      ? { covered: suite.passed, total: suite.total, pass: suite.exit_code === 0 && suite.failed === 0, execution: 'upstream code and harness only' }
      : null;
    const upstream = adapter?.total != null
      ? { covered: adapter.runtimeCovered ?? 0, total: adapter.runtimeTotal ?? adapter.total, passed: (adapter.runtimeCovered ?? 0) === (adapter.runtimeTotal ?? adapter.total), upstreamPassed: adapter.covered === adapter.total, upstreamCovered: adapter.covered, source: adapter.execution ?? 'upstream adapter only', at: adapter.at }
      : suite?.total != null
        ? { covered: suite.runtimeCovered ?? 0, total: suite.total, passed: (suite.runtimeCovered ?? 0) === suite.total, upstreamPassed: suite.exit_code === 0 && suite.failed === 0, upstreamCovered: suite.passed, source: 'upstream suite only', at: suite.at }
        : null;
    const functional = readEvidence(`${name}-functional.json`);
    const easyTier = scan.tier === 'easy';
    const functionalPass = !!functional?.pass && functional.kvRestart?.pass === true
      && functional.fsRoundTrip?.pass === true
      && (functional.calls?.length > 0 || functional.appLocalPuter === true)
      // Same first-run policy as functional-gate.mjs (declared 2026-10-23):
      // a rejected `puter.fs.read` with `code: 'not_found'` is an expected
      // empty-drive miss the app handles by seeding defaults; anything else
      // unresolved fails the gate. appLocalPuter marks apps (cad) that ship
      // their own puter adapter, where the platform shim's call log does not
      // exist and the round-trip/restart evidence carries the verdict.
      && functional.calls.every((call) => call.status === 'resolved'
        || (call.method === 'puter.fs.read' && call.code === 'not_found'));
    const e2e = e2eEvidence.get(name) ?? null;
    const needsE2e = ['signatures', 'invoicing'].includes(name);
    const requiredServices = scan.calls.filter((c) => HARD_PREFIX.some((p) => c.startsWith(p)));
    const serviceGates = requiredServices.map((service) => ({ service, provided: provided(service) }));
    const smokeClean = !!s && !!s.loads && s.external === 0 && s.bad === 0 && s.failed === 0 && s.errors === 0 && s.csp === 0;
    const e2ePass = needsE2e ? !!e2e?.pass : true;
    const gates = {
      source: sourceKind(name),
      built: !!b?.ok,
      installed: !!inst?.enabled,
      smoke: { pass: smokeClean, external: s?.external ?? null, http_bad: s?.bad ?? null, failed: s?.failed ?? null, other_errors: s?.errors ?? null, csp: s?.csp ?? null },
      upstream: upstream ? { pass: upstream.passed, covered: upstream.covered, total: upstream.total, source: upstream.source, upstream_only_suite: upstreamSuite } : { pass: easyTier ? functionalPass : false, covered: 0, total: null, source: easyTier ? 'generic-functional-gate' : 'missing' },
      e2e: needsE2e ? { pass: e2ePass, covered: e2e?.passed ?? 0, total: e2e?.total ?? null, file: e2e?.file ?? null } : { pass: true, required: false },
      services: { pass: serviceGates.every((x) => x.provided), required: serviceGates },
    };
    const works = gates.built && gates.installed && gates.smoke.pass && gates.upstream.pass && gates.e2e.pass && gates.services.pass;
    return {
      name,
      status: works ? 'works' : 'does not',
      source_scan: scan.tier,
      source_scan_reason: scan.reasons.join('; ') || null,
      installed: inst ? { at: inst.installed_at ?? undefined, sha: inst.sha, source: inst.source, enabled: inst.enabled, files: inst.files } : null,
      built: b ? { ok: !!b.ok, at: b.at, ms: b.ms ?? undefined, error: b.error ?? undefined, packaged_workers: (b.workers ?? []).length || undefined } : null,
      smoke: s ? { loads: !!s.loads, at: new Date(s.at).toISOString(), file: s.file, mode: s.mode, sw_guard: s.swGuard, external: s.external, http_bad: s.bad, failed: s.failed, other_errors: s.errors, csp: s.csp } : null,
      upstream_test_coverage: upstream,
      upstream_only_suite: upstreamSuite,
      functional_gate: easyTier ? functional : null,
      functional_gate_pass: easyTier ? functionalPass : null,
      worker_adapter_coverage: adapter ? { covered: adapter.covered, total: adapter.total, files: adapter.files ?? null } : null,
      e2e,
      required_services: serviceGates,
      gates,
    };
  });

  if (json) {
    console.log(JSON.stringify({ at: new Date().toISOString(), apps: rows }, null, 2));
    return;
  }

  const pad = (v, n) => String(v ?? '').padEnd(n).slice(0, n);
  console.log(`${pad('app', 18)} ${pad('status', 10)} ${pad('src', 5)} ${pad('smoke', 7)} ${pad('server tests', 14)} ${pad('upstream only', 18)} ${pad('E2E', 10)} ${pad('services', 10)} ${pad('built', 7)} ${pad('installed', 9)}`);
  console.log('-'.repeat(133));
  const t = { built: 0, ok: 0, smoke: 0, loads: 0, works: 0 };
  for (const r of rows) {
    if (r.built) { t.built += 1; t.ok += r.built.ok ? 1 : 0; }
    if (r.smoke) { t.smoke += 1; t.loads += r.smoke.loads ? 1 : 0; }
    if (r.status === 'works') t.works += 1;
    console.log(
      `${pad(r.name, 18)} ${pad(r.status, 10)} ${pad(r.gates.source === 'own' ? 'own' : 'up', 5)} ${pad(r.gates.smoke.pass ? 'PASS' : 'PENDING', 7)} `
    + `${pad(r.upstream_test_coverage ? `${r.upstream_test_coverage.covered}/${r.upstream_test_coverage.total}` : (r.functional_gate ? (r.functional_gate_pass ? 'functional' : 'func-fail') : r.source_scan === 'easy' ? 'func-pending' : '-'), 14)} `
      + `${pad(r.upstream_only_suite ? `${r.upstream_only_suite.covered}/${r.upstream_only_suite.total}` : '-', 18)} `
      + `${pad(r.gates.e2e.required === false ? 'n/a' : r.gates.e2e.pass ? `${r.gates.e2e.covered}/${r.gates.e2e.total}` : '-', 10)} `
      + `${pad(r.gates.services.pass ? 'PASS' : 'PENDING', 10)} ${pad(r.gates.built ? 'yes' : 'no', 7)} ${pad(r.gates.installed ? 'yes' : 'no', 9)}`,
    );
  }
  console.log('-'.repeat(127));
  console.log(`${rows.length} apps | status works ${t.works}/${rows.length} | built ${t.ok}/${t.built} state rows ok | smoke seen for ${t.smoke} | loads ${t.loads}/${t.smoke}`);
}
