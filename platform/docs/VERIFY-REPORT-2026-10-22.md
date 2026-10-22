# VERIFICATION REPORT — for an independent LLM audit (2026-10-22, git `deccd88`)

Written by the working agent (GLM-5.3, opencode) at the owner's request, so a
SECOND, independent model can verify the claims and judge how close the apps are
to full everyday use. Everything below separates **verified by running** from
**assumed/stale**; nothing here was written without running it unless marked.

The verifying model should hold the repo to the protocol in
`platform\docs\AI-PROGRESS.md` (§ Protocol) and the standing rules in
`platform\docs\AGENTS.md` (§2, §7, §8). If any claim fails re-verification,
report it; do not trust this document over your own run.

---

## 1. What this project IS (the direction)

A personal home server (old Windows PC, reached through Tailscale) that replaces
Puter's cloud for ALL the apps of `https://github.com/HeyPuter/everything`
(51 apps in `upstream\src\<app>`): accounts, file drive, sharing, live
co-editing, AI assistant, email, serverless **workers** (Puter
`workers.create/exec` emulation), per-user app data, admin panel — self-hosted,
two-listener (private behind `tailscale serve`, public behind funnel), Node.js
+ SQLite only, no feature removed, **no external calls FROM APPS at runtime**
(server-side may use owner-configured providers: AI keys, SMTP).

**Owner's architecture correction (2026-10-22, governs everything):** the AutoCAD
clone ("cad-home") is NOT special — it is ONE app, a first test case. Platform
code must not live in or depend on its folder. Apps never call Puter's
cloud/external APIs directly; everything goes through the owner's server. The
platform was therefore split out into its own folder this same day (§3).

## 2. Current layout (post platform-split S1–S6, owner-approved, executed 2026-10-22)

Repository root `D:\Stream\everything\` (git `.git` lifted there; entire history
carried by renames — `git log --follow` walks back to baseline `c8e1d5a`).

```
D:\Stream\everything\
  platform\          ALL platform code (this is where work happens; npm test here)
    server.js hub.js users.js apps.js          entry points
    lib\        hub.js/rewrite/shim/build/workers(-http,-run)/fs/drive/ai/mail/
                store/db (integrity gate)/config/paths …
    sdk\ panel\ test\ tools\ docs\ data\       data\cad.db REAL user db (intact)
    build-hub.mjs run-upstream-suite.mjs functional-gate.mjs browser-smoke.mjs …
    invoicing-e2e.mjs sign-e2e.mjs (+ their results json)
  cad\app\           the CAD client app (own package.json, vitest suite; dist built,
                     served by the platform; paths.js CAD_APP_ROOT points here)
  upstream\          pristine HeyPuter/everything clone — MUST stay clean (HEAD 0fc4d361)
  .gitignore         data/, node_modules/, _*.mjs, *.log, /upstream/, /_app-folder-archive/,
                     cad/app/dist/
D:\Stream\_app-folder-archive\   50 old loose per-app folders (archived, not deleted)
```

Deliberately NOT renamed (owner order): `cad.db`, `CAD_TEST`, `cad_session`
cookie, db-download labels `cad-home-<date>.db`, the `cad-home serve-time
guard` service-worker marker. App-visible URL contract unchanged: server
storing uses relative `/wr/<user>/<name>/` + `/w/...`; apps see only the
canonical `https://<host_label>.puter.work` alias at the shim boundary (§26 of
the design doc).

## 3. Timeline of actions (every commit from baseline to head)

