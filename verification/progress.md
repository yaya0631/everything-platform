# Verification progress — independent adversarial audit

Started: 2026-10-25. Verifier: independent (did not build this system).
Server under test: node server.js (PID 19320) at http://127.0.0.1:8080 (private) + :8081 (public).

## Inputs (discovered; placeholders were unfilled)
- PORTED_PATH: D:\Stream\everything (platform/ = server, upstream/ = forked app tree, platform/data = runtime)
- HOMESERVER_URL: http://127.0.0.1:8080 / :8081 (started by verifier; NOT running at audit start)
- UPSTREAM_REF: HeyPuter/everything @ 0fc4d361 (pristine base present in upstream/ clone history)
- OUTPUT_DIR: D:\Stream\everything\verification
- Local AI backend: NONE enabled. DB: OpenRouter + Google keys set; ALL ai.models are openrouter:* cloud models; hubAiDefaultModel=openrouter:deepseek/...; ollama.enabled=false; nothing on 127.0.0.1:11434.

## Phase 0 — Inventory (DONE)
- Upstream pristine: 50 apps + src/assets (empty scaffold) = 51 dirs.
- Port hub: 51 installed (assets = AssetDesk, fleshed out by builder — not upstream).
- upstream/ clone is NOT pristine: fork commits replace src/cad entirely, patch documents/help-desk license tools, add AssetDesk; 5 dirty files in worktree (documents/photo-studio/spreadsheet workers, pdf notices, teamchat sw.js).
- Upstream census (evidence/static-dep-audit.md + agent census in REPORT): 17 apps use puter.ai (chat; txt2img: documents/photo-studio/vector-studio/video-studio; txt2speech: documents/audio-studio/video-studio; img2txt: contracts/expense; speech2txt+txt2vid: video-studio; chatWithTools: photo-studio). 9 apps use puter.peer (chess/checkers/backgammon/meetings/teamchat-huddles/photo-studio/spreadsheet/vector-studio/whiteboard). 18 use puter.workers, 5 hosting, several events. 9 apps embed plausible.io analytics; 3d pulls Pyodide from jsdelivr at runtime; fleet calls NHTSA APIs.

## Phase 1 — Static audit (DONE; evidence/static-dep-audit.md, shim-antiaudit.md)
- Serve-time rewrite swaps js.puter.com→local shim, strips external scripts, CSP blocks external connects. 0 remote fonts/wasm/models. No secrets in source (keys live in DB).
- Shim: ai.chat FULL (cloud-backed here); txt2img/img2txt/txt2speech/speech2txt/txt2vid = STUBS (501 engine_missing; "install engine" promise has no code). puter.peer/events/usr/apps MISSING. perms.request auto-grants Documents write without consent. kv.set stores objects (returns object, not string). README "named error for peer" claim is false (apps get TypeError).

