# Final verification status - "Everything" self-hosted port

**Date:** 2026-10-27
**Original independent audit:** 2026-10-25, preserved verbatim in
[`REPORT-2026-10-25.md`](REPORT-2026-10-25.md). That audit's verdict was
**FAIL**.
**This document:** builder re-verification after the W1-W4 remediation, not a
second independent audit. Every number below comes from a command that was
re-run against this tree.
**Scope:** `platform/` (Node server on 8080/8081), `platform/data` (runtime),
and the clean sibling `upstream/` fork at `e750f374`.

---

## VERDICT: **PASS** within the owner-approved scope

There are **no open findings**: all 24 audit findings are closed or explicitly
accepted, and the W4 gate/smoke passes. The qualification is deliberate:

- The original requirement was zero cloud dependency, including local AI.
  The owner approved a different deployment scope: **Ollama is wired and
  enabled, but no model is downloaded by this repository; OpenRouter remains
  the default until the owner re-enters a cloud key or selects an Ollama
  model.** Local OCR and Piper speech are real. Image generation is
  cloud-only, and `txt2vid`/`speech2txt` are named 501s.
- "PASS" means the platform is safe and complete for the approved LAN hosting
  scope. It does not claim that every upstream app feature is exercised; the
  per-app gate proves boot/shim/storage, and the vocabulary is kept honest
  (`works` / `boots` / `untested` / `does not`).

## What changed

- **W1 (defects):** email `whoami`, cap-table `kv.add`, OCR/TTS/image stubs,
  peer/events absence, consent, manifest/asset gates, AI stream errors, worker
  identity, whiteboard worker paths, delete/save behavior, and the live
  production DB cleanup.
- **W2 (peer/events):** LAN peer relay with direct WebRTC media, invite grants,
  same-user KV/fs events, and real chess Online acceptance.
- **W3 (engines/offline):** pinned local Tesseract OCR and Piper speech,
  vendored Pyodide 314.0.7 for 3d, opt-in NHTSA proxy with an offline message,
  cloud-only image generation, and explicit 501s for unsupported engines.
- **W4 (ops):** lint gate, self-hosted CI workflow, one `verify-all` runner,
  fresh-host acceptance, hosting checklist, isolated app smoke/gate, and this
  re-verification.

Commits: W1 `bb69fb7` through `b2080e2`; W2 `a33f6be`, `090fad8`, `ba2a353`;
W3 `ca61606`; W4 commit recorded in `platform/docs/AI-PROGRESS.md` Session 12.

## Finding closure (24/24)

| ID | Severity | Closure and evidence |
|---|---|---|
| C1 | CRITICAL | **Owner-approved scope.** Ollama enabled and proven with a real `llama3.2:3b` stream; no model bundled. Local OCR/Piper added. Cloud OpenRouter remains the documented default until the owner configures a key or switches the Hub default to Ollama. |
| M1 | MAJOR | `puter.auth.whoami` implemented; email boots and reaches its request-access state instead of `whoami is not a function`. |
| M2 | MAJOR | `kv.add` array-append contract fixed; cap-table boots and persistence passes. |
| M3 | MAJOR | Local OCR and Piper speech are real; image generation is the documented cloud-only opt-in; `speech2txt`/`txt2vid` return explicit 501s, never fake output. |
| M4 | MAJOR | `puter.peer` implemented; peer-e2e **18/18**, chess Online **8/8**. |
| M5 | MAJOR | `puter.events` implemented for same-user KV/fs; peer-e2e proves delivery and isolation. |
| M6 | MAJOR | Pyodide 314.0.7 vendored and served from authenticated `/hub/pyodide/`; pyodide-e2e **8/8**, no external runtime request. |
| M7 | MAJOR | Live DB cleanup removed the disabled tool admin and cleared stored cloud keys; only the two owner accounts remain. Backup: `platform/data/backups/cad-before-cleanup-2026-10-26T11-08-51-071Z.db`; audit `admin.live_cleanup`. |
| M8 | MAJOR | Folder access now uses the shim consent overlay; grants carry source `consent` and audit `hub.perms_granted`. |
| M9 | MINOR | `upstream/` is clean at `e750f374` on `main`; fork commits are documented in the README rather than hidden in an installed app. |
| M10 | MAJOR | The generic gate is labelled infrastructure-only (`ai=echo`, no feature proof); status vocabulary is `works` / `boots` / `untested` / `does not`. W4 re-ran it on an isolated data copy. |
| M11 | CRITICAL | Worker runtime supplies `user.puter`; worker identity contract tests pass across the affected family. |
| M12 | MAJOR | Whiteboard root-absolute worker fetches are rewritten to `/h/whiteboard/`; browser smoke has no failed worker request. |
| m1 | MINOR | PWA manifests/icons move to session-free `/hub/app-manifest/` and `/hub/app-asset/`; `/h/` remains gated. |
| m2 | MINOR | Interrupted AI streams are wrapped as an `Error` with `code: 'ai_stream_interrupted'`; duplicate-final-chunk behavior is deliberately unchanged and documented. |
| m3 | MINOR | No code change: `Secure` needs TLS and is enabled when the host configures a certificate; README documents the HTTP-LAN limitation. |
| m4 | MINOR | External embeds are closed by default and open only through the Admin toggle; CSP `frame-src` is allowlisted. |
| m5 | MINOR | `ui.launchApp` opens a hidden same-origin iframe and relays `postMessage`, restoring the meetings calendar sidebar path; picture-in-picture remains a named gap. |
| N1 | NOTE | Fleet NHTSA calls are off by default and return a local offline message; the owner can opt in to a fixed, rate-limited same-origin proxy. No VIN is logged. |
| N2 | NOTE | `puter.hosting` remains available but disabled by default; enabling it is an explicit owner action documented in HOSTING.md. |
| N3 | NOTE | The upstream Puter AI baseline cannot be captured anonymously; this is an audit limitation, not a server defect. |
| N4 | NOTE | Restricting arbitrary external APIs is the intended zero-external-dependency boundary, documented in the shim and README. |
| N6 | NOTE | Delete verification differences match upstream trash/soft-delete semantics and were not reproducible as a port defect; accepted limitation. |

