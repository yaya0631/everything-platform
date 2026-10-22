# AGENTS.md - cad-home hub: global view and handoff

Read this whole file first. It is the handoff from the previous agent (GLM 5.3, opencode).
Its last session stopped on a provider quota error, in the middle of a test. You take over from there.

Facts below come from the previous agent's own reports and from reviews. Treat them as claims
to confirm by running things, not as proof. Section 9 says what to run first.

## 1. The mission (do not lose this)

The owner runs a personal home server (an old Windows PC, reached through Tailscale). The first goal
was done for one app: `cad` was turned into `cad-home`, a Node server that provides every cloud
service the app used (accounts, file Drive, sharing, live co-editing, AI assistant, email, serverless
functions) with no Puter and no outside cloud.

The major goal now: do exactly the same for ALL the remaining apps of
https://github.com/HeyPuter/everything (51 folders in `src/`), so the home server becomes a
workstation for all the owner's local apps, with no external cloud, no external API calls and no Puter.

## 2. Hard requirements (not negotiable)

1. NO FEATURE REMOVED. Every feature that needs Puter must be re-implemented locally. "Unsupported" is
   not an acceptable end state. If something cannot be identical, give a local equivalent and write the
   difference (reason + how to enable the local equivalent) in the README "honest diffs" list.
2. NO EXTERNAL CALLS AT RUNTIME. Nothing may contact js.puter.com, api.puter.com, *.puter.site,
   *.puter.work, puter.com, CDNs, font hosts, analytics (plausible.io is in 8 apps: strip it), map
   tiles, model downloads. Strict CSP plus an external-URL scan plus an offline run prove it. Allowed:
   things the owner configures (own AI keys, own SMTP) and setup-time downloads run by the owner as an
   admin command (git clone, npm install, Pyodide, tile packs, Ollama models).
3. Apps stay identical to upstream so `git pull` keeps working. Adapt only at serve time (script-tag
   swap, URL rewrite rules, shim). Never edit files under `upstream/`. Keep `git status` clean there.
4. Architecture stays: Node only, minimal dependencies, no new native modules, SQLite, per-user
   accounts, the two-listener security model (private listener behind `tailscale serve`, public
   listener behind funnel), runs on an old PC. Everything must work on Windows.
5. Optional helper programs (ffmpeg, whisper.cpp, Piper, tesseract, coturn) are allowed only as
   admin-installed "engines" that are detected at runtime. The core never requires them, and the app
   shows what to install to enable the feature.
6. Puter's backend (upstream `puter-main/src/backend`) is AGPL-3.0: never copy it. The Puter JS SDK
   (`src/puter-js`, Apache-2.0) may be used as the exact reference for method names and return shapes.

## 3. Layout

