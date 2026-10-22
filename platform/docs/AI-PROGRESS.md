# AI PROGRESS LOG — cad-home → platform/cad RESTRUCTURED

**Read this file FIRST if you are an LLM session taking over.** It is the continuable
record of all progress and actions. `docs\AGENTS.md` §5 holds the same state in the
owner's step-report format; this file holds the chronological session log plus the
protocol below.

**FOLDER LAYOUT (post platform-split, S1–S6, 2026-10-22).** Repo root is
`D:\Stream\everything\` (`.git` at the root; history carried by renames):
`platform\` (ALL platform code: server.js, hub.js, lib\, sdk\, panel\, test\, tools\,
data\ with cad.db, docs\, package.json, e2e runners), `cad\app\` (the AutoCAD client
app, own package.json + vitest suite; its built `dist\` is served by the platform),
`upstream\` (pristine HeyPuter/everything clone, clean at `0fc4d361`), and
`D:\Stream\_app-folder-archive\` (50 loose per-app folders, archived out of the tree).
Run root suite from `platform\`; app suite: `npm --prefix ..\cad\app test` (from
platform) or `npm --prefix D:\Stream\everything\cad\app test`.
Internal identifiers deliberately NOT renamed: `cad.db`, `CAD_TEST`, `cad_session`
cookie, `cad-home-<date>.db` db-download labels, the `cad-home serve-time guard`
sw marker, `cad-session` etc.

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
   Delete throwaways at docs pass. Root suite: `npm test` (from `platform\`);
   app suite: `npm --prefix ..\cad\app test` (from `platform\`); status:
   `node build-hub.mjs status`. Capture `2>&1`.

## Snapshot (as of 2026-10-22 — platform split S1–S6 EXECUTED, awaiting final commit)

- Root suite: **377/377 PASS**; app suite: **482/482 PASS**; `build-hub.mjs status`
  runs and its upstream sha check passes from `platform\`.
- `invoicing-e2e.mjs` **11/11**; `sign-e2e.mjs` **12/17** (one owner-decision conflict, below).
- Git head after S5 commit; repo root `D:\Stream\everything`; upstream clone clean at `0fc4d361`.
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
- Folder layout: **PLATFORM SPLIT DONE (S1–S6)** — see the layout block at the top of
  this file. `upstream\src\<app>` remains the builder's source dir
  (`lib\hub-build.js:45`, `run-upstream-suite.mjs:22`); `everythingDir` default
  unchanged (`../upstream`, resolved against the platform ROOT_DIR). The guest-link
  shape conflict above is UNCHANGED by the split.
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

#### S2 — git-root lift cad-home → D:\Stream\everything (commit `5ef8350` + fix)
- Moved `.git` up one level; root `.gitignore` written (data/, node_modules/,
  _*.mjs, *.log, upstream/, _app-folder-archive/).
- Index reshaped: git detected **518 pure renames into `cad-home/`** — history
  intact, no add/rm churn.
- BUG caught in the lift: the unanchored `upstream/` ignore pattern ALSO ignored
  `cad-home\test\fixtures\upstream\` (rsvp-worker.js) — patterns anchored to root
  (`/upstream/`), fixture restored to tracking, fix committed.
- Suites after the lift: root **377/377**, app **482/482 PASS** (run before the
  ignore-pattern fix; the fix touches tracking only).

#### S3 — platform move (commit; suites 377/377 + 482/482)
- `git mv` for every tracked platform entry (server/hub/users/apps js, build-hub.mjs
  + 7 runner scripts, sdk\ panel\ lib\ test\ tools\ docs\, package.json[-lock],
  README, e2e files, junk tracked files) → `platform\`; `data\` + `node_modules\`
  + ignored `_*.mjs` moved with the filesystem (db intact).
- `cad-home` reduced to `.gitignore` + `app\`.
- Anchor fixes: `test\live.test.js` imports repointed to the CAD app source
  (temporarily `../cad-home/app`, final at S4 `../cad/app`); `lib\paths.js`
  `CAD_APP_ROOT` indirection added (temporarily cad-home, final S4); stale
  `hub-build.js` comment fixed. `everythingDir` default `../upstream` stays CORRECT
  (it resolves against ROOT_DIR = platform root) — a momentary wrong default change
  ("../../upstream") was reverted after `build-hub.mjs status` flagged it.
- Suites: root 374 loaded→2 fail (APP_DIR/TOKENS_CSS unanchored) → fixed →
  **377/377 PASS**; app **482/482 PASS** (from `..\cad-home\app`); `build-hub.mjs status`
  **PASS** incl. upstream sha.

#### S4 — CAD client move `cad-home\app` → `cad\app` (commit; suites 377/377 + 482/482)
- `git mv cad-home/app cad/app` (dist\ + node_modules\ moved wholesale).
- Repointed: `paths.js` CAD_APP_ROOT → `..\cad\app` (final), `test\live.test.js`
  imports, platform `package.json` setup/build scripts (`--prefix ../cad/app`),
  server.js boot message text.
- CAUGHT: `cad/app/dist` had become git-tracked (no ignore pattern covered the new
  path) — untracked, `cad/app/dist/` added to the root .gitignore, commit amended.
- Suites: root **377/377 PASS**; app **482/482 PASS** (from `..\cad\app`).

#### S5 — rename complete (commit; suites 377/377)
- `cad-home` dir fully emptied → deleted; folder-rename decision implemented via
  the moves (app lives at `cad\app`, per the proposal layout sketch).
- platform package.json + package-lock name `cad-home` → `platform`; stale
  comment sweep (hub.js, hub-build.js). Cosmetic labels kept on purpose: db
  download name `cad-home-<date>.db`, `cad-home serve-time guard` sw marker,
  `cad-home:` error prefix in db.js (internal identifiers not renamed per owner).
- CAUGHT BY THE REPO'S OWN TEST: my PowerShell `Set-Content -Encoding utf8` added a
  BOM to package-lock.json → `test\encoding.test.js` failed → stripped via Node.
- Suites: root **377/377 PASS** (after BOM fix).

#### S6 — junk cleanup + docs pass (commit)
- Deleted: `prototype-data-browsercheck\` (git rm), 4 `browser-smoke-results*.json`,
  31 throwaway `_*.mjs/_*.cjs/_*.txt/_*.json` probes (grep-verified: only comment
  references remain). `invoicing-e2e-results.json` (11/11) and
  `sign-e2e-results.json` (aborted-run record) kept as evidence files.
- Docs: this file (layout block, protocol suite commands, snapshot), AGENTS.md
  §3/§5 layout + split report.
- Wrote `docs\VERIFY-REPORT-2026-10-22.md` at the owner's request: full
  direction + action timeline with commits + re-verification commands + honest
  app-readiness state + parked decisions, for an independent LLM audit.
  Committed; root suite re-run after: **377/377 PASS**.

#### Cad onboarding to the hub (owner-approved 2026-10-22, "cad must be ONE app like the rest")
- WHY: owner challenged the double folder (upstream\src\cad inert vs our live cad
  client) and the cad HOME row being special (served at root by server.js,
  not installable, no status row). The GitHub upstream repo is NOT the owner's
  (verified by Q&A), so the pristine copy stays inert bytes; our cad is THE cad.
- Commit 1: hub source mapping — `SOURCE_OVERRIDES` in `lib\hub-build.js`
  (`cad → ../cad/app`), `sourceKind()` exported, own-source apps skip the
  pristine-clone guards in `buildOne`; status table gained the `src` column
  (`own`/`up`) + `gates.source` in json; NEW `test\hub-build-source.test.js` (3).
  Suites: 380/380 (377+3) + 482/482. One ORDER-DEPENDENT FLAKE noted:
  `test\hub-workers-rsvp.test.js:113` (admin guard 200-vs-401) went red once
  inside the 380, green in isolation and on the immediate rerun — watch it.
- Commit 2: built + installed the hub copy — `node build-hub.mjs build-one
  --only cad` (own-source build: npm ci + vite build from ..\cad\app; installed
  into data\hub\apps\cad in 18.2s). ONE source change in the client:
  `local-cloud.js` API root is server-rooted `/api/` when the page runs under
  the hub's `/h/<name>/` path (root + `guest mode unchanged). Hub-load smoke:
  `/h/cad/` **render non-blank, 777 elements, ext=0, bad=0, fail=0, err=0,
  csp=0, sw guarded** (`node browser-smoke.mjs load cad`), full ribbon UI
  present; the fresh `browser-smoke-results.json` (lean evidence, replaces the
  stale junk cleared at S6) makes the status row read
  `cad | own | PASS | services PASS | built yes | installed yes`.
  Suites: root **380/380**, app **482/482**.
