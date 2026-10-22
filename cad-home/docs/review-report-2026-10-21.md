# Implementation and Gate Review Report

Date: 2026-10-21
Workspace: `D:\Stream\everything - Copie\cad-home`
Upstream checkout: `..\upstream` (left unchanged)

This report records the work completed for the handoff request, the evidence collected, current limits, and the exact output of `node build-hub.mjs status`.

## DONE

### 1. Status gates and evidence

`node build-hub.mjs status` computes each app verdict from build/install state, clean browser smoke, upstream case coverage, required E2E evidence, and required server services. The source API tier scan remains diagnostic and does not decide the verdict.

Signatures now reports `works`. Its previous `does not` result came from the static API tier classification treating `workers.*` as unsupported, even though the product gates had been completed. No signatures gate remains:

- Built and installed.
- Browser smoke: 1/1, with zero external requests, bad HTTP responses, failed requests, other errors, or CSP violations.
- Full upstream app suite: 370/370 cases in 31 files.
- Browser E2E: 27/27 checks.
- Required services: PASS.

Invoicing now reports `works`:

- Built and installed.
- Browser smoke: 1/1, with zero external requests, bad HTTP responses, failed requests, other errors, or CSP violations.
- Full upstream app suite: 749/749 cases in 25 files.
- Browser sharing E2E: 11/11 steps.
- Required services: PASS.

The browser smoke output was collected for signatures and invoicing together so both app records remained in the final shared smoke artifact.

Adapter coverage for each upstream worker adapter:

| Adapter | Covered / worker-focused upstream cases | Detail |
| --- | ---: | --- |
| calendar RSVP | 45/45 | `rsvp-worker.test.js`; case registration count is asserted. The full calendar app gates are still pending. |
| signatures | 15/172 | The adapted `sign-worker.test.js` is 15/15 and has a case registration count assertion. 172 is the broader worker-focused test inventory. The full app suite is 370/370. |
| invoicing | 96/96 | `email-worker.test.js` (59) plus `mailer.test.js` (37); adapter case count is asserted. The full app suite is 749/749. |

The signatures adapter denominator is deliberately distinct from the complete upstream app suite: 15 is the one worker test file adapted; 172 is the wider worker-focused inventory; 370 is the full app suite.

### 2. Worker `request.url` and public boundary