Machine-readable status: [`findings.json`](findings.json) (`closed: 24`,
`open: 0`).

## W4 verification evidence

| Check | Result | Evidence |
|---|---|---|
| Unit/integration suite | **682/682** | `npm test` |
| Lint | **0 errors** (53 visible warnings) | `npm run lint` |
| Hub HTTP smoke | **37/37** | `node smoke-hub.mjs` |
| Fresh host (empty data) | **12/12** | `node fresh-host-e2e.mjs` |
| Local engines, real OCR/Piper | **9/9** | `node engine-e2e.mjs` |
| Vendored Pyodide in 3d | **8/8** | `node pyodide-e2e.mjs` |
| Peer relay/media | **18/18** | `node peer-e2e.mjs` |
| Chess Online | **8/8** | `node chess-online-e2e.mjs` |
| Installed apps load | **51/51** | `browser-smoke-results.json` |
| Generic infrastructure gate | **51/51 PASS** | isolated `data/hub/test-gates/*-functional.json` |
| Persist pass (10 real apps) | **10/10** | `node browser-smoke.mjs persist-all` on the isolated copy; create -> reload -> server restart |
| Single host runner | **PASS** | `npm run verify:full` — 51-app smoke + gate on an isolated copy; exit 0 |

The W4 load pass also fixed one real defect found by the gate: 3d emitted
root-absolute `/assets/...` font URLs in its CSS and runtime JS, so the
requests escaped `/h/3d/` and 404ed. Both CSS and JS are now rebased at serve
time (`lib/hub-rewrite.js`), with unit and HTTP integration tests.

The gate treats email's handled `fs.stat` -> `no_permission_for_app` as its
documented request-access probe; every other rejection still fails. The app
status reads **3 works, 48 boots, 0 untested, 0 does not** — `boots` is the
honest ceiling for infrastructure evidence, not a claim that those features were
driven; the three `works` apps have real upstream feature suites and E2E.

## Residual limits (documented, no open finding)

- **AI:** no model is downloaded by the repository. Ollama must be running and
  a model pulled for fully local chat; the Hub default is still OpenRouter
  until the owner changes it. Image generation calls a cloud provider only
  when configured.
- **Media calls:** no STUN/TURN. Both peers must reach this server (LAN or a
  private overlay such as Tailscale); a hub restart ends live calls and
  in-memory grants.
- **Events:** same-user KV/fs only; no cross-person share events.
- **Engines:** Piper ships English; `speech2txt`/whisper and `txt2vid` are
  named 501s. Engine binaries live in gitignored `data/engines` and need
  `npm run engines:install` on a fresh host.
- **NHTSA:** opt-in internet egress only; otherwise the fleet app stays on its
  offline message.
- **App features:** the generic gate proves boot, the real shim, kv/fs
  round-trip and restart; it does not prove every editing/game/business flow.
  The feature evidence is limited to the app suites/E2E listed above.
- **Public hosting:** `puter.hosting` is implemented but disabled by default;
  enabling public member workers remains an owner decision.
- **Upstream:** the sibling fork must be the documented `e750f374` revision;
  the platform never edits app source at runtime.

## Reproduce

```sh
cd platform
npm ci
npm run engines:install          # one-time pinned OCR/Piper downloads
npm run lint
npm test
node fresh-host-e2e.mjs
node engine-e2e.mjs
node pyodide-e2e.mjs
node peer-e2e.mjs
node chess-online-e2e.mjs
node smoke-hub.mjs
npm run verify:full              # isolated app smoke + gate
```

`npm run verify` is the short host gate (lint, suite, engine check, HTTP smoke,
fresh host). `npm run verify:full` adds the browser checks and runs the
installed-app smoke/gate against a throwaway copy of `data/`; only gate
evidence is copied back. CI targets a self-hosted Windows runner because the
tests need the sibling `../upstream` fork and installed engines.