| Commit | Step | What was done | How it was verified |
|---|---|---|---|
| `c8e1d5a` | Step 0 | Real state rebuilt: suites measured (360/364 — 4 red worker-URL-shape tests from a regression), `data\cad.db` repaired after a WAL corruption incident, repo git-initialized | keep `data\_dbdiag-20261022123133\` (owner order: never delete) |
| `1924a97` | Decision 1: **URL alias boundary** | server keeps §23 relative shapes; shim canonicalizes rows to `https://<label>.puter.work`; craft rules `sign-link-host`/`sign-worker-self`/`sign-page-url` restored byte-exact; new `test\worker-alias.test.js` (9 tests); 2 real defects fixed in the same round: (a) redeploy of an existing worker name crashed `UNIQUE constraint failed: hub_workers_host_label_ci` → `create()` UPDATEs in place and resets public approval when source changed; (b) `parseW` in `lib\hub-workers-http.js` shadowed the calendar label arm (`/w/cal-<user>/api/...` 404'd) → `cal-` arm leads both forms | root 373/373 (incl. 9 new), app 482/482, `build-hub.mjs status` runs |
| `7c53541` | Real product bug: **shim fetch body detach** | `new Request(new Request(url, init))` detached POST bodies in real Chromium → every bodyful worker POST died (`ERR_ALPN_NEGOTIATION_FAILED`); fixed in `lib\shim\puter.js` (single Request per fetch, body read once) + new contract test `test\shim-fetch-body.test.js`; Node/undici tolerated the bug, browser did not | real-Chromium probe matrix: GET + every POST variant 200; root 374/374 |
| `e4cd21e` | Decision 3: **DB integrity gate** | corruption analysis proved nothing was lost (main db held all; kept WAL had ZERO valid frames — torn header, salts/checksums fail). NEW: `lib\db.js open()` runs `PRAGMA integrity_check` at startup, byte-backs-up into `data\_dbrecover-<stamp>-<pid>\` and REFUSES if malformed; clean close runs `wal_checkpoint(TRUNCATE)`; NEW `tools\db-backup.mjs` (VACUUM INTO — safe while running); README section | `test\db-integrity.test.js` 3/3; backup file real (270 336 bytes); root 377/377 |
| `029eb47`, `107c76f` | §4 review: **4.1 census + 4.5 hosting consumers** | design doc §28 rewritten as an honest file:line census (0 per-app serve-time rules needed); §27 per-app publish table; REAL gap found and fixed: contracts publish `.ics` feeds but the `/site` MIME allowlist refused them → `.ics → text/calendar` + test in `test\hub-hosting.test.js` | root 377/377 (incl. new test) |
| `029eb47`/§29 | Peer relay design written — NOT implemented (owner forbade code before approval) | `docs\phase3-workers-design.md` §29: WebRTC, signalling on our WebSocket, invite codes, no external STUN/TURN, optional self-hosted TURN. 3 acceptance questions await the owner (see §7 of this report) | n/a — no peer code exists |
| `107c76f`, `be22f6b` | Docs protocol | standing `docs\AI-PROGRESS.md` session log + update protocol; linked from AGENTS §5 | — |
| `046da89` | Architecture correction → **platform-split PROPOSAL only, no code moved** (awaited owner approval per the owner's own order) | `docs\PROPOSAL-platform-split.md`: layout, move list, 6 steps, risks, 3 questions (platform name, S5 rename, git-root lift) | owner approved all three |
| `1a4a7f4` | **S1** | `tools\db-backup.mjs` first; 50 loose app folders archived to `D:\Stream\_app-folder-archive\` | 377/377 + 482/482 unchanged |
| `5ef8350` + `649a156` | **S2 git-root lift** | `.git` → `everything\`; git saw **518 pure renames** into `cad-home\` (history fully intact). Self-caught bug: unanchored `upstream/` ignore ALSO hit `test\fixtures\upstream\` → patterns anchored (`/upstream/`), fixture re-tracked, fix committed | suites unchanged |
| `b33e425` | **S3 platform move** | every tracked platform entry `git mv` → `platform\`; `data\` + `node_modules\` moved with the filesystem; anchors fixed (`test\live.test.js` imports, `lib\paths.js`); `everythingDir: '../upstream'` verified CORRECT (resolves against ROOT_DIR) — a first wrong-guess default was caught by `build-hub.mjs status` and reverted | 377/377 + 482/482; `build-hub.mjs status` PASS |
| `3649fff` | **S4 CAD client move** | `cad-home\app` → `cad\app` wholesale (dist + node_modules intact); scripts/paths repointed. Self-caught: `cad/app/dist` briefly git-tracked → re-ignored + commit amended | 377/377 + 482/482 |
| `04bc4d6` | **S5 rename complete** | cad-home emptied + deleted; package name `platform`. Self-caught via the repo's OWN test: PowerShell BOM in package-lock.json → `test\encoding.test.js` failed → stripped | 377/377 |
| `deccd88` | **S6 junk + docs** | 31 `_`-probes, `prototype-data-browsercheck\`, 4 `browser-smoke-results*.json` deleted (grep-verified: comment references only); AI-PROGRESS/AGENTS/README updated to the new layout | suites + status PASS |

**Test-expectation changes, complete and declared list:** exactly ONE —
`test\hub-guest-links.test.js:91` (Decision 1 round): it asserted the
app-visible alias from a SERVER-internal API return value; under the confirmed
boundary that API keeps the relative route (shim applies the alias), and the
original public-serving behavior is still asserted in the same test. Everything
else that movers touched (imports in `test\live.test.js`) is path plumbing, not
expectations.

## 4. Exact re-verification commands (run these yourself)

From `D:\Stream\everything\platform\` (PowerShell; no `&&`) :

```
npm test                              # expect: tests 377, pass 377, fail 0
npm --prefix ..\cad\app test          # expect: 482 passed (vitest, 31 files)
node build-hub.mjs status             # full 51-app table (Headline: works 0/51 — by design, see §5)
node invoicing-e2e.mjs                # expect 11/11 (real Chromium; uses the REAL data dir)
node sign-e2e.mjs                     # expect 12/17; the 5 red = ONE known design conflict (§6)
git -C ..\upstream status --short     # MUST be empty; HEAD 0fc4d361
git log --follow --oneline -- platform\lib\hub-workers.js   # walks back to c8e1d5a
node tools\db-backup.mjs              # data\backups\cad-<stamp>.db written, integrity ok
node check-firewall.mjs               # worker-node firewall verification (docs)
```

Known db state of the REAL `data\cad.db` right now: integrity ok, 7 users,
hub_workers 7, hub_kv 7 (grew from the step-0 5/3/5 because the two E2E
drivers, which deliberately run against the real dir, created their test
accounts/workers there — that is by design, documented).

## 5. HONEST app-readiness state (the part you asked to audit)

`build-hub.mjs status` is the single source of truth. Headline as of now:
**status works 0/51 — and that is CORRECT, not a regression.** Why:

- **24 apps are BUILT + INSTALLED** (dist present in `data\hub\apps\<app>\`,
  hub serving works; "services" column PASS). These are mostly easy-tier apps
  (games, notes, tasks, survey, pos, projects, ...).
- **24 apps carry upstream suites that PASS in upstream harnesses** through
  `test\vitest-shim` (e.g. signatures 370/370 across its adapters; invoicing
  749/749; whiteboard 102; teamchat 90; calendar 51 incl. the rsvp worker).
- BUT the **runtime-coverage wave is NOT done**: the adapters deliberately
  report `runtimeCovered: 0` because those upstream cases still run in upstream
  harnesses, not yet against THIS server's runner/shim/hub API. Real numbers:
  signatures **0/172**, invoicing **0/96** (its E2E is separately 11/11),
  calendar **0/45**. Until that wave runs, the honest `server tests` column
  stays 0/x.
- **Functional gates**: implemented and verified for **accounting only**; all
  other built apps show `func-pending` — they load and build, but no per-app
  round-trip evidence file exists yet. This is SCHEDULED work (§5 "4.3 wave"),
  not a broken gate mechanism.
- **Smoke**: `smoke seen for 0` — the browser smoke has a pending rerun status
  in the table (the old smoke results were deleted in S6 because they were
  stale throwaway artifacts; the smoke EXECUTES but PENDING in the table is the
  honest current verdict).
- **The CAD app itself** (this platform's first product): platform plumbing is
  the most verified thing in the repo, the CAD client suite is 482/482, live
  co-editing, drive, sharing, AI, mail, accounts all have green tests. The
  status table does NOT track the cad client (it is served at root by
  server.js, not hub-installed) — its readiness is carried by the two suites +
  the E2E drivers.

**Bottom line for "are the apps soon ready for full usage?"** — the
infrastructure (server, shim, workers, hub, drive, AI, mail, DB safety,
URL contract) is in place, tested and hardened; what remains before apps flip
to "works" is *app-level gate evidence and productization work*, in this order:

1. Runtime-coverage wave for the productized worker apps (signatures, invoicing,
   calendar already have adapters; ~313 upstream cases to run against our
   runtime, then the counts go real).
2. Functional-gate wave for the 24 built easy-tier apps (one round-trip probe
   each, like accounting's).
3. Productization of the remaining ~22 worker-tier apps (most have NO server
   tests yet; zero-backend-test apps need every `puter.*` call site turned into
   an HTTP test; documents also needs a two-browser smoke).
4. Guest links + public workers: firewall step on the real server
   (`check-firewall.mjs`) before public member workers can be enabled.
5. Big missing feature groups (NOT started): peer relay (waiting on §29
   approval), AI engines (txt2img/TTS/STT/OCR/video), hosting/site/net,
   drivers, events, perms, launchApp, the email app UI, maps tiles, VIN,
   Pyodide bundle, whiteboard/documents workers.

So: the CAD app is daily-usable NOW for its implemented scope (single-player
features + collaboration server-side are green; the honest difference list is
in README "honest diffs"). The other 51 apps are built/served and run their
upstream code, but the honest status is "does not (gate not completed)" until
waves 1–3 above land. That is the true remaining work — measured, not stalled.

## 6. Open conflicts parked for the OWNER (verifier: do NOT "fix" these silently)

1. **Guest-link shape conflict** (blocks sign-e2e at 12/17): §24's E2E driver
   expects app-generated guest links in the OLD server-internal form
   (`${pubBase}/w/<user>/...`), while the accepted §26 boundary gives apps ONLY
   the canonical `https://<label>.puter.work` alias — which a real
   out-of-system guest could never resolve locally. Needs a product decision:
   keep §23-style link fields via a serve-time guest base, or canonical links +
   an alias-route on the public listener. No test was changed for it.