- Remaining for full equality: the runtime server-tests gate (cad's 482 run in
  the client suite, not through the hub adapter) and the functional gate
  (`cad-functional.json`) — queued for the next owner-approved sub-step.
- Wrote `docs\VERIFY-REPORT-2026-10-22.md` at the owner's request: full
  direction + action timeline with commits + re-verification commands + honest
  app-readiness state + parked decisions, for an independent LLM audit.
  Committed; root suite re-run after: **377/377 PASS**.

- Result (Session 2 + split execution, 2026-10-22): proposal APPROVED and executed
  in full, S1–S6, one commit each; suites at every step: root **377/377 PASS**,
  app **482/482 PASS**, `build-hub.mjs status` PASS from `platform\`. Repo root
  now `D:\Stream\everything\` with `platform\` + `cad\app\` + `upstream\` (clean at
  `0fc4d361`); 50 loose app folders archived at `D:\Stream\_app-folder-archive\`;
  `data\cad.db` moved intact inside `platform\data\`; git history carried by
  renames (git log --follow works across the split). Three self-caught issues
  fixed inside the round: gitignore upstream/ anchor (fixture re-tracked),
  cad/app/dist re-ignored + amend, package-lock BOM (repo's own encoding test).
  Next queue unchanged: 4.3 easy-tier functional-gate wave; runtime-coverage
  harness wave (0/172 etc. → real numbers); guest-link adjudication; §29 review.