## Phase 2 — Network isolation (DONE core)
- 51/51 apps load in real Chrome with ZERO external requests (evidence/load-pass/*). CSP-blocked attempts: none observed at load.
- Server-side egress during AI: PID 19320 → 104.18.2.115:443 (= openrouter.ai A-record) held for entire 53s stream. PROOF of cloud AI dependency. (evidence: netstat captures + ai_usage rows provider=openrouter.)
- Offline-simulation pass (dead proxy): running → evidence/offline-pass-summary.txt.

## Phase 4 — AI (core done, app-level agents running)
- ai.chat works: PONG 1.7s; gpt-4o alias→default model; streams 5k tokens/55s. All via OpenRouter cloud.
- ai_usage totals: 225 calls — openrouter 140, test 53 (CAD_TEST only), groq 11, google 9, glm 3, kimi 4, ollama 2. Cloud-first reality.
- Upstream Puter baseline capture: running (harness/puter-baseline.mjs).

## Phase 6 — Security probe (API-level pass done; evidence/harness output in transcript)
- No-auth API → 401. Path traversal blocked (parent_ref/backslash/grant 403). Cross-user kv isolated (null). Admin APIs gated (403 admins_only). Cookie: HttpOnly, SameSite=Strict, no Secure (HTTP LAN — note). CORS: no reflection. Public listener :8081 serves no hub/API (404).
- SECURITY FINDING: many leftover tool/test accounts on the REAL db are ADMINs (functional-gate, e2eprobe, appsmoke, dbg, hprobe, p1, probe-local, signe2e, teamchat-functional, yaya3500...) — weak-credential admin surface.

## Confirmed findings so far
- F1 CRITICAL: AI runs on cloud (OpenRouter; Google key also configured). Zero local inference. Violates "local models only" requirement. Evidence: config rows, netstat→openrouter IP, ai_usage.
- F2 MAJOR: email app dead on load — shim lacks puter.auth.whoami (TypeError). evidence/probe/email-probe.log + screenshot.
- F3 MAJOR: cap-table dead on load — CorruptDataError; kv.add stores [[obj]] instead of [obj] (append contract), poisoning user state permanently. evidence/probe/cap-table-probe.log, harness/captable-trace.mjs output.
- F4 MAJOR: ALL non-chat AI features are stubs (txt2img/tts/stt/txt2vid/OCR) across documents, photo-studio, video-studio, audio-studio, vector-studio, contracts, expense → 501 engine_missing; "install engine" UI promise is fiction.
- F5 MAJOR (pending runtime confirm): puter.peer missing → chess/checkers/backgammon online, meetings, teamchat huddles, photo-studio/spreadsheet/vector-studio/whiteboard peer collab expected broken; puter.events missing → realtime updates degraded (email watch, teamchat, calendar).
- F6 MINOR: 3d Python scripting needs Pyodide from jsdelivr (CSP-blocked offline) → broken offline.
- F7 NOTE: fleet VIN/recalls use NHTSA (external) — broken offline; inherent-ish but upstream feature lost offline.
- F8 MINOR: PWA manifests 401 for signed-in users (install-ability broken).
- F9 NOTE: upstream clone dirtied + forked (cad replaced, license tools patched) — violates own "pristine upstream" invariant; rebuilds may abort.

## Per-app coverage
(appended as agents report; load-pass = all 51 loaded, 0 external reqs, 0 pageerrors)

## In flight
- Wave1 agents: F2 (collab/online; ftester2/3) RUNNING (~100min, pinged for status), F4 (business CRUD; ftester5/6) RUNNING (pinged). F1 (documents suite) + F3 (AI-heavy) FAILED to launch (concurrency limit 2) — RELAUNCH when slots free.
- Platform suite independently rerun: 649/649 PASS, exit 0 (evidence/platform-tests-full.log) — their infra tests are real and green; gap is coverage, not faked tests.
- Robustness (isolated CAD_DATA_DIR instance @:8090, since stopped): kill -9 → restart: kv/session intact; 30/30 concurrent kv ops OK; mid-AI-stream kill → raw fetch failed (m2). Clean-install boot: works, but fresh data dir has ZERO hub apps until a separate build-hub run (README quickstart only builds cad).
- Puter baseline: NOT capturable anonymously (ai.chat hangs awaiting sign-in; no Puter account available) → N3.
- CAD flagship: ribbon + draw + rectangle tool OK; AI assistant via View→Palettes→Assistant: "Draw a rectangle from 0,0 to 200,100" → tool-call edit confirmed in ~9s (cloud-backed). evidence/cad/*.png + assistant.log.
- Hub chrome captured: launcher (relabeled app names), sign-in page, panel-as-nonadmin (account page only). evidence/spot/*.png.
- Fork license patches = benign CRLF portability (checks still fail closed); uncommitted delta = 1 real file (teamchat sw.js +4, legit API-cache skip; baked into installed app) + CRLF phantoms → M9 softened to MINOR.
- M10 added: "works 51/51 / AI parity in every app" rests on infra probe + canned-AI echo (functional-gate.mjs: CAD_TEST=1, test:test-model; asserts load+kv+fs+echo+restart only).

## Session updates (02:30)
- AI sweep (13 apps, in-page, real providers): chat 13/13 OK (0.7-1.9s PONG); txt2img 0/13, tts 0/13, ocr 0/13 — exact engine_missing strings captured (evidence/ai-sweep/).
- README honesty-table inaccuracies found: promises "named not-yet error" for peer (reality: raw TypeError) and an Admin→Hub engines switch (no code exists).
- Tail probe: contacts + calendar create/persist PASS; records/expense/contracts entry points not found by generic probe (U, screenshots); sudoku loads.
- Docs-suite probe: spreadsheet DOM-grid (formula U), documents autosave (reopen inconclusive), presentation (U), pdf toolbar rich (P load).
- F4 interim: invoicing ALL-PASS incl. honest 401/503 email+hosting failures; POS product+sale+receipt PASS; crm/inventory in progress. No app-side CRUD failures so far.
- F2 interim: chess/checkers/backgammon local PASS; online + meetings START = raw TypeError (M4 confirmed); teamchat workspace creation HANGS at "Starting your workspace server…" though the worker row IS created (hub_workers row exists) — UX/health-check hang, MAJOR candidate; whiteboard + solitaire remain.
- Launcher labels verified as upstream package names (bookkeeping/puter-mail) — NOT builder renames; report corrected.

## Session updates (03:10)
- F2 FINAL: chess/checkers/backgammon local PASS + online raw-TypeError FAIL; meetings 2-client FAIL (peer); teamchat wholly unusable (worker 401s); whiteboard draw/save/reopen PASS + AI panel PASS (~10s) + Share FAIL (root-absolute /worker/whiteboard-worker.js 404 — M12) + embeds CSP-blocked (m4); solitaire PASS incl. cross-profile cloud restore; meetings calendar sidebar dead (m5).
- M11 ESCALATED TO CRITICAL: worker-runtime ctx.user lacks .puter; upstream -team-worker family (legal/childcare/fleet/field-service/property-management) + help-desk share identify(user.puter) template → 401 for every signed-in caller (static blast-radius confirmed; teamchat runtime-confirmed). Platform-packaged workers (invoicing/signatures email) unaffected (ctx.user||ctx.requestor).
- F1 (documents suite) agent launched (agent 517d…). F4 still running (projects done; wiki/help-desk/survey/accounting/time-tracking + isolation remain).

## Final (04:20)
- F4 agent died on provider errors after testing (results consolidated by verifier into evidence/f4/REPORT.md): invoicing/pos/crm/inventory/tasks/projects/wiki/survey/accounting core CRUD all PASS (create/persist/edit); delete-verify ambiguity in 4 apps (N6); time-tracking + isolation deep-tests not run (platform isolation proven separately).
- F1 agent went unresponsive; consolidated into evidence/f1/REPORT.md: documents .docx export PASS; pdf annotate+export PASS but "Save to Puter" re-save FAILS (M13: dedupeName-on-existing → TypeError hub-fsops.js:303 → 500; independently reproduced + root-caused); spreadsheet save writes file but app open-list misses it (m6); presentation save-a-copy → reload lands on untitled (m6).
- Final findings: 2 CRITICAL, 11 MAJOR, 7 MINOR, 5 NOTE (25 total). Verdict: FAIL.

## Correction (post-final): F1 agent completed after ~4h
- Its finished runs DISPROVE my earlier partial-log consolidation for the office suite: spreadsheet (=SUM renders, autosave, reopen, .xlsx export), documents (type/autosave/save-as/reopen/.docx export), presentation (slide+textbox+save+reopen) ALL PASS. m6 RETRACTED; matrix corrected.
- M13 strengthened: independently reproduced for pdf+spreadsheet+documents; platform tests only cover dedupe-on-mkdir, never file-save dedupe.
- M3 supplemented: documents silently HIDES "Generate with AI…" when txt2img is absent (no error dialog); Read Aloud degrades to browser speechSynthesis (partial).
- Final counts: 2 CRITICAL, 11 MAJOR, 6 MINOR, 5 NOTE (24 findings). Verdict unchanged: FAIL.

## W4 close (2026-10-26/27)
- W4 commit: `2c72120`.
- All 24 findings closed/accepted; `findings.json` now reports `open: 0`, and the original independent FAIL report is preserved as `REPORT-2026-10-25.md`.
- W1-W3 fixes retained; W4 added lint, one verify runner, CI, hosting checklist, isolated app gate/smoke, and the fresh-host acceptance.
- Fresh host: 12/12. Suite: 682/682. Lint: 0 errors. Hub HTTP: 37/37. Engines: 9/9. Pyodide: 8/8. Peer: 18/18. Chess: 8/8.
- 51/51 installed apps render clean (0 external, 0 CSP, 0 uncaught, 0 unexpected 4xx/5xx); 51/51 infrastructure gate; persist 10/10.
- W4 found/fixed a real 3d root-absolute CSS/JS font 404, plus test-harness data-path bugs in `functional-gate`, `build-hub` and `browser-smoke`.
- App status: **3 works, 48 boots, 0 untested, 0 does not** (works: calendar, invoicing, signatures). `boots` is the honest gate ceiling; app-specific limits remain documented.
- Final re-verification is [`REPORT.md`](REPORT.md); no open findings. Owner must re-enter a cloud key or switch the Hub default to `ollama:llama3.2:3b`; no model is bundled.
