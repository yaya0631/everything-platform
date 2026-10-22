# AI PROGRESS LOG — cad-home

**Read this file FIRST if you are an LLM session taking over.** It is the continuable
record of all progress and actions. `docs\AGENTS.md` §5 holds the same state in the
owner's step-report format; this file holds the chronological session log plus the
protocol below.

## Protocol (every session, no prompting needed)

1. **When you START working:** read the whole "Snapshot" and the latest session entry,
   then, *before doing anything else*, append a new session entry at the bottom of the
   log with heading `## Session <N> - <date> - <one-line goal>` containing sections
   `### Actions (running log)` and `### Result`. Update it AS you go (after each
   meaningful action), not only at the end.
2. **When you FINISH (or pause):** fill/refresh: suite counts actually run, git head,
   "verified by running" vs "assumed" split, open decisions, exact next steps.
3. Commit after every finished step (clear message); update `AGENTS.md` §5 after every
   finished step; never leave a verdict on stale evidence — re-run the thing.
4. Protected rules: no feature removal. **No external network calls FROM APPS:** apps
   never call Puter's cloud or any external API directly — everything goes through the
   owner's server. Server-side code may call external services it is configured for
   (AI providers, SMTP, etc.). No editing test expectations to make red tests pass
   (declare any changed test + why: which, why), no peer-relay code before owner
   re-approves design §29, upstream clone stays clean at `0fc4d361`, keep
   `data\_dbdiag-20261022123133\` (proven lossless, kept on owner order).
5. Throwaway probe scripts start with `_`; their `CAD_DATA_DIR` must be a fresh
   `fs.mkdtempSync` BEFORE importing `./server.js`, or they hit the REAL `data\cad.db`.
   Delete throwaways at docs pass. Root suite: `npm test`; app suite:
   `npm --prefix app test`; status: `node build-hub.mjs status`. Capture `2>&1`.

## Snapshot (as of 2026-10-22 — session of git `c8e1d5a → 107c76f`)

- Root suite: **377/377 PASS**; app suite: **482/482 PASS**; `build-hub.mjs status` runs.
- `invoicing-e2e.mjs` **11/11**; `sign-e2e.mjs` **12/17** (one owner-decision conflict, below).
- Git head `107c76f` on `master` (baseline `c8e1d5a`); user identity configured locally
  (`cad-home-agent <agent@local>`); upstream clone clean at `0fc4d361`.
- Owner decisions LIVE in code: URL-alias boundary (§23 server shape + §26 shim
  canonical alias), redeploy-UPDATE with approval-reset audit, cal-arm parseW ordering.
- Real defect fixed this round: shim fetch-override Request-chaining detached POST
  bodies in real Chromium (`lib\shim\puter.js`, test `test\shim-fetch-body.test.js`).
- DB: startup integrity gate + `_dbrecover-` byte backup in `lib\db.js`; WAL checkpoint
  on clean close; `node tools\db-backup.mjs` (VACUUM INTO) + README section.
- `/site` MIME allowlist gained `.ics` (contracts feeds) + test.
- Design doc: §28 rewritten as an honest file:line census (0 per-app rules needed);
  §27 gained the per-app publish table; §29 peer-relay design AWAITS OWNER REVIEW
  (3 acceptance questions; NO peer code allowed yet).
- Parking lot needing OWNER adjudication: §24's E2E driver expects guest links /
  worker-config urls in the OLD §23 pubBase form while §26 gives apps only the
  canonical alias — the driver's guest `page.goto` cannot map an alias host
  (details in `AGENTS.md` §5, "Decision 2" block). No test was changed for it.
- Folder layout (verified 2026-10-22, evidence-based): `D:\Stream\everything\` holds
  `upstream\` (the HeyPuter/everything clone; ALL app sources the builder uses are
  `upstream\src\<app>` — `lib\hub-build.js:45`, `run-upstream-suite.mjs:22`),
  `cad-home\` (the product: server, tests, docs, git history, user db `data\cad.db`),
  and 51 LOOSE per-app folders (3d…wiki) that NOTHING references (no `.git`, not in
  any build/test path) — owner plans to archive them out of the tree; if the root
  suite stays 377/377 after removal, they were pure dead weight.
- Next work queue: 4.3 easy-tier functional-gate wave (only accounting measured);
  runtime-coverage harness wave (0/172 etc. → real numbers); guest-link decision;
  then the §5 "Not started" list (peer relay LAST, after §29 approval).

## Session log

### Session 0 - 2026-10-22 (prior context, reconstructed) - baseline + decision 1
- Goal: execute the owner's HANDOFF decisions after the step-0 state rebuild.
- Actions (highlights; full detail in `AGENTS.md` §5 and commit messages):
  - Step 0: measured suites, repaired `data\cad.db` (kept `_dbdiag-20261022123133\`),
    git-initialized `cad-home`, baseline commit `c8e1d5a`.
  - Decision 1 implemented across `lib\hub-workers.js` (shape(), allocateHostLabel,
    create() redeploy-UPDATE), `lib\shim\puter.js` (canonicalWorkerRow),
    `lib\hub-rewrite.js` (sign craft rules restored byte-exact),
    `lib\hub-workers-http.js` (unknown-alias 403 external_not_allowed, cal-arm fix);
    new `test\worker-alias.test.js` (9 tests). `hub-guest-links.test.js:91` expectation
    changed (declared: it asserted the shim-visible alias on a server-internal API).
- Result: root 373/373, app 482/482, alias suite 9/9; commit `1924a97` (+ `git config`
  identity set locally after the first commit attempt failed).
- Gotchas recorded: store bootstraps FIRST added account as admin (tests wanting a
  non-admin member must add a dedicated admin first); probe scripts default to the
  real db when `CAD_DATA_DIR` is unset (bit us; cleaned the pollution target).

### Session 1 - 2026-10-22 - decisions 2-5 + §4 review items
- Goal: diagnose gate verdicts (no stale evidence), DB integrity/backup, §4 review
  items 4.1/4.5, paste §29 for review, docs discipline.
- Actions (running log):
  - 2: diagnosed 0/172, 0/96, 0/45: measurement is CORRECT (runtimeCovered/total;
    upstream adapters hardcode 0 by design at
    `test\signatures-upstream.test.js:40`, `test\invoicing-upstream.test.js:38`,
    `test\rsvp-upstream.test.js:55`). Adapters unbroken (green in root suite).
  - 2 (bonus): re-ran the aborted `sign-e2e`; browser probe isolation found the
    body-detachment bug (`ERR_ALPN_NEGOTIATION_FAILED` for any bodyful POST through
    the wrapper chain; native tab POST proved transport fine; mapper-only fine;
    culprit `lib\shim\puter.js` old line 103 chain). Fixed; added
    `test\shim-fetch-body.test.js`; root 374/374. `invoicing-e2e` 11/11.
    Sign-e2e now 12/17; remaining 5 failures = ONE design conflict (§24 driver vs
    §26 canonical app state) — parked for owner, documented in `AGENTS.md` §5.
  - 3: salvage analysis of `_dbdiag` backup: main file `integrity_check = ok`
    (users 5 / hub_workers 3 / hub_kv 5 = step-0 state); WAL parses to zero valid
    frames (torn header pageSize 1048576 vs main 4096) → NOTHING LOST. Added gate in
    `lib\db.js` (read-only probe + integrity_check; byte-backup `_dbrecover-<stamp>-<pid>`
    BEFORE refusing), `wal_checkpoint(TRUNCATE)` on clean close, `tools\db-backup.mjs`
    (VACUUM INTO; verified wrote `data\backups\cad-20261022140343.db`), README section
    "Safely backing up the data folder". Tests `test\db-integrity.test.js` 3/3;
    root 377/377.
  - 4: git discipline held — one commit per finished step throughout.
  - 4.1: rewrote design §28 as honest census (grep per app in `upstream\src`, file:line
    evidence; 0 new per-app rules; own-validator apps pass canonically; packaged
    system names resolve via exec server-side; meetings' VITE_ROOMS_ORIGIN build-time
    override flagged; hiring/shifts/contracts have no puter.work refs).
  - 4.5: added per-app published-page table to design §27; found contracts' `.ics`
    feeds were refused by the `/site` allowlist → added `.ics → text/calendar` to
    `lib\hub-hosting.js` + test line in `test\hub-hosting.test.js` (suite green).
  - §29: verified the peer-relay proposal stands; NOT touched (owner order).
  - Docs pass: deleted this line of work's throwaway probes (`_cmp`, `_dbdiag`,
    `_walrecover`, `_dbcmp`, `_dbmaincheck`, `_e2eprobe`, `_census`,
    `_hosting-census`, `_pubext`, `_aliasprobe*`, `_sigcheck`, `_stripbytes`,
    `_ruleslice`); earlier-phase `_*.mjs` tools left in place.
- Result: root **377/377**, app **482/482**, `invoicing-e2e` **11/11**, `sign-e2e`
  **12/17** (design pull parked), upstream clean `0fc4d361`. Commits: `7c53541`
  (shim fetch fix + gate diagnosis), `e4cd21e` (db integrity/backup), `029eb47`
  (AGENTS decision-3 report), `107c76f` (4.1/4.5 + .ics).
- Verified by running: all suites above; `node build-hub.mjs status`; backup tool;
  sign/invoicing E2E drivers; browser probe matrix (GET+POST variants against a real
  worker alias from the private listener page).
- Assumed: upstream adapters' pass counts (370, 749) unchanged since 2026-10-21
  (their evidence JSONs carry today's timestamps).
- Next steps (concrete):
  1. 4.3 easy-tier functional-gate wave (per-app `<app>-functional.json` probes;
     accounting only done).
  2. Runtime-coverage wave: run signatures/invoicing/calendar case sets against
     cad-home runtime (0/172 → real numbers; honest wiring already in place).
  3. Owner answers needed: §29 acceptance questions + guest-link shape pull.

## Session 2 - 2026-10-22 - ARCHITECTURE CORRECTION + proposal only (awaiting approval)

### Owner correction (verbatim intent, restated)
- The product is a self-hosted replacement for Puter's cloud hosting ALL of
  `upstream\src\<app>`; apps never call Puter's cloud/external APIs, server-side may.
- `cad-home` is NOT special — it is ONE app (the AutoCAD clone), a first test.
  **Nothing should depend on its folder.** Platform code must move out of it.
- Signed order: (a) short proposal (no code, no moves) → owner approval →
  (b) move code in small steps, one commit each, root+app suites green + real counts
  reported each step; keep `data\cad.db`, the data folder and git history intact,
  back up with `tools\db-backup.mjs` first; upstream stays clean at `0fc4d361`;
  archive the 51 loose app folders (move, not delete); no peer-relay code; no
  test-expectation edits.

### Actions (running log)
- ~14:xx Protocol rule updated in this file: apps no-external-calls wording (above).
- Survey: `cad-home` = platform code (server.js, lib\, sdk\, panel\, test\, tools\,
  build-hub.mjs and friends, data\, docs\) + the CAD client in `app\` (its own
  package.json; the 482-test suite) + junk (`prototype-data-browsercheck`,
  `browser-smoke-results*.json`, 27 earlier-phase `_*.mjs` probes).
- 14:xx wrote `docs\PROPOSAL-platform-split.md` (layout, move list, 6 commit steps,
  5 risks, 3 owner questions). NO CODE MOVED — awaiting owner approval, per order.
- 4.3 else: nothing touched this turn except docs.
- OWNER APPROVED (same day): platform folder = `platform` (agent picked it; the
  semantic name beats `hub` and leaves room for the admin panel under the same
  roof). S5 rename YES (`cad-home` -> `cad`). Git-root lift APPROVED (S2).

#### S1 — db backup + archive the 51 loose folders
- `node tools\db-backup.mjs` → `data\backups\cad-20261022150412.db` (270 336 bytes).
- 50 loose top-level app folders moved to `D:\Stream\_app-folder-archive\`
  (outside the future repo root; move not delete). Only `cad-home` + `upstream`
  remain in `D:\Stream\everything`.
- Suites re-run after the move: root **377/377**, app **482/482 PASS**.