Workspace: `D:\Stream\everything\`
- `cad-home\` - the server (this is where you work).
- `upstream\` - fresh clone of HeyPuter/everything (`upstream\src\<app>`). Read-only for you, except
  that `npm ci` / `npm install` and `vite build` inside `upstream\src\<app>` are allowed (try
  `--ignore-scripts` first, report any fallback). Almost every app imports `../../dev`, so never
  flatten this layout.

Key files in `cad-home\` (names as reported; confirm they exist):
- `plans\cad-home-cloud.md` - the original approved plan for CAD (steps 1-8).
- `docs\phase3-workers-design.md` - the workers design and the status board (sections numbered 1-24).
- `README.md` - setup, honest diffs, per-app table.
- `build-hub.mjs` - CLI: `scan`, `build-all` (supports `--resume`), `build-one --only a,b` (off-tier
  builds), `rules` (rewrite-rule hit counts), `status [--json]` (ground truth for all 51 apps).
- `server.js`, `lib\hub.js` (mounts, shim prelude, `/h/<app>/` serving), `lib\hub-build.js`,
  `lib\hub-rewrite.js` (named serve-time rewrite rules, zero-match check), `lib\shim\puter.js` (the
  `window.puter` replacement), `lib\hub-data.js` (fs/kv/ai/grants API), `lib\hub-fsops.js`,
  `lib\hub-fsauth.js`, `lib\drive.js`, `lib\ai.js`, `lib\jsonread.js` (BOM-tolerant JSON reads).
- Workers: `lib\hub-workers.js`, `lib\hub-workers-http.js`, `lib\hub-workers-run.js`,
  `lib\worker-runner.js`, plus the older `lib\functions.js` / `lib\fn-runner.js` (CAD functions).
- Tests: `test\*.test.js` (node:test, root suite), `app\tests` (vitest, the CAD app),
  `test\vitest-shim\` (lets upstream's own vitest files run unmodified), `browser-smoke.mjs`
  (puppeteer-core with system Chrome, results in `browser-smoke-results*.json`),
  `check-firewall.mjs`, `sign-e2e.mjs` (the unfinished signatures E2E).
- Data: `data\hub\apps\<app>\` (built dist), `data\hub\build-state.json`, `data\files\<user>\`
  (Drive), `data\hub-users\<user>\<app>\` (per-app data). Never ship `data\` (it holds accounts).

## 4. Architecture in one page

- One generic `window.puter` shim replaces the SDK. The server swaps the
  `<script src="https://js.puter.com/v2/">` tag at serve time (4 apps - chess, checkers, backgammon,
  3d - load the SDK dynamically at runtime; those URLs are rewritten too). Apps are served
  same-origin at `/h/<app>/` (decision: stay single-origin; measured, zero apps needed per-app origins).
- fs: relative paths go to the app's own folder; `~`, `/`, `/<own username>/` go to the Drive.
  `..`, drive letters, backslashes, reserved Windows names are rejected. Another person's username
  is rejected (`other_person`). Real-path containment (junction/symlink escape) is enforced.
- Grants: Drive access needs a grant (exact file for open/save, subtree for directory picks),
  persisted until revoked, never crossing app or person. A consent overlay (closed shadow root,
  `isTrusted` clicks only) asks on a grant-less write. Account page lists and revokes grants and has
  "Export my hub app data". App data counts in the quota and backups.
- kv: all SDK kv routes, TTL and size caps. ai.chat: `lib\ai.js` with admin-configured providers and
  model aliases; local-first.
- Workers (the emulation of `puter.workers.create/exec/delete`): Cloudflare-style `router` +
  `Request/Response` contract, `me` context, run in forked Node children with `--permission`, an
  env allow-list, blocked network (three tested layers; best-effort, the real control is a Windows
  firewall rule on a copy of node.exe, verified by `check-firewall.mjs`), a size cap on Buffer
  allocations (`CAD_WORKER_ALLOC_CAP`), wall-clock and memory limits, a warm pool with a RAM budget.
  URL shapes: packaged system workers `/wr/app/<app>/<name>/` (built from an app's dist `workers/`
  folder, admin-owned, change of source resets approval), member workers `/wr/<user>/<name>/`
  (private), public guest links `/w/<user>/<name>/` (public listener: no cookies, no shim, rate
  limited, 1 MiB body). Unknown `*.puter.work` hosts return a named `external_not_allowed` 403.
  Public member-deployed workers stay OFF (`workers.allow_public_user_workers`) until the firewall
  step is executed on the real server.
- Rewrite rules are named, counted, and a build FAILS naming the rule when an unretired rule matches
  zero times (upstream changed). Keep it that way.

## 5. Status - rebuilt from the real state (2026-10-22, this agent's Step 0)

### Folder question (answered)
- `D:\Stream\everything\` is the ONLY code tree. `D:\Stream\everything - Copie\` is EMPTY
  (contains 0 files; there is nothing to merge and nothing to delete - leave it alone).
- `docs\review-report-2026-10-21.md` claims that workspace was
  `D:\Stream\everything - Copie\cad-home`, but every artifact it lists (`lib\hub-hosting.js`,
  `test\hub-hosting.test.js`, `invoicing-e2e.mjs`, docs sections 25-29, `data\hub\test-gates\`
  evidence) is present in the main tree, so that work landed in `D:\Stream\everything\` and a
  copy of it never existed separately.

### Gates (measured 2026-10-22)
- Root suite `npm test` (node --test, test\*.test.js): **364 tests, 360 pass, 4 FAIL**. All four
  are worker-URL-shape assertions: `test\hub-workers.test.js:145` (registry: list/get/audit and
  the url shape) and `test\signatures-productization.test.js:80, 86, 222` (shape rules keep the
  relative `/wr/<user>/<name>/`/URL while no public base is set). Cause: the worker-url-alias
  round made `lib\hub-workers.js` (line ~172) return `https://<host_label>.puter.work`
  unconditionally, while these tests expect the relative wr-URL when no public base is set. One
  of the two must win - decide against the 4.1 mapper design, then make the suite green again.
