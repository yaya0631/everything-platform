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