2. **§29 peer relay** — 3 acceptance questions: (a) default connectivity
   policy candidates (LAN/Tailscale hosts), (b) in-memory invite/session
   lifetime, (c) whether self-hosted coturn belongs in the FIRST release.
3. **50 archived folders** live at `D:\Stream\_app-folder-archive\` (move, not
   delete, per owner order). Nothing references them.

## 7. Standing protected rules (verifier should hold us to these)

- NO feature removal; every Puter-needed feature gets a local equivalent or a
  README "honest diffs" entry.
- NO external calls FROM APPS at runtime; server-side may use owner-configured
  services only; allowed admin/setup-time downloads are enumerated (git clone,
  npm install, Pyodide, tile packs, Ollama models).
- `upstream\` must stay clean at `0fc4d361` (clone untouched; apps adapt at
  serve time only).
- No editing test expectations to make red suites pass (declared change list in
  §3 is COMPLETE).
- No peer-relay code until §29 is approved.
- Keep `data\_dbdiag-20261022123133\` (proven lossless; owner order).
- Named rewrite rules with zero-match check; unretired rule matching zero times
  FAILS the build and names the rule.
- Workers run forked with `--permission`, env allow-list, blocked network
  (3 layers + Windows firewall on node-worker.exe — the real control),
  alloc cap, wall-clock/memory limits, warm pool; public member workers stay
  OFF until the firewall step runs on the real server.

## 8. What in this report is ASSUMED (not freshly run today)

- Upstream adapter pass counts (370 signatures / 749 invoicing cases inside the
  root suite) — their evidence JSONs in `data\hub\test-gates\` carry today's
  timestamps; the root suite result (377/377) includes them.
- The CAD dist currently on disk (`cad\app\dist\`) corresponds to the last
  successful app build (S4 verified its presence/serving; not rebuilt today).
- Restored craft rules apply at serve time only — disk dist stays unpatched
  (grep of raw slices still matches, by design).

— End of report. Working agent: GLM-5.3 (opencode), 2026-10-22.
