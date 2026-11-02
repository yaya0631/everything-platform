# AI PROGRESS LOG — cad-home → platform/cad RESTRUCTURED

**Read this file FIRST if you are an LLM session taking over.** It is the continuable
record of all progress and actions. `docs\AGENTS.md` §5 holds the same state in the
owner's step-report format; this file holds the chronological session log plus the
protocol below.

**FOLDER LAYOUT (post platform-split S1–S6 + CAD unification, 2026-10-22).** Repo root is
`D:\Stream\everything\` (`.git` at the root; history carried by renames):
`platform\` (ALL platform code: server.js, hub.js, lib\, sdk\, panel\, test\, tools\,
data\ with cad.db, docs\, package.json, e2e runners), `upstream\` (our LOCAL FORK of
the HeyPuter/everything tree: base `0fc4d361` + the locally committed cad rework
`1d2588e8`; ALL app sources incl. cad are `upstream\src\<app>` — the cad original
stays recoverable in the clone's history), and
`D:\Stream\_app-folder-archive\` (50 loose per-app folders, archived out of the tree).
Run root suite from `platform\`; CAD client suite:
`npm --prefix ..\upstream\src\cad test` (from platform) or
`npm --prefix D:\Stream\everything\upstream\src\cad test`.
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
   cad client suite: `npm --prefix ..\upstream\src\cad test` (from `platform\`);
   status: `node build-hub.mjs status`. Capture `2>&1`.

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

- Result (Session 2 + split execution + cad unification, 2026-10-22): proposal APPROVED and
  executed in full, S1–S6, one commit each; suites at every step: root **377/377 PASS**,
  app **482/482 PASS**, `build-hub.mjs status` PASS from `platform\`. Repo root
  now `D:\Stream\everything\` with `platform\` + `cad\app\` + `upstream\` (clean at
  `0fc4d361`); 50 loose app folders archived at `D:\Stream\_app-folder-archive\`;
  `data\cad.db` moved intact inside `platform\data\`; git history carried by
  renames (git log --follow works across the split). Three self-caught issues
  fixed inside the round: gitignore upstream/ anchor (fixture re-tracked),
  cad/app/dist re-ignored + amend, package-lock BOM (repo's own encoding test).
  Next queue unchanged: 4.3 easy-tier functional-gate wave; runtime-coverage
  harness wave (0/172 etc. → real numbers); guest-link adjudication; §29 review.

#### Cad onboarding + UNIFICATION (owner-driven, same day)
- Onboarding 1/2: hub source mapping (SOURCE_OVERRIDES, src column, 3 tests).
- Onboarding 2/2: hub-built + hub-served (build-one --only cad; local-cloud.js
  API root /api/ under /h/<name>/; smoke clean; status row own/PASS/yes/yes).
- UNIFICATION (the owner MOVED cad into the clone by hand): the agent restored
  file-level correctness from this repo's git (owner's manual move had left the
  app nested one level deep at upstream\src\cad\app, then an agent flattening
  mistake deleted the nested dirs — ALL RECOVERED from our repo's tracked tree,
  145/145 files verified identical, 0 diffs), made the fork commit proper:
  clone commit `1d2588e8` on main (base `0fc4d361` recoverable), top-level
  `cad\` DELETED from our tree, platform repointed (paths.js CAD_APP_ROOT,
  test\live.test.js, package.json scripts, README/AGENTS layout), SOURCE_OVERRIDES
  emptied (cad builds like every other app now). Hub copy rebuilt (17.9s) +
  smoke clean + suites: root **380/380**, client **482/482** from
  `..\upstream\src\cad`.
- UPSTREAM SEMANTICS CHANGED (owner-approved): the clone is OUR LOCAL FORK now —
  base upstream head `0fc4d361` + locally committed cad rework `1d2588e8`;
  future pulls rebase cad only; the other 50 apps pull untouched.
- WATCH: `test\hub-workers-rsvp.test.js:113` admin-guard flake (2 full-suite
  occurrences, 200-vs-401 — root-cause next session, not touched yet).


## Session 3 - 2026-10-23 - CAD unification follow-through + flake root-caused

### Actions (running log)
- (2026-10-22, continued) Cad onboarding 1/2 + 2/2 committed (hub source mapping;
  hub-built + hub-served; smoke clean; status row own/PASS/yes/yes).
- (owner DROVE the next step) Owner challenged the two-folder cad layout, then MOVED
  the cad client into the upstream clone by hand (left nested at
  `upstream\src\cad\app` beside the original files). Agent made it version-controlled:
  - flattened the layout properly; CLONED-TREE RECOVERY from this repo's git after
    an agent `Move-Item`/`Remove-Item` mistake corrupted the merge (nested dirs
    collided then got deleted) — restored exactly from the tracked pre-move tree
    (`git checkout HEAD -- cad/app`), copied the three dirs over whole, deleted the
    cad\ shell in our repo;
  - verified file-for-file: **145 tracked files = 145, 0 diffs**;
  - clone commit `1d2588e8` on `main` (base `0fc4d361` recoverable; clone clean);
  - platform repointed: `paths.js` CAD_APP_ROOT → `..\upstream\src\cad`,
    `test\live.test.js` imports, package.json setup/build scripts, README,
    AGENTS §3 layout, root .gitignore (dropped obsolete `cad/app/dist/`);
  - `SOURCE_OVERRIDES` in `lib\hub-build.js` EMPTIED (cad builds like every other
    app); `test\hub-build-source.test.js` rewritten to pin the unified layout;
  - hub copy REBUILT from the unified source (`build-one --only cad`, 17.9s) and
    re-smoked CLEAN (777 elements, ext=0, bad=0, fail=0, err=0, csp=0, sw guarded);
  - suites: root **380/380**, cad client **482/482** from `..\upstream\src\cad`.
- FLAKE ROOT-CAUSED + FIXED (test input bug, NOT product): the rsvp admin-guard
  test built its "wrong" secret as `SECRET.slice(0,-1) + '0'` — identical to the
  real secret whenever the random one ends in `0` (1-in-16 odds = the two recorded
  200-vs-401 failures). Reproduced the collision mechanically (200k sample).
  Fix: deterministic guaranteed-different mutation (flip first char). Expectation
  UNCHANGED (401). RSVP suite green 3x in a row; full suite green 2x in a row.
- Upstream semantics (owner-approved): the clone is OUR LOCAL FORK — the other 50
  apps still pull upstream updates untouched; cad updates need a rebase/merge.

### Result (2026-10-23)
- Layout: `everything\.git`, `platform\`, `upstream\src\<52 apps incl. cad>`,
  archive outside the repo. ONE cad, ONE source home. No special casing left.
- Root suite **380/380 PASS** (twice) + cad client **482/482 PASS**;
  `build-hub.mjs status` runs; upstream clone clean at local-fork `1d2588e8`.
- Committed: agent side `cad onboarding 1/2`, `2/2`, `cad unification`, plus this
  flake fix; clone side `1d2588e8`. Disclosures: the declared test change is the
  admin-guard INPUT fix above (expectation untouched); the recovery mistake and
  its verification are logged above for the audit trail.
- Next queue: 4.3 easy-tier functional-gate wave; runtime-coverage wave
  (0/172, 0/96, 0/45 → real); cad functional gate + hub runtime gate; guest-link
  adjudication; §29 review.

## Session 4 - 2026-10-23 - the functional-gate wave (easy tier measured for real)

Owner GO: the auditor confirmed the previous rounds and the owner asked to finish what
stayed incomplete. This session executed the 4.3 wave end to end.

### Actions (running log)
- Ran `functional-gate.mjs` over all installed, no-evidence apps. First run died on
  the FIRST throwing app (`puter is not defined` for 3d, whose loader is on demand) —
  the tool aborted the whole wave and wrote no verdict.
- HARNESS HARDENING (tool change, declared; no product expectations touched):
  - per-app try/catch so one app can never abort the wave; every target now gets a
    verdict on disk AND on stdout, including phase-A failures (previously silent,
    which made one run exit 1 with zero printed failures);
  - a 10 s wait for `window.puter` to appear (on-demand loaders), with the same POKE
    table as browser-smoke.mjs (chess/checkers/backgammon "Online" click) so the game
    trio surfaces its shim before the probe;
  - `networkidle2` timeouts no longer kill an app: if the document is interactive the
    probe continues (audio-studio, music-studio, solitaire, sudoku run eternal
    whoami/kv poll loops — the same four apps already on browser-smoke's measured
    LONG_POLL excuse list);
  - probe key changed from `__cad_functional_gate__:<app>` (colon) to
    `__cad_functional_gate.<app>`: cad ships its OWN puter adapter (local-cloud.js)
    which maps kv to the server settings route `kv/:key` (`[\w.-]{1,64}`), so the
    colon key 404'd there. Gate bug, not a product bug.
  - `appLocalPuter` marker: an app whose puter comes from its own bundle has no
    platform-shim call log; the round trips + restart + empty page-error list carry
    its verdict instead (recorded openly in the evidence).
- GATE POLICY CHANGE (declared here and in the tool; this is calibration, NOT a
  test-expectation edit): a rejected `puter.fs.read` with `code: 'not_found'` no
  longer fails a gate when the app handles it — notes (`readJSON().catch(() => null)`
  + seed), expense and circuits are DESIGNED for the empty-drive first run, and a
  real Puter would also return not-found there. Everything else still fails:
  uncaught page errors, write rejections, any non-not_found rejection, restart
  failures. Full call log stays in each evidence file; `failingCalls` recorded.
  build-hub.mjs functionalPass mirrors the same rule.
- STATUS DISPLAY FIX (real bug, predates today): a present-but-failing
  `<app>-functional.json` still printed `functional` because only file presence was
  checked. New column logic: `functional` / `func-fail` / `func-pending` / `-`,
  driven by `functional_gate_pass`.

### Result (2026-10-23)
- WAVE: 24 wave-ranked apps measured in one run — **23 PASS / 1 honest FAIL**
  (3d: its loader is on demand with no generic poke; stays func-fail until a
  dedicated drive exists). Full PASS list: accounting, audio-studio, backgammon,
  cad, cap-table, checkers, chess, circuits, contacts, crm, expense, inventory,
  music-studio, notes, parametric, pos, presentation, projects, solitaire, sudoku,
  survey, tasks, time-tracking. Evidence: `data\hub\test-gates\<app>-functional.json`
  (kv set/get, fs write/read round trip, kv read again after a real server restart,
  per-call log with statuses and codes).
- `node build-hub.mjs status`: the 23 show `functional`; `3d` shows `func-fail`;
  status runs (exit 0); still `status works 0/51` because works needs smoke + more
  gates per app.
- Fresh e2e evidence appeared from a CONCURRENT run outside this session
  (timestamps 2026-10-23T07:53Z, not this agent): invoicing-e2e 11/11 PASS,
  sign-e2e 12/17 with the same 5 parked guest-link failures. Committed as
  refreshed runtime evidence.
- Suites: root **380/380 PASS**, cad client **482/482 PASS** (from `..\upstream\src\cad`).
- Next queue: runtime-coverage wave (signatures 0/172, invoicing 0/96, calendar
  0/45); cad gate via admin/hub surface; guest-link adjudication (owner);
  §29 peer-relay review (owner); 3d dedicated drive; VERIFY-REPORT addendum.


## Session 5 - 2026-10-23 - runtime-coverage wave starts: signatures 0/172 to 30/172

Owner GO continued (second auditor round confirmed the functional-gate wave).

### Actions (running log)
- RUNTIME SEAM EXTRACTED first (commit 835cd05): lib/worker-contract.js holds the
  pure workers contract (Router, route matching, Response serialization);
  worker-runner.js (the forked child) now uses it verbatim - zero behavior
  change, root suite stayed green. Real bug caught by the worker tests: the
  child's --allow-fs-read list lacked the new imported module, so every worker
  child died on import (502 "runtime stopped mid-query"); the parent now
  allows that exact file. Suites: root 380/380.
- RUNTIME ADAPTER MACHINERY:
  - test/runtime/worker-harness.mjs: runtime variant of upstream's worker
    harness with the SAME import surface. Worker source is loaded like the
    runner's child does (fresh contract Router as the `router` global, `me`
    global set before import and per call); responses go through the runner's
    serializeWorkerResponse; kv goes through lib/hub-kv.js and fs through
    lib/hub-fsops.js - the same transports the parent's me-frame handler
    uses. kv exposes a WRITE-THROUGH Map view (upstream tests peek and seed
    kv.map; a view write becomes a real hub-kv set).
  - test/runtime/fake-puter.mjs: makeFs routed through hub-fsops (Blob reads,
    subject_does_not_exist on miss); makeFakePuter deliberately NOT ported
    yet - it fails LOUDLY so a case cannot silently understate coverage.
  - test/vitest-shim/hooks.mjs: CAD_RUNTIME_HELPERS=1 maps
    signatures/tests/helpers/{worker-harness,fake-puter}.js to the runtime
    seam, ONLY for the runtime adapter; the upstream-only adapters behave
    exactly as before.
  - test/signatures-runtime.test.js: the mapped runtime set for this step =
    email-worker.test.js + sign-worker.test.js (30 cases); writes
    data/hub/test-gates/signatures-runtime.json.
- build-hub.mjs status: a <name>-runtime.json evidence file now overrides the
  adapter's static runtimeCovered/Total (total stays the shared denominator);
  source text on the row names the runtime seam execution.

### Result (2026-10-23)
- signatures runtime coverage measured for real: **30/172 runtime cases PASS**
  (upstream worker code executing worker-contract framing + hub-kv + hub-fsops;
  the /wr HTTP wrapper, child sandbox and permission model stay tested by the
  root suite - declared in the evidence's execution field).
- Status prints signatures 30/172 (was 0/172); invoicing 0/96 and calendar 0/45
  still open (each needs its own seam port - next steps).
- Suites: root **411/411 PASS** (380 + 31 new runtime adapter tests), cad client
  **482/482 PASS**. Status exit 0.
- Next queue: extend the mapped set to accesscode/consent/expiry/ownernotify
  (needs the makeFakePuter runtime port: auth/workers/fetchTo over the real
  hub), then store/templates signlinks/deleteflow/emailer app-libs cases,
  then invoicing (0/96) and calendar (0/45).


## Session 6 - 2026-10-23 - makeFakePuter runtime port: signatures 30/172 to 159/159

Owner GO continued (the runtime wave expansion, per the Session 5 queue).

### Actions (running log)

1. **Quick wins first (+34): `accesscode` (19) + `ownernotify` (15)** - both
   only import the already-runtime-ported helpers, so they joined MAPPED_SET
   immediately; a 1-file fix (the adapter still imported entries [0] and [1]
   instead of the whole set) and the set-import became a loop. One upstream
   matcher gap surfaced (`toHaveBeenCalledWith`) and was PROPERLY implemented
   in the shim's expect (deep-equal per argument, trailing-undefined
   optional-args rule) rather than special-cased. 64/172.

2. **makeFakePuter runtime port** (test/runtime/fake-puter.mjs, replacing the
   loud-throws stub). What the app-side slice is now, all over the real
   cad-home runtime:
   - `kv`/`fs` already runtime-backed (hub-kv / hub-fsops).
   - `workers.create(name, filePath)`: a REAL hub worker row via
     lib/hub-workers.js `create({user: fs.user, app: 'signatures', ...})` -
     the same row shape the HTTP shim boundary produces (canonical
     `https://<host_label>.puter.work` alias per §26); `workers.get/delete`
     operate on those rows (deployDelete).
   - Introspection surface kept upstream-shaped (`p.workersByUrl/<name>` with
     `record.instance` built by the RUNTIME worker harness). The instance's
     kv is created on purpose in the row's OWN worker kv namespace
     (`user = row.user`, `app = worker:<name>`, exactly lib/hub-workers-run.js
     `handleMe` addressing), so introspection (instance.kv/call) sees the
     same data a dispatch through the row sees. Overwriting a deployed
     worker's source file rebuilds the instance (Puter redeploy semantics);
     the row re-reads its file per dispatch by itself.
   - `workers.exec` stays a plain spy: cases that use it inject canned exec
     results on purpose (they test the app's handling, not the canal).
   - `auth.getUser` returns the test user (apps read owner identity).
   - `fetchTo` (the app-side fetch the signlinks lib uses for verify/ping/
     pull) resolves the canonical host label to the deployed record and runs
     the SAME worker source through the runtime harness instance's
     `call()` - upstream's fake routes fetches the same way, and the
     introspected `seen`-path tests depend on that indirection. The full
     /wr HTTP wrapper + forked-child sandbox dispatch stays root-suite
     coverage (declared).
3. **Shim's vitest surface grew to what the remaining files really use**
   (all declared, none special-cased):
   - `vi.fn`: `mockResolvedValueOnce/mockRejectedValueOnce/mockReturnValue
     (Once)/mockResolvedValue/mockRejectedValue` (a once-queue + promise
     shorthands).
   - `vi.mock` module mocking via the LOADER: hooks.mjs extracts
     `vi.mock('<spec>', factory)` statements from upstream test files at
     LOAD time (a module's deps resolve after its source is read, so this
     registration is genuinely hoisted), registers the factory against the
     absolute target module, and resolves every later import of that module
     (within the adapter process) to a SELF-CONTAINED virtual module that
     serves the factory result MELDED OVER the real module's namespace
     (static export names read from the real source at registration so every
     named import keeps resolving). Factory code runs at module evaluation
     on the main thread (loader-thread globals are not main-thread globals -
     learned the hard way). Real module reachable behind a mock with a
     `?__cad_real=1` query. Limitation declared: the factory must return a
     flat object literal (currently true: modal/services/toast mocks in
     deleteflow).
   - `vi.stubGlobal`/`vi.unstubAllGlobals` (restore semantics), `vi.
     clearAllMocks`/`resetAllMocks` (a spy registry sweep).
   - `afterEach` implemented per vitest nesting (suite-first-then-file); a
     FILE-level `beforeEach/afterEach` scope system (shim `openFileScope()`)
     attributes top-level hooks to the right file across the multi-file
     adapter (deleteflow has top-level hooks; they must not leak into other
     files' suites). The adapter opens one scope per imported file.
   - matchers: `toBeInstanceOf`, `expect.stringMatching/stringContaining/
     anything` statics + asymmetric matching inside deepEq.
   - `describe` runs its body inside a try/finally with no pop (flat list
     preserved); do NOT "fix" nesting - casesOf() snapshots the list.
4. **Three real fs gaps found and fixed in the runtime harness while porting
   (behavior, not tests)**:
   - `files` mirror now records EVERY write (blobs/Uint8Array too) - upstream
     introspects fs.files for binary artifacts (store delete-doc case).
   - `fs.delete` forwards `options.recursive` to hub-fsops (deleteTemplate
     deletes a DIRECTORY; without it the real files survived and reads kept
     succeeding).
   - RuntimeFetchResponse accepts BOTH transport shapes ({status,headers,
     body} from hub-workers-run.invoke and the harness ResponseView).
5. **The 172-case denominator RECONCILED by measurement** (declared doc/
   harness count calibration, task item from the audit): the 13 worker-
   focused files sum to **173** cases under real vitest (email-worker 15,
   sign-worker 15, accesscode 19, consent 18, expiry 27, ownernotify 15,
   store 12, templates 13, emailer 11, signlinks 11, deleteflow 3,
   advanceturn 9, pagerail 5) - the doc's 172-estimate (signlinks at 9) was
   wrong. The 11 upstream-fake-using files total exactly 159 and are
   precisely what our runtime adapter maps and measures: **159/159**.
   `advanceturn.test.js` (9) mocks the store module itself -> no cad-home
   transport exists to exercise; `pagerail.test.js` (5) is DOM/jsdom-bound.
   Both are upstream-covered (9/9 and 5/5 under real vitest today). The
   adapter's RUNTIME_TOTAL is now 159 with the measurement comment; §25 of
   phase3-workers-design.md corrected.

### Result (2026-10-23, commit to follow)
- `node --test test/signatures-runtime.test.js`: **160/160 PASS** (159 mapped
  runtime cases + the registration test). Evidence:
  data/hub/test-gates/signatures-runtime.json (covered = measured = 159,
  runtimeTotal = 159).
- Status: signatures **159/159** runtime cases (was 30/172, originally
  0/172); invoicing 0/96 and calendar 0/45 still open (next steps).
- Suites: root **540/540 PASS** (411 + 129 new runtime adapter tests), cad
  client **482/482 PASS**. `node build-hub.mjs status` exit 0.
- Known fakes: `signlinks` sign-worker test names `p.kv.map` set/get flows,
  hub-kv list is PREFIX-strip (trailing `*`), unlike the upstream
  harness's glob middles - none of the mapped cases rely on glob middles,
  so nothing needed fixing here (declared in the harness comment).
- Next queue: invoicing runtime seam (0/96), calendar runtime seam (0/45),
  3d dedicated functional drive, guest-link adjudication (owner),
  §29 peer-relay review (owner), VERIFY-REPORT addendum after 2026-10-22.


## Session 7 - 2026-10-23 - runtime seam wave + 3d gate + guest-link conflict RESOLVED

### Actions (running log)
1. **Invoicing runtime seam landed (was 0/96).** hooks.mjs: the runtime
   helper mapping generalized from the signatures tests dir to ANY app's
   `tests/` dir. NEW `test/invoicing-runtime.test.js` runs the upstream
   email-worker file UNMODIFIED over the runtime seam (worker-contract
   framing + hub-kv transport): 59/59 PASS. Classification (declared,
   measured): mailer.test.js holds 37 cases with zero kv/fs/runtime refs -
   sendDocument is exercised against a DELIBERATELY canned workers.exec
   reply per case (the case controls the transport; timeout/reachability/
   error shapes cannot be produced by a real dispatch without changing the
   case) - so those 37 are upstream-only BY CLASSIFICATION with exact names
   in data/hub/test-gates/invoicing-runtime-excluded.json, written by
   tools/classify-invoicing-runtime.mjs. RUNTIME_TOTAL = 59 (not 96);
   invoicing row: 59/59 runtime + 749/749 upstream suite + 11/11 E2E.
2. **Calendar runtime seam landed (was 0/45).** NEW
   `test/calendar-runtime.test.js`: rsvp-worker.test.js 45/45 over the same
   seam (instantiateWorker(source, { kv }) contract identical; sha256Hex
   admin auth). Calendar row: 45/45.
3. **Parallel-suite data-dir bug in the new adapters CAUGHT + FIXED.** Under
   the full root suite the invoicing/calendar runtime adapters stomped the
   shared default data dir (they skipped test/helpers.js which sets the
   per-process fresh CAD_DATA_DIR). Both now import { cleanup } from
   './helpers.js'. Full suite: root **646/646 PASS**, cad client 482/482.
   Commit 63484e7 (seam wave step 2) + dccedb9 (data-dir fix + 3d).
4. **3d functional gate PASSES.** The assistant panel is open by default
   (upstream's own e2e asserts it); submitting a message raises
   loadPuter() through a real user path. functional-gate.mjs POKE gains a
   typed-into-field shape ({fillSelector,text,submit}) and runPoke() runs
   again in the restart phase (on-demand loaders must re-raise after
   reload); browser-smoke.mjs gets the same poke shape. Gate wave:
   **24/24 PASS incl. 3d** (calls=7, kv-restart=true, fs-roundtrip=true).
   Commit dccedb9.
5. **Guest-link conflict RESOLVED (owner delegated the design choice --
   "make the canonical URL design consistent ... or pass the E2E; do not
   leave the 5 reds parked").** Both, in one consistent design:
   app-visible worker rows STAY canonical (26); guest-openable links (what
   the owner actually shares) compose the configured public base with the
   worker's canonical hostname through the `/w/host/<bare-label>` public
   alias - the exact shape the shim mapper produces.
   - lib/hub-rewrite.js: NEW serve-time rule `sign-guest-link` (byte-exact
     slice of the owner chunk's link composition
     `o[e]=` + r.url + `/sign/` + t ) replaced with
     ``(`${__CAD_GUEST_BASE__}`.startsWith(`http`)?`${__CAD_GUEST_BASE__}/w/host/`+new URL(r.url).host.replace(/\.puter.work$/,''):r.url)``
     - with a configured base the stored link is OPENABLE; with no base the
       marker is not an http string and the composition keeps the honest
       canonical row URL (documented degrade).
   - lib/hub.js: the public sign-page mapper script no longer loads
     `defer` - it must install its fetch/WebSocket/EventSource overrides
     DURING parsing. Measured root cause of the E2E guest-page 404: the
     deferred tag lost the race with the app module's first fetch, the call
     went canonical and the guest page CSP (`connect-src 'self'`) blocked
     it. Probes: _wrprobe.mjs (worker arms 200/404 matrix),
     _guestprox.mjs (real-Chromium guest flow with fetch logs).
   - sign-e2e.mjs steps 12 + 15 (DECLARED driver changes): the doc record
     holds `pubBase + /w/host/<label>/sign/<token>` (real, openable); the
     app's own worker-config record holds the canonical
     `https://<name>.puter.work` it received through the shim (the URL all
     its admin calls use; mapped by the shim).
   - test/signatures-productization.test.js: rule set is 4
     (sign-guest-link joins the zero-match walk); applied-set + served
     chunk assertions updated with the same strength (no weakening).
   - README (guest links paragraph) + phase3 24 board updated; 26 note
     about the mapper is now enforced at parse time.
   - **`node sign-e2e.mjs`: PASS 27/27** (was 12/17 with 5 parked reds).
   Commits bc93654 (+ d423f86 housekeeping: `_*.mjs` probes stay untracked).

### Result (2026-10-23)
- Runtime coverage rows: signatures 159/159, invoicing 59/59 (37 named
  upstream-only cases + 749/749 upstream suite), calendar 45/45. All three
  were `0/x` when the session started.
- Functional-gate wave: 24/24 PASS (3d included, `func-pending` gone).
- E2E: invoicing 11/11, **signatures 27/27** (guest-link conflict DONE).
- Suites: root **646/646**, cad client **482/482**. `node build-hub.mjs
  status` exit 0.
- Remaining queue (the status `works 0/51` arithmetic): smoke for all built
  apps (only cad carries evidence), then the ~25 unbuilt apps (build +
  install + gate + smoke + runtime cov + services), documents/help-desk
  etc. per 7. Guest-link + 3d + invoicing/calendar seams are CLOSED.

## Session 8 - 2026-10-24 - full works wave verified independently; cad is NO LONGER a special app; AI parity measured in every app

### Context
The owner reported status `works 51/51` while the tree held one fresh
concurrent commit (`b393df3 make hosted builds clean on Windows`, through
GitHub Copilot) plus an UNCOMMITTED feature round on disk:
`lib/hub-net.js` + `test/hub-net.test.js` (NEW: a local raw-socket bridge over
WebSocket at `/api/hub/net`, loopback/RFC1918/address-.local only, session +
per-app enablement checked, origin-checked upgrade mount), `puter.email`
send/send-transactional/list over lib/mail.js with per-user privacy filter,
`puter.perms` (folder permission request over a real grant),
`ui.launchApp` (real navigation to `/h/<name>/`), fs.share family, kv batch
set, `whoami` uuid + anon 401, db.js `undefined -> null` bindArgs, and
`hostedAppRequest` relaxation of the API gate (X-CAD-Request OR
sec-fetch-site same-origin OR Referer `/h/`). Reviewed before use: the
relaxation keeps the CSRF stance (a cross-site page cannot produce a
same-origin sec-fetch or a `/h/...` Referer on this origin); the email list
route filters rows by `row.user === user` and source-app prefix; hub-net is
deliberately bounded (no arbitrary outbound proxy). All of it is INCLUDED in
this session's commit rather than re-authored.

### Independent verification (never trusting the on-disk evidence alone)
1. Root suite fresh: 1 REAL regression - `test/hub.test.js` "JS bundles are
   rewritten too" timed out after ~300 s (undici HeadersTimeoutError). The
   concurrent round had ADDED an anon assertion calling the literal path
   `/hub/auth/whoami`, which fell through `hubMount` WITHOUT any response -
   a pre-existing latent hang bug for every unmatched `/hub/*` private path.
   FIXES: (a) lib/hub.js hubMount now ends with a plain 404 for any unmatched
   `/hub*` path (no silent hangs any more); (b) the test's anon assertion now
   targets the REAL route `hub/auth/whoami` (= `/api/hub/auth/whoami`, the
   route the concurrent round deliberately changed to answer 401 for anon)
   PLUS asserts the unmatched literal path returns 404. hub.test.js: 9/9 PASS.
2. Root suite: **648/648 PASS** (647 + the new root-launcher test).
3. cad client suite: **482/482 PASS** (31 files, 18.2 s).
4. Functional gate wave fresh (`node functional-gate.mjs`): all 48
   functional-gate apps round-trip KV + FS across restart; evidence files
   rewritten; signatures/invoicing/calendar skip the generic gate on purpose -
   their verdicts come from the runtime adapters (159/159, 59/59, 45/45) and
   the E2E drives (27/27, 11/11), which are STRONGER, per 25.
5. Invoicing E2E fresh: **11/11 PASS**. Signatures E2E fresh: **PASS 27/27**.
6. Full browser smoke fresh (`node browser-smoke.mjs load`): 53 rows, all 51
   census apps clean (loads + ext=0 + bad=0 + failed=0 + errors=0 + csp=0).
   The only two not-clean rows are `alpha` and `fixture` - legacy catalog
   entries, NOT part of the 51-app census, and they are excluded from the
   census denominator by name, documented here (no denominator inflation).
7. `node build-hub.mjs status`: **works 51/51**, built 51/51, smoke seen
   for 51, loads 51/51, no PENDING/func-fail/0-x rows. Exact table in
   `data\_step0-status.txt` (st3 run).

### cad is NOT special any more (owner directive)
- `server.js` used to serve cad's dist at EVERY unmatched private path,
  including the root: opening the server root landed INSIDE the CAD app with
  the other 50 apps one level deeper. Now `serveApp` redirects the root
  (`/` -> 302 `/hub/`) to the SAME launcher page that lists every app - cad
  included, from the same hub_apps row. cad opens at `/h/cad/` like every
  other app. The older `/apps/` launcher and the hosted-apps feature are
  untouched; only the exact root path changed.
- NEW test in test/hub.test.js: root 302 -> `/hub/`, the launcher lists
  `/h/cad/` AND `/h/fixture/`, and `/h/cad/` serves 200. Two later tests that
  assumed a singleton catalog were updated to the honest post-change world
  (they look up the fixture row instead of apps[0]; the removal test asserts
  the fixture row is gone rather than the catalog becoming empty). hub.test
  now installs cad itself from the unified source so the launcher assertion
  is real.

### AI parity measured per app (owner directive: "if AI works in cad it should work in all the other apps")
- functional-gate.mjs now runs a **third round-trip per app page**: a real
  `puter.ai.chat` call through the page's own adapter. The gate sets
  `hubAiDefaultModel = test:test-model` (persisted in the config table, so
  the restart phase keeps it); CAD_TEST exposes the built-in test provider
  (canned reply, no network). 47 shim apps answer through the platform shim
  (`/api/hub/ai/chat`); cad's own adapter resolves the same provider id and
  streams the core route's NDJSON inside a Response (the probe joins the
  text deltas the way the app's own assistant does). First wave: 47/48 ai=true,
  cad false-failed because the check matched the RAW NDJSON wire (deltas are
  separate lines) - fixed; final wave: **48/48 `ai=true`** (calls counts
  grew by exactly one per app: the chat call itself).
- build-hub.mjs `functionalPass` now REQUIRES `functional.ai.ok === true` -
  the AI-parity probe is part of the works verdict, not decoration.
- README (shim `puter.ai.chat` bullet) + phase3 25 + the AI-parity gate note
  updated; phase3 25's adapter table rows for calendar/invoicing were stale
  (0/45, 0/96) - corrected to the measured 45/45 and 59/59.

### Result (2026-10-24)
- Suites: root **648/648 PASS**, cad client **482/482 PASS**, hub.test 9/9.
- Gate: 48/48 PASS with kv-restart=true, fs-roundtrip=true, **ai=true**.
- E2E: invoicing 11/11, signatures 27/27 (both fresh, real data dir).
- Smoke: 51/51 census apps clean; alpha/fixture documented as outside the
  census. Spot re-smoke cad/3d/chess/notes clean after the root change.
- Status: **works 51/51** with the AI requirement folded in.
- Same-day follow-up (owner hit it live): the root redirect left
  signed-out visitors at a DEAD END - `/hub/` said "sign in first" with no
  button. First fix pointed at CAD (wrong instinct: that makes CAD special).
  Owner corrected it: identity is PLATFORM UI. Now `/hub/` (and the
  `/h/<app>/` anon arm) serve the hub's OWN no-JavaScript sign-in FORM:
  `lib/hub.js signInPage(message, to)` posts urlencoded to the NEW open
  route `/api/hub/signin` (server.js) - same rate limiting and failure
  accounting as the JSON login, 303 redirect to a same-site-validated `to`,
  form re-render with the error on 401, works in any browser without JS.
  Proven in REAL Chromium by a probe script (root -> form -> submit ->
  launcher with cards incl. cad, zero page errors) and by hub.test 10/10
  (form round-trip, wrong-password re-render, open-redirect guard).
- Legacy catalog rows REMOVED (backed up first via tools/db-backup.mjs ->
  data/backups/cad-20261024213639.db): `alpha` and `fixture` are gone with
  their installed folders, so the launcher is exactly the 51 real apps
  (-owner directive context: cad was the test bed, then everything scaled;
  no test junk in the grid). Status: **works 51/51**, 51 folders.
  Root suite fresh **649/649 PASS**.

### REAL-DIR POLLUTION caught + fixed (owner hit it live in the documents app, 2026-10-24)
- The AI-parity gate set `hubAiDefaultModel = test:test-model` with
  `config.set` and never restored it. The gate's data dir IS the real one
  (`platform/data`), so the live config table kept the TEST provider as
  every hub app's default model. In production (no CAD_TEST) the test
  provider does not exist, so the documents app's assistant answered
  "That model is not set up on this server." - my pollution, not a product
  gap. FIXED twice:
  1. live db: `hubAiDefaultModel` deleted (honest "no default model" errors
     return until the owner sets their own provider).
  2. functional-gate.mjs: the wave captures `PREV_HUB_AI_DEFAULT` and the
     `finally` restores it (the AGENTS rule "config.set persists: restore
     knobs after control runs", applied to the gate), so a gate run can
     never poison production again. Verified: `chess` PASS with ai=true
     and the real config still undefined afterwards.
- What the OWNER does to make AI real for every app (this is config, not
  code): Admin -> AI = provider + key (or local Ollama, no key) + enabled
  models; Admin -> Hub = "Hub AI (puter.ai.chat)" Default model
  (`provider:model`, e.g. ollama:llama3.2) - apps that ask for unknown
  cloud names get exactly that model. Aliases JSON covers per-name
  mappings if wanted.
- Suites after the fix: root **649/649 PASS**, cad client 482/482
  (unchanged code); gate restore-fix verified in real Chromium class runs
  (`chess` PASS ai=true, real db value still undefined after).
- Owner then configured providers (OpenRouter key + Google key) and hit
  TWO real snags in the Hub AI default-model field:
  1. They typed `OpenRouter:deepseek-v4.1-flash-1017` (display-name prefix
     + slug missing the `deepseek/` vendor part). Shaped like provider:model
     so the validator accepted it, but resolution hit a provider id that
     does not exist -> the same misleading "not set up" error. The live
     value is now the canonical `openrouter:deepseek/deepseek-v4.1-flash-1017`.
  2. A genuine field bug: the validator's model part `[\w .:*-]` had no
     `/`, so the CORRECT OpenRouter/Google ids (which contain a slash)
     could not be saved at all. Fixed in hub.js (`[\w .:/\-*]` now), error
     message shows a slash example.
- Panel: the Hub AI default-model input now suggests exactly the enabled
  model ids (datalist fed from `ai/models`), so `provider:model` cannot
  be mistyped from memory.
- End-to-end proof on the owner's REAL config (untracked probe, deleted
  after): a hub app asking `gpt-4o-mini`, another cloud name, or nothing
  at all all resolve to the configured default; a real 11-in/17-out-token
  call through their OpenRouter key returned "probe-ok". Hub apps are live
  on owner AI with zero per-app code.

### Open / next
- Peer relay (29) still awaits owner review; no peer code written.
- alpha + fixture rows: legacy catalog entries (alpha = the old launcher app,
  fixture = a test import). Candidate future cleanup: demote/disable them in
  the catalog so the launcher shows exactly the 51 real apps - owner call,
  not done unilaterally.
- The AI engines (txt2img/TTS/STT/OCR/video) remain honest `engine_missing`
  responses per README; AI chat parity is what is measured here.

## Session 9 - 2026-10-26 - W1 defect wave: audit findings fixed, gates honest, local AI proven

Owner scope: everything the independent audit flagged, in waves. This session
is **W1 (defects)**; W2 (peer/events), W3 (engines/Pyodide/NHTSA) and W4 (ops,
full re-verification) follow. One commit per fix; suite green at each step.
Platform commits below unless marked fork.

### W1 findings closed

| Finding | Fix | Commit | Evidence |
| --- | --- | --- | --- |
| M13 | `hub-fsops.js` re-save: `const res` -> `let res` (dedupeName loop reassigns) | `bb69fb7` | regression test in `hub-fsauth.test.js`; suite green |
| M11 | worker identity: migration 7 uuid column + backfill, `store.addUser` uuid, `ownerIdentity()`/`caller`, `ctx.user`/`ctx.requestor` | `83ddffc` | worker suite 21/21 |
| M12 | whiteboard + photo-studio collab workers fetch under `/h/<app>/` (served route rewrites) | `9e35ef7` | rules each hit exactly 1 file; suite 656/656 then |
| m1 | PWA manifests/icons served outside the session gate at `/hub/app-manifest/` + `/hub/app-asset/`; JSON-aware manifest rewrite | `d15b17f` | `test/hub-pwa.test.js` + `test/fixtures/hub/manifest-dist/` |
| m3 | no code change needed: the Secure flag already follows HTTPS; regression test + README TLS note | `96453ce` | `foundation.test.js` |
| m5 | `launchApp({background:true})`: hidden same-origin iframe + token-keyed postMessage registry; `parentApp()`, `puter.args`, `puter.sourceApp` | `e53caa7` | `appconn-e2e.mjs` 12/12 |
| m2 | AI streams fail once with `Error` + `code:'ai_stream_interrupted'` before the first byte and mid-body; every read has the rejection path; queued chunks still reach the app | `ffa73f4` | `ai-stream-e2e.mjs` 7/7 |
| M8 | `puter.perms.request('folder')` mounts the same closed-shadow-root Allow/Deny dialog as a Drive write; no auto-grant; Allow audited as `hub.perms_granted` | `7bcd86d` | `perms-e2e.mjs` 13/13 |
| m4 | `frame-src` allowlist for YouTube-nocookie/Vimeo/Google Docs behind **Admin -> Hub -> External embeds** (off by default) | `f028067` | `test/hub.test.js` + `hub-rewrite-rules.test.js` |
| M10 | generic gate is explicitly infrastructure (`ai=echo`, no app features); status is `works`/`boots`/`untested`/`does not`, `works` reserved for a real feature suite | `917c5d0` | gate evidence carries `kind`/`scope`; status output |
| C1 | Ollama verified end-to-end and switched on (local backend enabled); keys stay owner-managed | `3c4b5fa` | real `llama3.2:3b` answered locally; fake-Ollama HTTP test |
| M7 | live DB: tool accounts already gone; removed the one disabled data-free `admin`; cloud keys cleared (owner re-enters) | live data | backup + audit row; see below |
| M9 | fork working tree committed clean (`e750f374`), docs describe "clean at fork HEAD", not frozen base | `e832dbc` + fork | `git -C upstream status --porcelain` empty |

### Behavior notes

- **M13** was a plain JS bug: `dedupeName` reassigned the result of a `const`,
  so every "Save to Puter" of an existing file threw after the file was
  written. Now fixed and pinned by a test.
- **M11** was the worker-runtime identity contract: `user.puter` was never
  provided, so teamchat/legal/childcare/fleet/field-service/property-
  management/help-desk backends 401'd every signed-in caller. The worker now
  sees the caller's uuid and the requestor object.
- **m1** keeps the `/h/` session gate untouched; only the two public,
  credential-free PWA paths sit outside it (browsers fetch manifests without
  cookies).
- **m5** is Puter-style background app connections, not a windowing system:
  a hidden iframe is a real app instance, and the meetings calendar sidebar
  now lists real calendar events.
- **M8** closes the last silent Drive write. The dialog is a closed shadow
  root; only trusted pointer events decide; app script cannot click it.
- **m4** does not weaken every app: the strict same-origin CSP is unchanged
  until the admin turns the allowlist on, and even then only four embed hosts
  are added to `frame-src`.
- **M10**: the generic gate proves boot + shim + kv/fs round-trip/restart +
  a canned AI echo, nothing else. `build-hub status` now says `boots` for
  those apps, `untested` when evidence is missing (never a failure), and
  `works` only with a real feature suite. README defines the vocabulary.
- **Ollama**: no key, native `/api/tags` list, chat through the same
  OpenAI-compatible adapter. On this PC 10 models are already installed;
  a real call to `llama3.2:3b` streamed `LOCAL-OK` (41 in / 4 out tokens,
  28.7 s cold on the 2-core CPU). No model was downloaded by this repo.
  Admin shows the one-time `ollama pull llama3.2:3b` hint; README §8 has the
  full steps and the 8 GB guidance.

### Live DB cleanup (owner-approved)

- Backup first: `data/backups/cad-before-cleanup-2026-10-26T11-08-51-071Z.db`.
- The audit's tool/test accounts (`appsmoke`, `dbg`, `diaguser`, `e2eprobe`,
  `functional-gate`, `hprobe`, `p1`, `probe-local`, `signe2e`,
  `teamchat-functional`) were already absent. One disabled, data-free
  `admin` row remained and was removed (sessions/kv/files/shares/links/ai/
  apps/hub all zero; verified before delete).
- Cloud provider keys cleared: Kimi, Google, OpenRouter, Groq. The owner
  re-enters them in Admin -> AI. Provider addresses and the chosen model
  list are kept.
- Ollama enabled (`enabled: true`, no key). `hubAiDefaultModel` was left at
  `openrouter:deepseek/deepseek-v4.1-flash-1017` because the owner said cloud
  stays the working default; until the key is re-entered CAD offers the local
  Ollama models and hub apps answer `no_key`. To run hub apps fully locally
  meanwhile, set Admin -> Hub default to `ollama:llama3.2:3b`.

### Verification numbers this session

- `npm test`: **663/663 pass** (52s), including the new Ollama fake-HTTP test.
- Browser E2Es (real Chromium, isolated data dirs): app connections **12/12**,
  folder consent **13/13**, AI stream failure **7/7**; results JSONs committed.
- `node build-hub.mjs status`: 51 apps, **works 0, boots 1, untested 50,
  does not 0**, built 51/51. This is the honest reading of current evidence:
  the only fresh smoke record is `cap-table` (from the audit), and the Oct 24
  functional evidence predates this wave's fixes. W4 regenerates both.
- `git -C upstream status --porcelain`: empty; HEAD `e750f374` on `main`.

### Open / next waves

- **W3**: engines fitting this CPU - tesseract OCR, Piper TTS, optional
  whisper.cpp; Pyodide vendoring for 3d (M6); NHTSA offline message +
  opt-in proxy (N1); image generation stays a documented cloud option (M3).
- **W4**: minimal eslint, CI yaml, one verify-all runner, hosting checklist +
  README/Ollama docs, a full functional-gate + smoke re-run to replace stale
  evidence, a fresh-host isolated E2E, and the `verification/` report updated
  (N2/N6 documented or closed; no open findings).

## Session 10 - 2026-10-26 - W2 peer/events wave: real LAN calls and live pushes

Owner scope: everything the audit flagged, in waves. This session is **W2
(peer/events)** and its acceptance. W1 is in Session 9; W3/W4 follow.

Platform commits: `a33f6be` (peer/events) and `090fad8` (real chess Online
acceptance).

### What W2 adds

- **`puter.peer`** (`lib/hub-peer.js` + `lib/shim/puter.js`): `serve()`,
  `connect(code, {turnGrant, anonToken})`, `inviteCode`, `connection` events
  with `{conn, user}`, `send`/`message`, `open`/`close` events, `close(reason)`,
  `owner`, `connections`, `linkState` + `linkstate` events, and
  `createGuestGrant()`. The invite code is eight chars of a no-ambiguity
  alphabet; invites and connections are host-scoped and die with the host
  socket. App data goes through the hub's authenticated WebSocket at
  `/api/hub/peer`; **media does not** - it uses a browser `RTCPeerConnection`
  between the two people, so the server never carries audio/video.
- **Media**: three logical slots - `0` audio/mic, `1` camera video, `2`
  screen video. The guest/dialer creates all three `sendrecv` transceivers
  before its offer; the host/answerer adopts the offer's transceivers and
  attaches any queued publications before `createAnswer`. Publishing after
  the answer renegotiates once per new direction. Screen publish on an
  established call is the tested renegotiation path. The shim also exposes
  `peerconnection`, `publish`, `unpublish`, and `configure`.
- **Call shape**: the guest creates an internal negotiated data channel
  `__cad_peer` (id 0) before the offer, so apps that negotiate their own data
  channels (whiteboard/photo-studio presence) have an SCTP transport to use.
- **`puter.events.onLocal`**: same-user KV and FS events over
  `/api/hub/events`. `kv:` subjects are same-user; events are emitted for
  every KV mutation (`set`/`remove`/`incr`/`add`/`update`/`flush`, with
  `flush` matching every KV subscription). Drive FS events are user-level and
  cover write/delete/mkdir/rename/move/copy, with canonical Drive-path
  aliases; sandbox FS events are app-scoped so one app cannot learn another
  app's files. The socket reconnects silently and only calls `onError` after
  five failed attempts; subscriptions are capped at 200 per socket. No
  cross-user shares and no `onPersistent` (documented).
- **Grants**: `POST /api/hub/peer/grant` requires a signed-in same-origin
  POST; a grant is host+app scoped, in-memory, 1 h TTL, and only joins the
  minting host's future invites. Grants are cleared on shutdown. A
  signed-out guest can join only with a grant; a signed-in guest does not
  need one.
- **Tests**: `test/hub-peer.test.js` - 4/4 protocol tests (relay both ways,
  invalid/app scoping, grant guest join + host scoping, events
  isolation/gap/flush). Full `npm test`: **667/667**.
- **Browser acceptance**:
  - `peer-e2e.mjs` **18/18** Chrome steps: invite, owner, relay both ways,
    three transceivers each, live unmuted audio+video with inbound RTP bytes,
    linkstate, host screen share on slot 2 with renegotiation, unpublish both
    ways, same-person KV event with value, other-person isolation, dead invite
    `invalid_invite`, no page errors. Evidence `peer-e2e-results.json`.
  - `chess-online-e2e.mjs` **8/8** Chrome steps against the real installed
    chess build: two people sign in, host creates an online game, guest joins
    with the code, both reach playing, the handshake names the opponent, host
    and guest each make a move and see the other's move (`1. e4 e5` on both
    boards), no page errors. Evidence `chess-online-results.json`.
- **Contract review**: meetings' real `net/session.js` uses
  `server connection`, `conn.owner`, `publish('camera')`,
  `publish('screen', stream, {video})`, `configure`, `peerconnection`,
  `media`/`mediaended`, `linkstate`, and `createGuestGrant()`; the shim
  matches those shapes, and `createGuestGrant` carries the app name. The
  chess acceptance exercises the data path; the peer probe exercises the
  media path.

### Known W2 limits (documented, not silent)

- No STUN/TURN: peers must be able to reach the hub (same LAN or a private
  overlay such as Tailscale). On networks with client isolation or symmetric
  NAT, a call may connect signalling but not media.
- The peer signaller does not auto-reconnect after a hub restart; live calls
  end with the host socket. Rejoining creates a new invite. This is written
  in the README limitations, not hidden.
- Grants are in-memory, so a hub restart invalidates outstanding guest
  invites.
- Events are same-user only; a shared drive does not push the owner's FS
  changes to a different signed-in person.

### Verification numbers this session

- `npm test`: **667/667 pass**.
- `node peer-e2e.mjs`: **18/18**; `node chess-online-e2e.mjs`: **8/8**.
- README peer/events sections updated with the surface, limits and test
  counts.
- The live server still runs the pre-W2 code; W4 restarts it after the final
  gates, so no half-migrated live state is presented as final.

### Open / next waves

- **W3**: engines fitting this CPU - tesseract OCR, Piper TTS, optional
  whisper.cpp; Pyodide vendoring for 3d (M6); NHTSA offline message +
  opt-in proxy (N1); image generation stays a documented cloud option (M3).
- **W4**: minimal eslint, CI yaml, one verify-all runner, hosting checklist +
  README/Ollama docs, a full functional-gate + smoke re-run to replace stale
  evidence, a fresh-host isolated E2E, and the `verification/` report updated
  (N2/N6 documented or closed; no open findings).

## Session 11 - 2026-10-26 - W3 engines/offline wave: local OCR and speech, vendored Python, opt-in NHTSA

Owner scope: everything the audit flagged, in waves. This session is **W3
(local engines + offline/opt-in services)**. W1 is in Session 9, W2 in Session
10; W4 follows.

### DONE

- **Local OCR** (`lib/hub-engines.js`): Tesseract.js 7 with a pinned local
  `tessdata_fast/eng.traineddata` and a local cache. `puter.ai.img2txt` goes
  through the authenticated `/api/hub/engine/ocr` route; calls are serialized,
  images are capped at 30 MB, and a missing engine fails with
  `engine_missing`/`engine_disabled`, never fabricated text. The browser
  acceptance read `LOCAL OCR WORKS` from the real fixture.
- **Local speech** (`lib/hub-engines.js`): Piper 2023.11.14-2 with the
  `en_US-ljspeech-medium` voice (public-domain LJSpeech dataset; the earlier
  candidate voice trained on a research-only dataset was replaced before
  release). Text is capped at 5,000 characters and written to Piper's stdin,
  never a shell command line. The shim resolves a real blob-backed `<audio>`
  whose bytes start `RIFF`; the test reads a WAV of ~100 KB.
- **Engine install/check**: `engines/install.mjs`,
  `npm run engines:install`, `npm run engines:check`. Every download is pinned
  by SHA-256; the binaries stay in gitignored `data/engines`. The installer was
  re-run against the pinned ljspeech voice and `engines:check` reports
  `OCR: ready (eng)` / `Speech: ready (en_US-ljspeech-medium)`. A fresh host
  with no files still fails honestly with the install hint.
- **Cloud images only** (`lib/hub-engines.js`, Admin → Hub → Engines): no
  Stable Diffusion on this CPU. `txt2img` uses an OpenAI-compatible
  `/images/generations` endpoint only when the owner sets a `provider:model`
  and the provider key exists. `txt2vid` is explicitly unsupported (501), and
  optional whisper.cpp is a named 501 rather than a pretend transcript.
- **Pyodide vendored** (`platform/vendor/pyodide/`, `platform/lib/hub*.js`):
  Pyodide `314.0.7` (Python `3.14.2`) is served from the authenticated,
  allowlisted `/hub/pyodide/` route; the 3d bundle's executable CDN URL is
  rewritten at serve time. The 3d CSP gains `'wasm-unsafe-eval'` only there.
  The acceptance ran `6 * 7` and a JSON round-trip with no runtime request
  leaving the hub origin. MPL-2.0/PSF notice and `LICENSE` travel with the
  vendored files.
- **NHTSA / fleet** (`lib/hub.js`, `lib/hub-rewrite.js`, Admin → Hub → Vehicle
  lookups): off by default (`hubNhtsaProxy=false`). When on, the fleet build's
  vPIC decode and recall calls are rewritten to authenticated same-origin
  `/hub/nhtsa/vpic/<vin>` and `/hub/nhtsa/recalls`; the upstreams are fixed by
  the host (test seams only), with 30 requests/min, an 8 s timeout and a 2 MB
  response cap. When off they answer 503 `nhtsa_offline`; the served app has
  the short offline message. No VIN is logged (audit kind/status only).
- **Admin/UI and shim**: engine status/consent routes, engine on/off switches,
  the cloud image model field, the NHTSA opt-in, and the `puter.ai` adapters
  are wired through the real shim. `puter.ai` returns the documented shapes,
  including `engine_missing` for unsupported kinds.
- **Docs**: README §Local engines, Pyodide/NHTSA rationale, the serve-time
  rewrite rule, license notes, the gap ledger, and the E2E commands/counts.
- **Verification**:
  - `npm test`: **681/681 pass** (includes real OCR, real Piper, fake Piper,
    fake cloud image provider, Pyodide route/rewrite, NHTSA route/rewrite).
  - `node engine-e2e.mjs`: **9/9** Chrome steps, including OCR and speech from
    two **real built apps** (expense and audio-studio) under their own CSP.
  - `node pyodide-e2e.mjs`: **8/8** Chrome steps against the installed 3d
    bundle.
  - `node --test test/engines.test.js`: **8/8**.
  - Evidence: `engine-e2e-results.json`, `pyodide-e2e-results.json`.

### PENDING (W4) — completed in Session 12

- Full functional gate + browser smoke against the installed apps, to replace
  the stale 23-app evidence and settle the app status vocabulary.
- Fresh-host isolated E2E, minimal eslint, CI, one verify-all runner and the
  hosting checklist.
- Full fleet UI click-through (route and rewrite are tested now; the UI flow
  belongs in the W4 app acceptance) and the final live-server restart.
- `verification/REPORT.md` re-verification: no open findings.

### W3 limits (documented, not hidden)

- Image generation and text-to-video have no local engine; images are the
  documented cloud option, video is a named 501.
- Whisper is an optional stub: the route is honest (501) rather than enabled.
- Piper ships English; another voice is a host-side change (`hubPiperModel`).
- The engine binaries and Pyodide runtime are large. Engines live in gitignored
  `data/engines`; Pyodide is vendored in git, so a checkout does not download
  it.
- NHTSA needs the internet **only when the owner opts in**; otherwise the
  fleet app stays on its offline message.

## Session 12 — W4 hardening, hosted acceptance, final re-verification (2026-10-26/27)

Commit: `2c72120`.

### DONE

- **Lint and CI:** ESLint 10 with Node/browser globals (`npm run lint`, **0
  errors, 53 visible warnings**); `.github/workflows/verify.yml` targets the
  self-hosted Windows host because the tests need sibling `../upstream` and the
  installed engine binaries.
- **One runner + hosting checklist:** `verify-all.mjs` (default and `--full`),
  `docs/HOSTING.md`, package scripts `verify`, `verify:full`, `e2e:engines`,
  `e2e:pyodide`. Full mode copies `data/` to a throwaway directory, runs the
  installed-app smoke/gate there, and copies only gate JSON evidence back.
- **Isolation fixes found by the acceptance:** `functional-gate.mjs` and
  `build-hub.mjs` now resolve gate/state paths from `DATA_DIR`; `browser-smoke`
  now wipes and reads `DATA_DIR/hub-users`, `DATA_DIR/files` and
  `DATA_DIR/cad.db` instead of the live path. Persist recipes also click the
  consent overlay when one appears. This was a test-harness bug, not an app
  regression.
- **Clean 51-app smoke:** every installed build renders; **0 external
  requests, 0 CSP violations, 0 uncaught errors, 0 failed requests, 0
  unexpected 4xx/5xx**. The W4 load pass found a real 3d defect (root-absolute
  `/assets/...` fonts in CSS and runtime JS); CSS and JS are now rebased at
  serve time, with unit and HTTP integration tests. Email's first-run
  `fs.stat` 403 is its request-access probe and is documented/handled.
- **51/51 infrastructure gate:** shim load, kv/fs round-trip, server restart,
  and canned `ai=echo`; `kind: infrastructure`, no feature claim. The gate now
  waits for a quiet call log and retries the capture, so late app reads are not
  mistaken for stuck calls.
- **Persist pass:** 10/10 recipes create through the real UI, show the data
  after reload, and survive a server restart (KV and files). The three
  file-saving recipes (notes, presentation, music-studio) exposed the
  isolation bug above; after the fix all three pass.
- **Fresh host:** 12/12 from an empty data directory, including first-owner
  login, app install, shim KV, honest missing-engine errors, and restart
  persistence.
- **Docs/report:** README counts and status vocabulary reconciled to 51
  installed builds and **3 works / 48 boots / 0 untested / 0 does not**;
  `verification/REPORT.md` is the final 24/24-closed re-verification with the
  original FAIL report preserved; `findings.json` has `open: 0`.

### Verification (W4)

- `npm test`: **682/682**
- `npm run verify:full`: **PASS** (full hosting acceptance)
- `npm run lint`: **0 errors, 53 warnings**
- `node smoke-hub.mjs`: **37/37**
- `node fresh-host-e2e.mjs`: **12/12**
- `node engine-e2e.mjs`: **9/9**
- `node pyodide-e2e.mjs`: **8/8**
- `node peer-e2e.mjs`: **18/18**
- `node chess-online-e2e.mjs`: **8/8**
- `node browser-smoke.mjs load`: **51/51**, clean; 8 documented long-poll nav timeouts
- `node functional-gate.mjs`: **51/51** infrastructure
- `node browser-smoke.mjs persist-all`: **10/10**

### PENDING

- None in the code wave. Owner action after restart: re-enter a cloud API key
  **or** set the Hub default to `ollama:llama3.2:3b` after `ollama pull`; the
  cloud keys were intentionally cleared and no model is bundled.

### W4 limits (same as the report)

- `boots` is the honest ceiling for infrastructure evidence; no app has a full
  feature suite in this port. Persist covers ten apps, not all feature flows.
- No STUN/TURN; peer works only where both people can reach this server.
- Image generation is cloud-only when configured; `txt2vid` and `speech2txt`
  are explicit 501s. Engines live in gitignored `data/engines`.
- `puter.hosting` stays disabled by default; enabling it is an owner decision.

## Session 13 - 2026-10-27 - app AI failures + Admin -> AI bulk model management

Commits: `5ebf63d` (AI), `d8da10e` (Admin bulk).

### Problem

- Photo Studio rejected the image preview and then ended with "I could not settle
  on a plan for this." The live usage table has 49 `hub:photo-studio` errors;
  the only enabled models are text-only OpenRouter ids, so the app's image
  request was refused before its text fallback, and small models could loop
  through its 8 tool rounds without calling `propose_plan` or `answer`.
- The admin model table only had a per-row switch/delete and a Save button.
  With 463 models in the live list there was no practical way to keep a small
  set.

### DONE

- **Platform-wide image fallback:** `lib/ai.js` recognizes an image-related
  400/404/413/415/422 from both the OpenAI-compatible and Anthropic adapters,
  retries the same turn without images, and returns the normal text/tool reply.
  A model-level refusal ("does not support image input") is remembered for the
  life of the process; a one-off bad image is retried but not cached. This
  prevents Photo Studio, documents and 3D from showing their own "preview was
  dropped" warning for a text-only model.
- **Tool-loop finalization:** when the offered tools include a final action
  (`answer`, `propose_plan`, `finish*`, `submit*`, ...), `lib/ai.js` adds a
  system reminder after 4 tool rounds in the current turn, and after 6 rounds
  leaves only the final tools. Apps without a final tool (3D, documents) are
  untouched. The regression test simulates Photo Studio's search loop and
  reaches `propose_plan` on call 7, before the app's 8-round cap.
- **Usage log timing:** `hub-ai.logMissed` now writes `ms = 0` instead of an
  epoch timestamp in the duration column.
- **Admin -> AI bulk models:** checkbox column, select-all-shown with partial
  state, shift-click range selection, selected count, bulk enable/disable,
  remove-selected, keep-only-selected, clear, and confirmations. Edits stay
  local until "Save models", matching the existing model/price flow.
- **Durable browser evidence:** `admin-bulk-e2e.mjs` (and
  `npm run e2e:admin-bulk`) starts a throwaway server, seeds 30 models, and
  verifies shift range, select-all, keep-only, bulk disable and remove through
  the real panel and the admin API. No live data is touched.

### Verification

- `npm test`: **686/686 PASS** (4 new AI tests; `test/ai.test.js` 13/13).
- `npm run lint`: **0 errors, 53 warnings**.
- `npm run verify`: **PASS** (host checks).
- `npm run verify:full`: **PASS** (full hosting acceptance; 51/51 apps load,
  gate 51/51, engines 9/9, Pyodide 8/8, peer 18/18, chess 8/8, and the new
  admin bulk E2E).
- `npm run e2e:admin-bulk`: **PASS** (system Chrome, throwaway data, 0 page errors).
- `node build-hub.mjs status`: **51 apps | works 3 | boots 48 | untested 0 | does not 0**.
- Live restart after the change: public `/healthz` **200**, private `/` **302 ->
  /hub/**, `/hub/` **401** without a session. A SQLite backup
  (`data/backups/cad-20261027104156.db`) was taken before the restart.
- `upstream/` is clean at `e750f374`; no app source was edited.

### PENDING / limits

- Live chat still needs an owner credential: the OpenRouter key is empty, only
  OpenRouter models are enabled, the GLM key has no enabled GLM model, and no
  Ollama model is pulled. Until one path is available, requests fail before the
  image fallback can run. This is a configuration gap, not the plan-loop bug.
- The image cache is in-process and only learns after a real refusal; there is
  no model-metadata pass that pre-marks text-only models.

## Session 14 - 2026-10-27 - 3D assistant screenshots reach the model

Commit: `34bd79e`.

### Problem

- The 3D assistant sends `capture_view` screenshots, and user image
  attachments, as Puter's Anthropic-shaped content blocks:
  `{ type: 'image', source: { type: 'base64', media_type, data } }`.
- `lib/hub-ai.js` only understood OpenAI's
  `{ type: 'image_url', image_url: { url } }` blocks. It kept the text and
  silently dropped the pixels, so the model was told "The screenshot from
  capture_view:" and then received no screenshot. In the reported run it built
  a tree into a collection that was not linked to the scene, captured a black
  isometric view, could not see that the screenshot was empty, and reported
  success instead of fixing the collection. Every hub app using this block
  shape was affected.
- The live configuration had also changed since Session 13: OpenRouter now has
  a working key and 20 models are enabled, including
  `nvidia/nemotron-3.5-super-vl:free`. The two stronger code models tried for
  3D (GLM and Groq Qwen) were rate-limited or out of balance, so the vision
  model was the working path.

### DONE

- `lib/hub-ai.js` now has `blockImage()`, which accepts both OpenAI
  `image_url` blocks and Anthropic `image` + base64-source blocks and turns
  both into the core's data-URI images. The existing vision path, image-refusal
  fallback and refusal cache now apply to 3D and any other app using Puter's
  SDK block shape.
- No app source or `upstream/` file was edited. Images are carried from the
  app's existing messages; the platform only stops discarding them.
- Tests cover both block shapes in one hub message and the Anthropic adapter's
  native image block.

### Verification

- `node --test test/ai.test.js test/hub-ai.test.js`: **21/21 PASS**.
- `npm test`: **687/687 PASS**.
- `npm run lint`: **0 errors, 53 warnings** (unchanged).
- `npm run verify:full`: **PASS** (687/687 tests; 51/51 apps load;
  infrastructure gate 51/51; engines 9/9; Pyodide 8/8; peer 18/18; chess 8/8;
  admin bulk PASS; fresh host 12/12).
- Live restart: PID **10420**, private `0.0.0.0:8080`, public
  `127.0.0.1:8081`; `/healthz` **200**, private `/` **302 -> /hub/**,
  `/hub/` **401** without a session. Backup before restart:
  `data/backups/cad-20261027132620.db`.
- Live `ai_usage` shows **9 successful calls** with the screenshot's model
  (`nvidia/nemotron-3.5-super-vl:free`) at 13:10-13:11. The 3D-specific entries
  at 13:05/13:07 are model-side rate limits, not transport failures (successful
  core calls are logged as `hub`, so only failures carry the app name). The
  screenshot-drop fix is live for the next turn.

### PENDING

- Browser confirmation after a hard refresh: ask 3D to build a model, let it
  call `capture_view`, and confirm the model can see the screenshot and fix an
  unlinked collection. No model download is needed; the live OpenRouter key is
  working.
- PDF attachments still use a different document path; this change covers the
  image blocks used by `capture_view` and image attachments.

## Session 15 - 2026-10-27 - 3D screenshots keep their pixels

Commit: `9f81131`.

### Problem

- Session 14 fixed the transport that dropped Anthropic-shaped image blocks, so
  the model finally received the 3D assistant's screenshots. The owner then
  retried a live build and the preview in "What the assistant saw" was still a
  pure black rectangle; the model correctly said the screenshots were coming
  back black and had to work from scene state.
- The black image is made in the app, not by the provider. The 3D renderer is
  created with `preserveDrawingBuffer:false`. A local readback probe copied the
  viewport *after* the browser composited a frame and got pure black (average
  luminance 0) even though the page screenshot showed a lit cube and grid.
  `capture_view` then copies that same shared canvas into the JPEG it shows and
  sends. The app's forced draw normally wins that race, but the after-compositing
  copy is a live black path; preserving the buffer removes it. This is the only
  capture-level black path found in the app; the owner's next run will confirm
  whether their GPU hits this same path.
- This is the remaining client-side half of the Session 14 finding. The image
  transport is working: live `ai_usage` calls are `ok` and input tokens grow
  with the screenshots.

### DONE

- **Serve-time drawing-buffer rule:** `lib/hub-rewrite.js` now has
  `APP_JS_RULES['3d']` rule `3d-preserve-drawing-buffer`, which rewrites the
  built renderer option `preserveDrawingBuffer:!1,stencil:!0` to
  `preserveDrawingBuffer:!0,stencil:!0`. No app source or `upstream/` file is
  edited; the app keeps its build, the platform only serves those bytes.
- The rule is registered in `REWRITE_RULES`, so the §22 zero-match gate keeps
  it honest when the 3D bundle is rebuilt. A unit test runs the rule against the
  installed 3D bundle and asserts the non-preserving form is gone.
- **Browser regression test:** `3d-capture-e2e.mjs` starts a throwaway server,
  installs the 3D app, loads it in system Chrome, asserts the served bundle
  carries the rule and that `getContextAttributes().preserveDrawingBuffer` is
  true, then draws the scene, lets the browser composite it, and copies the
  viewport without forcing another draw. The copy must still have pixels.
  Wired as `npm run e2e:3d-capture` and into `verify:full`.
- The fix applies to every 3D session after the app tab is reloaded. An already
  open tab keeps the renderer it created before the server restart.

### Verification

- `node --test test/hub-rewrite-rules.test.js`: **11/11 PASS** (new rule test).
- `npm run e2e:3d-capture`: **PASS** (273x509 viewport, average luminance 63.0,
  `preserveDrawingBuffer=true`, 0 page errors).
- Manual browser evidence before the rule: a delayed viewport copy was pure
  black (avg 0). With the served rule: the same copy averaged 62.96; the
  assistant's own `capture_view` JPEG averaged 91.85.
- `npm test`: **688/688 PASS**.
- `npm run lint`: **0 errors, 53 warnings** (unchanged).
- `npm run verify:full`: **PASS** (688/688 tests; 51/51 apps load; gate 51/51;
  engines 9/9; Pyodide 8/8; peer 18/18; chess 8/8; admin bulk PASS; new 3D
  capture E2E PASS; fresh host 12/12).
- Live restart after the change: PID **2080**, private `0.0.0.0:8080`, public
  `127.0.0.1:8081`; `/healthz` **200**, private `/` **302 -> /hub/**,
  `/hub/` **401** without a session. Backup before restart:
  `data/backups/cad-20261027151710.db`.
- `upstream/` is clean; no app source was edited.

### PENDING

- Owner: reload the 3D tab once (Ctrl+Shift+R), start a fresh chat, ask for a
  capture, and confirm the preview shows the room. The loaded JS from before
  the restart still has the old renderer.
- If a preview is still black after that reload, capture the tab's console and
  `document.querySelector('canvas.gl-canvas').getContext('webgl2').getContextAttributes()`
  so the next step is measured on the owner's actual GPU, not guessed.
- The live signed-in Photo Studio image+plan validation and the optional Admin
  -> AI bulk pass on the 463-model list still need the owner's browser session.

## Session 16 - 2026-10-28 - Photo Studio builds staged native artwork

Commit: `a84e06a8` (upstream).

### DONE

- The Photo Studio Assistant no longer stops at a prose plan. Its plan runner
  now executes the app's own document, layer, selection, shape, pen, gradient,
  paint, Smart Object, export and project-download operations.
- Plans can declare `stages`; each step can belong to a stage and every stage
  can narrate before its steps. The panel offers **Run in One Go** for the
  normal continuous run and **Run by Stage** with **Next Stage** / **Run the
  Rest** when the owner wants review points.
- `MAX_STEPS` is now 120 and `op.new_document` is marked as creating a
  document, so a plan can start with a blank 3000x4000, 300 ppi RGB document.
- Layer names are deterministic (the requested name when free, otherwise a
  numbered suffix), and the runner records the whole plan as one undo step.
- Direct `.photo` project download and flattened PNG export are part of the
  native plan path. A structured download is required because the quiet
  assistant runner cannot drive a browser save dialog.
- `art.ts` accepts case-insensitive gradient/shape names, numeric or percent
  stops, one-point paint stamps and line-stroke fallback.

### Verification

- Photo Studio TypeScript check: **PASS**.
- Assistant unit suite: **42/42 PASS**.
- Targeted browser tests for staged native artwork, direct `.photo` + PNG
  downloads, and group/mask/clip/Smart Object assembly: **3/3 PASS**.
- Full Photo Studio browser suite: **24/24 PASS** after two load-induced
  5-second timeouts were rerun alone.
- Production bundle: `node platform/build-hub.mjs build-one --only
  photo-studio`, **101.3 s**, installed into the served hub.
- 12 MP blank-document creation benchmark: **2993 ms**.
- Live server: PID **4628**, private `0.0.0.0:8080`, public
  `127.0.0.1:8081`; `/healthz` **200**. Backup before restart:
  `data/backups/cad-20261028010506.db`.

### PENDING

- The live 3000x4000 artwork run still needs the owner's signed-in browser
  session. The open browser tab redirects to the hub sign-in page.
- A real 12 MP export/download has not been measured; committed download e2e
  uses 1200x1600 and the staged e2e uses 600x800.
- Live Photo Studio generative fill/image validation is blocked because no
  `hubImageModel` or image-provider key is configured.

## Session 17 - 2026-10-28 - Documents and Whiteboard join the native tool loop

Commits: `0e023619` (Documents), `522a5a6e` (Whiteboard).

### Problem

- Documents had one mutating tool, six rounds, a 4,096-token ceiling and no
  way to inspect the sent text, so a long rewrite had to be emitted in one
  shot. Its prompt explicitly asked for a single `edit_document` call.
- Whiteboard's AI actions were fixed prompts with no board tools at all. It
  could summarize or cluster a selection, but could not add notes, find
  objects, update them, frame them, or arrange a multi-stage board.

### DONE

- **Documents** now exposes `get_document`, `read_range` and `find_text` beside
  `edit_document`. `edit_document` gained a `replace_range` mode with exact
  UTF-16 offsets. The prompt tells the model to inspect first, edit long text
  in sections, re-read after a change, and then reply with one short sentence.
  The loop allows **16 rounds** and **8,192 output tokens**; `Undo all` takes
  back every edit made in one reply. Range edits require the whole document to
  have been sent, so the existing selection-only privacy boundary stays intact.
- **Whiteboard** has a new **Build or edit with AI** action. It runs a JSON
  tool loop with `get_board`, `find_objects`, `read_object`, `add_notes`,
  `update_objects`, `delete_objects`, `create_frame`, `arrange_grid` and
  `finish`. Writes go through the board's ordinary `mutate()` path, lock and
  read-only checks, and undo history. The loop is capped at eight tool turns;
  each turn sees a compact result and can correct a failed call. Organization
  policy maps the agent to the existing summaries permission and the worker
  accepts the new `agent` task, so no new policy switch or external call path
  was introduced.

### Verification

- Documents: `npx vitest run tests/assistant-tools.test.js tests/ai.test.js`
  **13/13 PASS**; production build **PASS**; served hub install
  `build-one --only documents` **PASS** (23.9 s).
- Whiteboard: new agent and agent-UI tests plus AI/help tests **39/39 PASS**;
  production build **PASS** (2,155 modules, 16.3 s); served hub install
  `build-one --only whiteboard` **PASS** (38.8 s).
- Whiteboard's new tests cover JSON call parsing, compact board reads, add/
  update/delete, frame creation, grid arrangement and read-only refusal. The
  UI test runs `add_notes` through `createAI`, feeds the tool result back, and
  checks the model's finish message in the dialog.
- Built assets for both apps were installed at 01:52 on 2026-10-28 and the
  served bundles contain the new tool strings.

### PENDING

- The full Whiteboard suite still has two failures that reproduce at the
  predecessor commit `0e023619`: the admin overview link test and the
  `built editors join the same board` collaboration test (`Unexpected end of
  JSON input`). Both are pre-existing and unrelated to the Assistant; every
  AI/agent test in the same run passed.
- The full Documents suite was run under concurrent load and hit six
  canvas-editor timeouts (vertical-align, character-spacing, capitalization,
  text-width). All six passed when rerun alone (the first in 13.1 s; the other
  five in 34.2 s), confirming load-induced timeouts rather than an assistant
  regression. The assistant files themselves are green.
- Live signed-in execution of a multi-stage Documents rewrite and a Whiteboard
  board build still needs the owner's browser session, as with Photo Studio.
- CAD, Presentation, Spreadsheet and Video Studio already have native tool
  loops; their remaining gaps are narrower (blank-project/new-file starts and
  larger batch operations) and are queued after the three app-native paths
  above are validated live.

## Session 18 - 2026-10-28 - Assistant regressions: Markdown, empty turns, stale model

Commits: `0af51c7f` (Documents), `c0b98f97` (Photo Studio), `4ec1941` (hub AI
resolution).

### Problem

- The Documents Assistant wrote its reply with the plain-text insert path, so a
  model that followed the prompt and returned Markdown put literal `#` heading
  markers, `**bold**` and `-` bullets into the document. The tool loop also sent
  a messages array while the offline mock only understood one prompt string, so
  the browser Assistant test could not see its own request.
- Photo Studio occasionally received an empty model turn. The loop then fell
  straight through to the prose fallback and told the owner to try again,
  instead of retrying or leaving the model enough output room for a long plan.
- Whiteboard's personal AI path failed before any board work with `bad_model`.
  The live `hubAiDefaultModel` was the stale `nvidia:nemotron-3.5-super-vl`
  while the enabled model was `openrouter:nvidia/nemotron-3.5-super-vl:free`.

### DONE

- **Documents** now keeps the model's Markdown for insertion and converts it
  through the engine's existing `markdownHtml` -> `htmlFragment` ->
  `pasteFragment` path. Headings become real `Heading 1`/`Heading 2` paragraph
  styles, lists become native list paragraphs, and emphasis becomes run
  formatting; conversion failure still falls back to a plain insert. The
  assistant prompt and tool description ask for Markdown. Both the free-form
  reply path and the `edit_document` tool path are covered in the browser.
- **Photo Studio** raises `MAX_ROUNDS` to 12 and sends `MAX_TOKENS = 8192`
  through `chatWithTools`. An empty turn now retries once without the image
  preview, then retries with an explicit "your previous reply was empty" nudge
  before the prose fallback appears. The fallback also suggests choosing
  another model. `puter-ai.ts` forwards `max_tokens` to the hub.
- **Hub AI** validates every requested `provider:model` id against the
  configured provider and enabled `ai.models`; a stale default falls back to
  the first enabled model, and an unknown provider no longer counts as a local
  model. The live `hubAiDefaultModel` is now
  `openrouter:nvidia/nemotron-3.5-super-vl:free`; the server was restarted with
  the new resolution code (PID 11488).

### Verification

- Documents: assistant unit tests **13/13 PASS**; the three Assistant browser
  tests **3/3 PASS**, including real `Heading 1`/`Heading 2` styles, bold and
  italic runs, list paragraphs and the tool path; production build and served
  hub install **PASS** (21.9 s). The HWP file test passes alone **57/57**; a
  full unit run under load hit its 20 s timeout and was stopped by the command
  timeout, not by an assistant assertion.
- Photo Studio: `npx tsc --noEmit` **PASS**; assistant tests **45/45 PASS**;
  the full suite reached **2,194 passed / 4 timed out** under concurrent load,
  and those four files passed alone **48/48** with a 120 s timeout. A live probe
  using the real system prompt, real catalog and real hub model returned a
  plan for "draw a blue dog". Production build and served hub install **PASS**
  (85.0 s).
- Whiteboard: `node --test tests/ai-agent-ui.test.js` **1/1 PASS**. A live
  `hubAi.chat` call with no explicit model and the corrected default returned
  `ready` instead of `bad_model`.
- Platform: root suite **689/689 PASS**; `test/hub-ai.test.js` **9/9 PASS**.

### PENDING

- Signed-in verification of a multi-stage Documents rewrite, a Whiteboard board
  build, a 3000 x 4000 Photo Studio plan and a real 12 MP flattened PNG/project
  download still needs the owner's browser session.
- Photo Studio generative fill and image validation remain blocked until an
  image model (`hubImageModel`) or an image-provider key is configured.
- The two pre-existing Whiteboard full-suite failures remain: the admin
  overview link test and `built editors join the same board`
  (`Unexpected end of JSON input`).
- The full Documents browser suite (2,717 tests in 785 files) and the full
  Documents unit suite were not completed in this session; the affected
  Assistant tests and the HWP suite were run directly.

## Session 19 - 2026-10-29 - Assistant consistency: Whiteboard execution, Photo plans, Building Design entry

Upstream commits: `bba8dead` (Whiteboard), `0936adcc` (Photo Studio),
`8189d758` (Building Design).

### Problem

- Whiteboard's "Build or edit with AI" printed the model's JSON instead of
  changing the board: the model emitted `{"type":"add_notes",...}` and
  OpenAI-style `tool_calls`, while `parseAgentReply` only understood
  `{"tool":...,"args":...}`. The dialog also had no way to choose among the
  server's models.
- A long Photo Studio plan grew past the assistant panel, so its Run All,
  Step and Next Step controls scrolled out of reach.
- Building Design had no assistant at all: no dock panel, titlebar button,
  shortcut or phone entry, and no way to ask about the open project.

### DONE

- **Whiteboard** normalizes `tool`/`type`/`action`/`name`/`function`,
  OpenAI-style `tool_calls`, a single call wrapped in an array, string or
  object `args`/`arguments`, top-level arguments, and `finish` messages.
  Anything that is not a tool call stays a prose answer, so raw JSON is no
  longer printed. Personal boards get a model picker in the AI dialog fed by
  `p.ai.models()` with `tools !== false`; the choice is stored in
  `whiteboard:assistant:model` and forwarded to `p.ai.chat`. Organization
  boards keep the administrator's model policy.
- **Photo Studio** caps `.ast-plan` at the visible log height, makes the plan
  header and footer non-shrinking, and gives `.ast-steps` the only scrollbar.
  Run All, Step and Next Step stay visible while the steps scroll.
- **Building Design** now has an Assistant tab in the lower dock (Browser /
  Assistant), a titlebar Assistant button, the `AI` shortcut and a phonebar
  button. The panel sends a factual project brief (name, units, levels,
  element counts, rooms, active view, selection) and is advisory: it never
  edits the BIM model. The model list comes from `p.ai.models()` and persists
  under `bd.assistant.model`; with no list the server default applies. It has
  sign-in and unavailable states, suggested questions, Markdown-lite replies,
  a scrollable log, Stop and New conversation.
- **Audit**: CAD (View -> Palettes -> Assistant), 3D (titlebar + dock),
  parametric (Ctrl+J), presentation (Ctrl+J), spreadsheet, video studio,
  Documents, Whiteboard and Photo Studio already have a visible entry point,
  model choice and a scrolling conversation. CRM, help desk and survey use
  inline AI actions by design, so they were left unchanged. No further code
  changes were needed.
- The served hub now has rebuilt Building Design and Whiteboard bundles at
  upstream `8189d758`; Documents and Photo Studio remain at `c0b98f97`.

### Verification

- Whiteboard: `node --test tests/ai-agent.test.js tests/ai-agent-ui.test.js`
  **8/8 PASS** (alternate call shapes, model list filtering, persistence and
  forwarding of the chosen model).
- Photo Studio: the new 24-step browser test **1/1 PASS**; it asserts the
  steps scroll, the footer stays between the plan and the log edge, and
  Run All stays in the viewport after scrolling to the last step.
- Building Design: production build **PASS**; the full e2e suite **12/12
  PASS** on desktop and phone, including the assistant discoverability,
  model and project-context test and the phone layout test.
- Hub: `node build-hub.mjs build-one --only building-design,whiteboard`
  **PASS** (19.0 s and 49.8 s); the upstream clone stayed clean.

### PENDING

- Signed-in verification still needs the owner's browser session: run a
  Whiteboard board build with a chosen model, review and run a 3000 x 4000
  Photo Studio plan and export, and ask the Building Design assistant about a
  real project.
- Whiteboard's two pre-existing full-suite failures are unchanged: the admin
  overview link test and `built editors join the same board`
  (`Unexpected end of JSON input`).
- Photo Studio generative fill still needs an image model (`hubImageModel`)
  or an image-provider key.
- CAD's assistant entry remains View -> Palettes -> Assistant; a titlebar
  button would match the other apps if the owner wants one.

## Session 20 - 2026-11-02 - Photo Studio bundle rebuilt and the sweep repeated

Upstream commits: product fixes remain `bba8dead`, `0936adcc`, `8189d758`;
the Photo Studio test timing change is `b760b00a`.

### Problem

- Session 19 rebuilt only Building Design and Whiteboard. The served Photo
  Studio bundle still predated `0936adcc`, so the app at `/h/photo-studio/`
  did not have the plan-scroll fix even though the source did.
- Re-running the Photo Studio assistant suite exposed a timing assumption:
  the first plan renders only after the Assistant loads every command's
  settings. A cold Vite dev server transforms a different command module per
  step and took about 30.4 s, just past the 30 s default assertion budget.
  A production build ships those modules pre-bundled.

### DONE

- Committed a 90 s budget on that one count assertion, with a comment that
  explains the dev-transform cost; no product code changed for this.
- Rebuilt the served Photo Studio bundle with
  `node build-hub.mjs build-one --only photo-studio`. The build installed 236
  files in 93.1 s and `data/hub/build-state.json` records `ok: true`; the
  upstream clone stayed clean. The served assets and `index.html` are from
  this build.
- Repeated the full verification sweep below so the rebuilt bundle and the
  three assistant fixes are backed by current evidence.

### Verification

- Building Design e2e: **12/12 PASS** (11 desktop plus 1 phone), including
  the assistant dock/titlebar discoverability, model picker and project
  context test. The bundled Playwright Chromium is not downloaded on this
  machine, so the suite ran against the installed Chrome channel through a
  temporary config; the config was removed afterwards and the clone is
  clean. The suite had failed before any test ran only because that browser
  was missing. Building Design unit suite: **82/82 PASS** (13 files).
- Photo Studio assistant browser suite: **12/12 PASS**, including the
  validated/edited/stepped plan, the 24-step scroll test, staged native
  artwork, layered project and flattened PNG downloads, and Generation
  History. Photo Studio unit tests `assistant.test.ts` and
  `assist-ai.test.ts`: **52/52 PASS**.
- Whiteboard `ai-agent.test.js` and `ai-agent-ui.test.js`: **8/8 PASS**.
- Platform root suite: **689/689 PASS**.
- Hub build-state: `photo-studio` `{ ok: true, files: 236, workers: [] }`;
  Building Design and Whiteboard remain the `8189d758` bundles.

### PENDING

- Signed-in verification still needs the owner's browser session: a
  Whiteboard board build with a chosen model, reviewing and running a
  3000 x 4000 Photo Studio plan plus a real 12 MP project/PNG download, a
  multi-stage Documents rewrite, and a Building Design question about a real
  project.
- Photo Studio generative fill still needs an image model (`hubImageModel`)
  or an image-provider key.
- Whiteboard's two pre-existing full-suite failures are unchanged: the admin
  overview link test and `built editors join the same board`
  (`Unexpected end of JSON input`).
- CAD's assistant entry remains View -> Palettes -> Assistant; a titlebar
  button would match the other apps if the owner wants one.