Worker request construction now gives the worker a route-local URL path, removing the public wrapper path. Public worker requests do not forward `Host`, `Forwarded`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Forwarded-Port`, or `X-Original-Host`. Cookies and CAD request headers are filtered at the worker boundary. The public URL origin is taken from the configured public base or a neutral origin; it does not use the private listener host. The signatures worker base is assembled only from `workers.public_base_url` and its public wrapper path.

Tests cover:

- A worker sees its own route path and query string.
- Public routes do not expose private Host/origin or proxy-host headers.
- The signatures public base uses configuration only.
- No session cookie is issued on the public worker route.

Design notes are in section 26 of `docs/phase3-workers-design.md`.

### 3. Shared static hosting

The server provides one shared `puter.hosting.create/get/list/update/delete` service. Sites are registered centrally and served from the public listener under `/site/<subdomain>/...`. The shim maps app-generated `.puter.site` URLs to the configured public listener path; no wildcard DNS or per-app host process is required.

The service enforces:

- Static files only, with an allow-list of MIME types and no directory listing.
- GET and HEAD public methods only.
- Restrictive sandbox CSP, `X-Content-Type-Options: nosniff`, and no cookies set or forwarded to public sites.
- A per-user aggregate hosted-byte quota, 100 MiB by default, checked at publish/update and on later writes under hosted roots.
- An admin-controlled hosting toggle, OFF by default.
- Audit rows for create, update, and delete.
- A per-site and client-IP limit of 120 requests per minute.

The hosting integration test checks the toggle, lifecycle APIs, static serving, security headers, method and path rejection, quota behavior including later writes, audit rows, unsharing, rate limit, and private-listener isolation. The test also restores the hosting toggle and quota.

Invoicing completed browser acceptance using the shared service: it created a hosted site, used the mapped `/site/` URL, rendered an invoice anonymously, returned the expected CSP and `nosniff` headers without cookies, and returned 404 after sharing was stopped. Hiring, shifts, contracts, documents publishing, whiteboard, and vector-studio can use the shared shim/API but still need their own app-level product flows and gates. They have not each completed browser acceptance in this session.

Design notes are in section 27 of `docs/phase3-workers-design.md`.

### 4. Per-app serve-time URL rewrite counts

The counts below are additional app-specific URL rules. `.puter.work` worker mapping and `.puter.site` hosting mapping are shim-level mappings. No peer implementation or other app-specific URL rules were added.

| Remaining worker app | Per-app URL rewrite rules |
| --- | ---: |
| calendar | 0 |
| childcare | 0 |
| email | 0 |
| field-service | 0 |
| fleet | 0 |
| help-desk | 0 |
| legal | 0 |
| meetings | 0 |
| photo-studio | 0 |
| property-management | 0 |
| spreadsheet | 0 |
| teamchat | 0 |
| video-studio | 0 |
| wiki | 0 |
| hiring | 0 |
| shifts | 0 |
| contracts | 0 |
| documents | 0 |
| whiteboard | 0 |
| vector-studio | 0 |
| invoicing | 0 |

The signatures app already has three app-specific URL/worker-response rules for its bespoke signing flow; it is gated as `works` and is not counted as a remaining app. See design doc section 28 for the complete mapping notes.

### 5. Peer-relay review proposal

No peer-relay code was written. Proposed first scope: authenticated hub clients establish a one-use invite using a random 256-bit secret; the server stores only a hash and short expiry, and clients derive an end-to-end key from the secret. The public listener forwards ciphertext frames only and does not expose peer IP addresses or open direct peer sockets. Keep relay state in memory with a short TTL, cap frames at 64 KiB, apply per-account and per-IP rate limits, support immediate revoke, and audit invite/accept/close/rate-limit events without recording secrets or payloads. Review is needed on message ordering and whether offline delivery belongs in the first version.

This proposal is recorded in section 29 of `docs/phase3-workers-design.md` for owner review before implementation.

### 6. Handoff update and verification counts

Section 5 of the attached `AGENTS.md` was updated with current gate results, next steps, and pending review items. The root test suite was run after code changes. The final smoke pass was run for signatures and invoicing together.

| Check | Result |
| --- | ---: |
| Root `npm test` | 332/332 passed |
| `node --test test/hub-hosting.test.js test/hub-guest-links.test.js` | 8/8 passed |
| Signatures full upstream app suite | 370/370 passed in 31 files |
| Signatures worker adapter | 15/172 overall worker-focused inventory; adapter file 15/15 |
| Signatures browser E2E | 27/27 passed |
| Invoicing full upstream app suite | 749/749 passed in 25 files |
| Invoicing worker adapter | 96/96 passed |
| Invoicing browser E2E | 11/11 passed |
| Calendar RSVP worker adapter | 45/45 passed |
| Final clean browser smoke | 2/2 apps passed |

The exact gate artifact files are under `data/hub/test-gates/`. Browser smoke evidence is in `browser-smoke-results.json`; invoicing E2E evidence is in `invoicing-e2e-results.json`.

## PENDING

- Peer-relay design review and agreement on ordering/offline delivery before peer code.
- Calendar and the remaining worker apps still need their own build/install, smoke, upstream coverage, and product acceptance gates as applicable.
- Hosting integration is browser-accepted end-to-end for invoicing only. The shared capability is available, but the other named apps still need their own publication/share flows verified.
- The status command reports 2/51 apps as `works`; the other app verdicts remain pending one or more gates.

## Exact `node build-hub.mjs status` output

```text
app                status     smoke   upstream       E2E        services   built   installed
------------------------------------------------------------------------------------------------------
3d                 does not   PASS    -              n/a        PASS       yes     yes
accounting         does not   PASS    -              n/a        PASS       yes     yes
api-client         does not   PENDING -              n/a        PENDING    no      no
assets             does not   PENDING -              n/a        PASS       no      no
audio-studio       does not   PASS    -              n/a        PASS       yes     yes
backgammon         does not   PASS    -              n/a        PASS       yes     yes
building-design    does not   PENDING -              n/a        PASS       no      no
cad                does not   PENDING -              n/a        PASS       no      no
calendar           does not   PENDING 45/45          n/a        PENDING    no      no
cap-table          does not   PASS    -              n/a        PASS       yes     yes
checkers           does not   PASS    -              n/a        PASS       yes     yes
chess              does not   PASS    -              n/a        PASS       yes     yes
childcare          does not   PENDING -              n/a        PASS       no      no
circuits           does not   PENDING -              n/a        PASS       yes     yes
contacts           does not   PASS    -              n/a        PASS       no      yes
contracts          does not   PENDING -              n/a        PASS       no      no
crm                does not   PASS    -              n/a        PASS       yes     yes
documents          does not   PENDING -              n/a        PASS       no      no
email              does not   PENDING -              n/a        PENDING    no      no
expense            does not   PENDING -              n/a        PASS       yes     yes
field-service      does not   PENDING -              n/a        PASS       no      no
fleet              does not   PENDING -              n/a        PASS       no      no
help-desk          does not   PENDING -              n/a        PASS       no      no
hiring             does not   PENDING -              n/a        PASS       no      no
inventory          does not   PASS    -              n/a        PASS       yes     yes
invoicing          works      PASS    749/749        11/11      PASS       yes     yes
legal              does not   PENDING -              n/a        PASS       no      no
meetings           does not   PENDING -              n/a        PASS       no      no
music-studio       does not   PASS    -              n/a        PASS       yes     yes
notes              does not   PENDING -              n/a        PASS       yes     yes
parametric         does not   PASS    -              n/a        PASS       yes     yes
pdf                does not   PENDING -              n/a        PASS       no      no
photo-studio       does not   PENDING -              n/a        PASS       no      no
pos                does not   PASS    -              n/a        PASS       yes     yes
presentation       does not   PASS    -              n/a        PASS       yes     yes
projects           does not   PASS    -              n/a        PASS       yes     yes
property-managemen does not   PENDING -              n/a        PASS       no      no
records            does not   PENDING -              n/a        PASS       no      no
shifts             does not   PENDING -              n/a        PASS       no      no
signatures         works      PASS    370/370        27/27      PASS       yes     yes
solitaire          does not   PASS    -              n/a        PASS       yes     yes
spreadsheet        does not   PENDING -              n/a        PENDING    no      no
sudoku             does not   PASS    -              n/a        PASS       yes     yes
survey             does not   PASS    -              n/a        PASS       yes     yes
tasks              does not   PASS    -              n/a        PASS       yes     yes
teamchat           does not   PENDING -              n/a        PENDING    no      no
time-tracking      does not   PASS    -              n/a        PASS       yes     yes
vector-studio      does not   PENDING -              n/a        PASS       no      no
video-studio       does not   PENDING -              n/a        PASS       no      no
whiteboard         does not   PENDING -              n/a        PENDING    no      no
wiki               does not   PENDING -              n/a        PENDING    no      no
------------------------------------------------------------------------------------------------------
51 apps | status works 2/51 | built 24/25 state rows ok | smoke seen for 25 | loads 25/25
```