- App suite `npm --prefix app test` (vitest): **482/482 in 31 files, PASS.**
- `node build-hub.mjs status`: full table saved in `data\_step0-status.txt`. Headline:
  works 1/51 (accounting, via the easy-tier functional gate). signatures: server tests 0/172
  (upstream-only 370/370 PASS), invoicing: 0/96 (upstream-only 749/749 PASS, E2E 11/11).
  Most easy-tier apps sit at "func-pending" - the functional-gate evidence file exists only
  for accounting (`accounting-functional.json`). cad shows "built no / installed no" because
  cad is served at root by `server.js`, not as a hub-installed app (verify the row's wording).
- `upstream\` git status: **clean**, HEAD `0fc4d361`. Node v24.21.0.

### Platform incident handled (2026-10-22)
- `data\cad.db` failed to open with "database disk image is malformed" (blocked
  `build-hub.mjs status` entirely). The WAL sidecar was corrupted by the previous session's
  quota-stop kill; the main db file itself was intact (integrity ok, 53 objects, every table
  present). Full byte backup of cad.db, cad.db-wal, cad.db-shm kept in
  `data\_dbdiag-20261022123133\`. After that the WAL/shm were dropped, the db re-primed in
  WAL mode, and integrity re-verified (users 5, hub_workers 3, hub_kv 5). Anything committed
  only into the corrupt WAL is lost; the backup dir keeps the original bytes.

### HANDOFF section 4 - which corrections already landed (verified 2026-10-22)
Already in the repo (do not redo):
- **4.1a mechanism**: the general worker-URL mapper exists - `lib\shim\worker-url-map.js`, the
  `/w/host/<label>/` route in `lib\hub-workers-http.js`, `canonicalHostLabel` in
  `lib\hub-workers.js`, test at `test\worker-url-map.test.js`; design doc section 26 written.
- **4.2 gate honesty**: design doc section 25 amended (runtime coverage 0/172 and 0/96
  classified; verdicts say "does not" until 100%); `build-hub.mjs status` prints that.
  Signatures' email-worker adapter EXISTS: `test\signatures-upstream.test.js` imports upstream
  `sign-worker.test.js` AND `email-worker.test.js` (the handoff's "not adapted" claim was
  outdated). But their runtime-server half is the 0/172 part that stays open.
- **4.3 easy-tier functional gate**: implemented in `build-hub.mjs` (`<app>-functional.json`
  evidence, `functional_gate` in status output). DONE for accounting only; the func-pending
  easy-tier wave is unmeasured until each app gets its evidence file.
- **4.4 peer relay**: design doc section 29 is already the corrected WebRTC design (real
  RTCWeb, reuse the Apache-2.0 client, signalling on our WebSocket, invite codes, no external
  STUN/TURN, optional self-hosted TURN). Awaiting owner review; no peer code was written.
- **4.5b**: cad-home-cloud.md noted as not required (5.8 of handoff is fine without it).

Still NOT in (to do, in order):
- **4.1 honest rewrite-census**: section 28's table counts rules ADDED, not rules NEEDED.
  Needs a real grep census with file:line evidence per remaining worker app; which apps
  validate the worker address in their own code (patch required); which can unmapped-by-shim.
- **4.5 hosting verify consumers**: section 27 written; the per-app published-page analysis
  (hiring, shifts, contracts, documents publish, whiteboard, vector-studio) still missing.
- The 4 red root-suite tests above (first fix of section 6 work).

### Not started (unchanged from the earlier report)
peer relay code, AI engines (txt2img, TTS, STT, OCR, video), hosting/site, net, drivers, events,
perms, launchApp, the email app, maps, VIN, Pyodide bundle, whiteboard/documents workers. About 22
worker-tier apps are not productized (calendar, childcare, contracts, documents, email,
field-service, fleet, help-desk, hiring, invoicing, legal, photo-studio, property-management,
shifts, signatures, spreadsheet, teamchat, vector-studio, video-studio, whiteboard, wiki, plus
meetings and the collaboration/peer work). `assets` has no `src/` upstream.
`node build-hub.mjs status` is the source of truth, not this list.


Not started: peer relay, AI engines (txt2img, TTS, STT, OCR, video), hosting/site, net, drivers,
events, perms, launchApp, the email app, maps, VIN, Pyodide bundle, whiteboard/documents workers.
About 22 worker-tier apps are not productized: calendar, childcare, contracts, documents, email,
field-service, fleet, help-desk, hiring, invoicing, legal, photo-studio, property-management, shifts,
signatures, spreadsheet, teamchat, vector-studio, video-studio, whiteboard, wiki, plus meetings,
vector/video/photo collaboration and the games' online play (peer). `assets` has no `src/` upstream.
`node build-hub.mjs status` is the source of truth, not this list.

## 6. Authoritative decisions and honest diffs

- Pyodide (3d Python): downloaded once at install, served locally.
- WASM/CDN libs (tesseract workers, mediapipe, pathkit, mediabunny): bundle and serve locally; prove
  with CSP and the external-URL scan.
- Maps (field-service, fleet, property-management): local tile pack (PMTiles from an OpenStreetMap
  extract, region chosen by the owner, downloaded once at setup), served by this server.
- VIN decode (fleet): bundled offline decoder (WMI table, check digit, model year); optional
  admin opt-in proxy for the full NHTSA data.
- Whiteboard public embeds (YouTube, Figma...): third party by nature; load only when the admin
  enables "external embeds", otherwise show the card with a clear note.
- txt2vid (video-studio): keep the feature behind a pluggable provider (owner's own endpoint or
  key); if none is configured show a clear message. An ffmpeg slideshow may be a labelled lite mode.
- AI chat/images/speech/OCR: local-first (Ollama, local engines); external providers only if the
  owner configures them.
- Peer (chess, checkers, backgammon, meetings, teamchat huddles, collaboration in spreadsheet,
  photo-studio, vector-studio, whiteboard): signalling over our WebSocket server with invite codes
  and guest grants; ICE must work with NO external STUN/TURN (LAN and Tailscale addresses connect
  directly); optional self-hosted TURN (coturn or built-in relay) documented in the README.
- Email: send-only through the owner's SMTP; inbound mail is out of scope.
- Workers are private-only by default; public routes only for chosen routes, identity only via URL
  capability tokens.
- Every remaining difference is listed in the README with reason and workaround.

## 7. Test gate per app (do not flip an app to "works" without it)

- Apps with upstream tests run those tests unmodified through `test\vitest-shim` (whiteboard 102,
  teamchat 90, calendar 51 incl. the rsvp worker, signatures 40, survey 11, spreadsheet 8, ...).
- Apps with zero upstream tests (childcare, documents, help-desk, photo-studio): every `puter.*`
  call site in their own source becomes an HTTP test before the tier flips. Documents also gets a
  two-browser co-edit smoke.
- Every app: Chromium smoke with 0 external requests, 0 CSP violations, 0 uncaught errors.
- Order planned: signatures, then invoicing, then the peer relay (chess, checkers, backgammon first,
  then meetings and collaboration), then the other worker apps alphabetically, documents last,
  calendar/email on SMTP.

## 8. Working rules

- Reports always split DONE and PENDING, with proof for every claim (test output, what was run).
  Never say "done" or "works" without running it. Include `node build-hub.mjs status` and exact
  suite counts in every report.
- Windows PowerShell 5: no `&&` / `||`; a regex with unbalanced parentheses breaks inline commands, so
  put non-trivial logic in `.mjs` files. `Set-Content -Encoding utf8` writes a BOM; use the BOM-tolerant
  readers and avoid BOMs in JSON. Edit files with proper edit tools, not shell redirection.
- No stray non-ASCII text in authored `.md` / `.js` (a repo test, `test\repo-ascii.test.js`, fails on
  CJK; an earlier agent leaked some into docs).
- In tests, never use undici `fetch` for bursts (keep-alive sockets pin the process); use one-shot
  `node:http` requests with `agent:false`. `config.set` persists: restore knobs after control runs.
- Time-box test-harness work: if a UI-automation step fails 3 times, stop, report the exact blocker
  and continue with the next item. Do not burn the budget on harness fiddling.
- Keep README and `docs\phase3-workers-design.md` in sync with the code in the same change.
- Security stance: workers of members stay private-only on a shared PC; in-process limits are
  best-effort and documented as such. Do not weaken the two-listener model or the CSP.
- The owner uses an independent second model to verify big rounds. Expect that, and keep evidence
  tools (probe scripts) in the repo.

## 9. First steps for you

1. Read `plans\cad-home-cloud.md`, `README.md`, `docs\phase3-workers-design.md`.
2. Run both suites (root `npm test`, app `npm test` in `app\`) and report exact counts. Run
   `node build-hub.mjs status` and `git status` inside `upstream\` (must be clean).
3. Find out which signatures productization items actually landed (list in section 5), each with a
   test. Rebuild with `node build-hub.mjs build-one --only signatures` and confirm the packaged
   `signatures-email` row is created.
4. Finish the §24 signatures E2E, but do NOT drive the editor canvas by drag and click. Seed the
   document so it already has the signer and the signature field (write the same record the app
   saves), then drive the real parts in the browser: owner app -> Send (`workers.create` through the
   consent overlay, assert Allow and Deny) -> take the link from the record -> open it in a fresh
   cookie-less context on the PUBLIC listener -> sign -> check the worker KV and the owner's
   completed view.
5. Run signatures' upstream tests through the vitest shim (§15 adapter), then productize invoicing.
6. Write the peer-relay design (short) and send it for review BEFORE writing peer code.
7. Count how many serve-time rewrite rules each remaining worker app would need. Prefer a
   shim-level URL mapping to patching minified chunks wherever the app does not validate the URL
   itself, and say which apps need patching.
8. Report DONE/PENDING with proof, then continue down the order in section 7.
