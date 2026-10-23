#!/usr/bin/env node
/**
 * Writes the invoicing runtime-coverage EXCLUDED-case ledger:
 * data/hub/test-gates/invoicing-runtime-excluded.json — the exact names of
 * the mailer.test.js cases that are upstream-only BY CLASSIFICATION (the
 * bridge contract is deliberately canned per case; the file has zero
 * kv/fs/runtime transport refs), plus the runtime-exercisable ledger
 * (email-worker.test.js, 59 cases) that test/invoicing-runtime.test.js maps.
 *
 * Measured denominator facts (real vitest): email-worker 59 + mailer 37 =
 * 96 cases in the two worker-focused files; runtime-exercisable = 59.
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';

register(pathToFileURL(path.resolve('test', 'vitest-shim', 'hooks.mjs')).href);
const shim = await import(pathToFileURL(path.resolve('test', 'vitest-shim', 'index.mjs')).href);

// mailer.test.js, upstream-only: the adapter imports it under the vitest shim
// WITHOUT the runtime marker, so helper paths (none in this file anyway)
// never resolve to the runtime seam and the upstream code runs as-is.
shim.openFileScope();
await import(pathToFileURL(path.resolve('..', 'upstream', 'src', 'invoicing', 'tests', 'mailer.test.js')).href);
const { suites, loose } = shim.casesOf();
const names = [];
for (const suite of suites) for (const item of suite.its) names.push(`${suite.name} - ${item.name}`);
for (const item of loose) names.push(item.name);

const excluded = {
  app: 'invoicing',
  file: 'src/invoicing/tests/mailer.test.js',
  cases: names,
  count: names.length,
  reason: 'bridge-contract/app-logic cases: sendDocument is exercised against a deliberately canned '
    + 'workers.exec reply (the case controls the transport; timeout/reachability/error shapes cannot be '
    + 'produced by a real dispatch without changing the case), and digest/base64of/caps/describe* are pure '
    + 'app logic. The file has zero kv/fs/runtime transport refs, so under the runtime-coverage definition '
    + '(a case must exercise the cad-home runtime) it is classified upstream-only. The worker side these '
    + 'canal cases talk to IS measured at runtime: email-worker.test.js (59 cases) runs the real worker '
    + 'source through cad-home\'s seam, and the deploy + exec canal + public wrapper behavior of the '
    + 'packaged invoicing-email worker is exercised against the real server by the root suite and '
    + 'invoicing-e2e.mjs.',
  at: new Date().toISOString(),
};

const dir = path.resolve('data', 'hub', 'test-gates');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'invoicing-runtime-excluded.json'), JSON.stringify(excluded, null, 2));
console.log(`excluded (documented): mailer.test.js ${excluded.count} cases -> ${excluded.caseFile || dir}`);
console.log('runtime-exercisable ledger stays with test/invoicing-runtime.test.js (59).');
void assert;
