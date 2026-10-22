# Phase 3 design â€” hub workers (local re-implementation of `puter.workers`)

Status: **design, approved gate â€” no code written yet.** Every claim about the
contract below is grounded in the upstream app sources (`D:\Stream\everything\upstream\src`)
â€” most decisively `calendar/tests/helpers/worker-harness.js`, which instantiates a
worker "the way the Puter workers runtime would" and is the crispest spec of the
runtime surface that exists anywhere. Nothing here ships external calls; every
cloud behavior below is a local equivalent.

## 1. What Phase 3 must make true

After Phase 3, `node build-hub.mjs scan` must say **easy** (or "partly" with a
named, documented reason) for: childcare, documents, field-service, fleet,
help-desk, invoicing, legal, photo-studio, property-management, signatures,
spreadsheet, teamchat, vector-studio, video-studio â€” i.e. the 15 apps whose only
hub gap is `puter.workers.*` (plus the two apps that additionally need
`net.fetch` / `perms.request` â€” whiteboard/wiki and calendar/teamchat â€” those
calls stay later-phase; see Â§8 and Â§13). calendar and email stay blocked on the
optional SMTP bridge (Â§14). hosting.create/delete (contracts, hiring, shifts) is
the publishing phase, deliberately not this one.

Two accuracy notes recorded during review:

- **video-studio** additionally calls generative engines
  (`ai.chat`, `ai.txt2img`, `ai.txt2speech`, `ai.speech2txt` â€” see the survey
  in README Â§"The app tiers"). Engines are the AI phase, not the workers
  runtime; video-studio's scan will flip to "partly" at Phase 3 (workers done)
  and to easy only after engines land.
- **documents** is the one Phase 3 app that deploys a *stateful* worker: its
  co-editing rooms (`collab/service.js`, Yjs edit log under
  `documents-collab/<room>/â€¦` on the owner's space) run inside the deployed
  room worker and are reached by plain HTTP POST `${server}/api`
  (`api.js:31`) â€” no WebSockets anywhere (Â§11).

## 2. The observable contract (from the apps' sources, not from memory)

### `puter.workers.create(name, filePath)`

- `name` â€” typically pseudo-random (`${PREFIX}${uid(10)}`), retried on failure;
  collisions must surface as a retriable error, and apps treat "create failed
  BUT worker exists under that name" as success (teamchat/deploy.js:83-89).
- `filePath` â€” a path **in the caller's cloud space** (app sandbox or Drive);
  reads the worker JS bundle. Drive paths are subject to the same grant rules
  as any read â€” no new path class.
- Resolves to a deployment record. Apps use, only: `dep.url`
  (childcare/team.js:284 â€” falls back to `https://<name>.puter.work`), and
  `dep.file_path` (teamchat/deploy.js:93), `dep.success === false` +
  `dep.errors: []` as the failure shape (childcare/team.js:275-278).
- **Overwrite-redeploy semantics**: `fs.write` on the deployed script file
  redeploys the worker with the new source (worker-harness.js:192-195, and
  teamchat/updateOwnWorker = write bundle â†’ wait for the new build id).

### `puter.workers.list()` / `puter.workers.get(name)` / ``.delete(name)`

- `list()` â€” array or `{ items }`; entries `{ name, url, file_path, created_at }`
  (teamchat/deploy.js:101-118 sorts by `created_at`, filters by name prefix).
- `get(name)` â€” same entry shape; apps use `.file_path` (teamchat:156-157) and
  treat a missing name as an error.
- `delete(name)` â€” idempotent-ish; apps call it in fallback cleanup with
  optional chaining (`legal/team.js:261`).

### `puter.workers.exec(urlOrName, init)`

- `init` is a **fetch init** (`method`, `headers`, `body` â€¦ url
  (`docs/api`, `whiteboard/src`/api.js:164, email-worker:118, 37 call sites).
- The runtime attaches the signed-in caller's session; inside the worker the
  handler sees `ctx.user` (historically also `ctx.requestor` â€” apps check both,
  email-worker.js:707-708) **only** for `exec` callers; anonymous direct hits
  have neither. `x-puter-no-auth` header rides along when the app asks for it;
  some workers expose a no-auth `/health` (api-client/api.js:82).
- Returns the worker's Response (`.ok`, `.json()`/`.text()` used pervasively).

### The runtime globals a worker script expects (worker-harness.js is the spec)

- `router` â€” a global route collector: `router.get|post|put|delete|options('/p/:param', handler)`.
- `handler(ctx)` â€” `ctx = { request, params, me }` (+ `user`/`requestor` for
  exec callers). `request` = fetch-Request-like (`url`, `method`, `headers.get`,
  `.json()`, `.text()`); handlers return a `Response`-like or a plain object
  (serialized as JSON 200 â€” harness line 167-170).
- `me` â€” the **owner** context: `me.puter.kv` (rsvp-worker) and
  `me.puter.email` / `me.puter.authToken` (email-worker). Owner-bound SDK from
  the baked-in preamble (`__PUTER_PREAMBLE_VERSION__`).
- `crypto` â€” webcrypto (digest usage inside workers is real: capability tokens).
- `Response` â€” constructible, with `.status/.ok/.headers/.text()/.json()`.

### What workers do at runtime (capability inventory from all sources)

1. Route HTTP APIs (JSON + 303 redirects for guest links). Worker-visible
   `ctx.request.url` carries the REAL scheme+host origin (passed by the exec
   route and the /wr/ + /w/ mounts from the request's Host header; placeholder
   `http://worker.local` when the caller supplies none), so redirect targets
   like the RSVP `#w=<origin>&t=<token>` fragment name a URL that works.
2. Own **persistent KV namespace** (the worker's own), including expiry +
   `list(pattern)` â€” same semantics as the hub kv already implements.
3. Read/write the owner's cloud space in some flows (team bundles copy records)
   â€” in our model this is owner-granted fs through the same `access()` rules.
4. Send email **as the caller** (pay-to-sender model: "billed to and
   rate-limited as the host who asked", email-worker.js:9-12) â€” capability =
   session forwarding; rate limits live in worker KV (they implement it
   themselves).
5. See a caller identity: `ctx.user`. For anonymous/public endpoints (rsvp
   guest links), no user â€” capability tokens in the URL are the auth.

## 3. Deliberate local differences (each will land in the README ledger)

| Puter | cad-home Phase 3 | Why |
| --- | --- | --- |
| `https://<name>.puter.work` per-worker domain | **`/wr/<user>/<name>/`** on this server's origin; exec accepts name or that URL, and nothing else | one origin (see README Â§11 recommendation); no wildcard DNS/TLS; no external calls ever |
| worker runs on a shared commercial edge (workerd/Wintercg) | worker runs as a **Node child process per invocation-batch** under the existing `fn-runner` permission model | one runtime to secure; the repo already runs a proven version of it (lib/functions.js + lib/fn-runner.js, `node --permission`, IPC-proxied kv/AI) |
| `puter-auth` bearer token forwarded by exec | exec is **same-origin, cookie-carrying**; the worker endpoint accepts the hub session (or `X-CAD-Request` for fetch-from-page) and injects `ctx.user` | no Puter tokens exist here; cookie auth already covers this |
| puter.email send billed to caller | `me.puter.email.send` â†’ server's optional SMTP bridge, rate-limited per user; **no SMTP configured â†’ named `mail_not_configured` error** | email stays the documented optional exception to no-external-calls |
| App-owner's shared workers on fixed public URLs (calendar-email.puter.work) | **packaged workers**: the app's dist may ship `workers/<name>.js`; install copies it into a server-owned `app:<name>` worker served at `/wr/app/<app>/<name>/`, listed for admin approval at install time | "the app owner" is the server admin in this deployment |

## 4. Architecture

### Registry (`lib/hub-workers.js`, tables in the existing hub DB)

- `hub_workers(id, user, app, name, file_path, url_path, pk_id, created_at, updated_at, meta)` â€”
  `user` is the owning account (or `NULL` + `app` for packaged workers).
- Name rules: `^[A-Za-z0-9][A-Za-z0-9-]{1,63}$`, unique **per user** (Puter's are
  global; ours live in a per-user namespace so one person's `school-abc` cannot
  take the name another person wants â€” a documented, strictly-safer difference).
- `hub_workers` gets **its own kv namespace** reusing today's kv tables with
  namespace key `worker:<user>:<name>` (or `worker:app:<app>:<name>`) and the
  same 2 MB cap (`MAX_KV_TOTAL`) and the same list/prefix semantics.
- The script file lives where the app's fs says it does (app sandbox or
  granted Drive path); the registry stores the resolved **virtual path**. Script
  size cap 2 MiB; content sha stored so redeploy-on-write can be masked.

### Runner (extends the fn-runner precedent)

- One child process per worker, spawned per request batch and idled out (the
  functions.js constants: IDLE_MS, MAX_CONCURRENT = 4, MAX_QUEUE = 50 â€” numbers
  may move with measurements, in one place).
- Globals injected by a **preamble prefix** written to the runner's temp module:
  `router` (a ~120-line route collector â€” matchRoute shape exactly as in
  worker-harness.js:96-114), `me = { puter: <ownerSdk> }`, `crypto` (node
  webcrypto â€” fine, the harness imports it too), `Response` (needs
  constructible Response â€” Node 24 has global Response).
- Owner SDK stub `me.puter`: `kv` (the worker namespace; get/set/del/incr/
  expire/list â€” same wire shapes as the hub shim), `fs` restricted to paths the
  owner granted to the OWNING app (resolved with the same `access()`, audited),
  `email.send` (optional SMTP; hard-denied otherwise).
- IPC: same proxy pattern as fn-runner (kv/fs/email requests over
  `process.send`, answered by the parent which enforces access + audit).
- **No network for the worker process**: Node's permission model does not
  cover net, so the runner adds a net tripwire (documented same as the Functions
  warning in the README) â€” `fetch`/`net` symbols are undefined in the preamble
  scope, and the caller-side target of any exec-from-worker is same-origin
  only. This is the honest weak point, called out exactly where lib/functions.js
  calls its own out.

### Serving routes

- `server.js` mounts `/wr/<user>/<name>/*` (or `/wr/app/<app>/<name>/*` for
  packaged): resolve worker â†’ route via the registry â†’ run â†’ return Response.
- Auth on that route is the **inside-the-server dispatcher**, not a public
  listener call: exec() from the shim = same-origin fetch with cookies; a
  public worker is served on the public listener ONLY if `meta.public` was set
  at create (per-app, admin-visible), otherwise 404s to strangers and 401s to
  signed-in-but-not-owner/other-user clients â€¦ (exact matrix in Â§6).
- Rate limit per name+IP on public routes (functions.js rateLimit precedent).

### Shim API (`lib/shim/puter.js`)

- `puter.workers = { create, list, get, delete, exec }` â€” exact resolves noted
  in Â§2 (`dep.url` = full same-origin URL, `file_path`, `created_at`,
  `{items, success:false, errors}` shapes).
- `exec(target, init)`: name â†’ `/wr/<user>/<name>/`; URL â†’ `assertLocal` +
  must start with this origin's `/wr/`; forward init; attach `X-CAD-Request`;
  return the Response as-is. External URL â†’ named `external_not_allowed`.
- Overwrite-redeploy: the fs write path checks the registry ("is this path a
  deployed worker's file for this app+user?") and invalidates the cached build
  so the next hit runs new source â€” mirrors harness semantics with no polling.

## 5. Correctness gates (tests, before merge)

1. **Contract re-implementation test**: instantiate the real `rsvp-worker.js`
   source from upstream through OUR runner (placeholders substituted exactly
   like its own test does) and run selected tests a meaningful subset of its own
   `rsvp-worker.test.js` scenarios through `/wr/...` â€” the strongest possible
   honesty check, because it reuses upstream's own spec.
2. Registry CRUD + name collisions + per-user isolation (`/wr/person2/x` never
   invokes person1's worker of the same name).
3. exec shapes: name target, full /wr/ URL target, external URL refusal,
   `x-puter-no-auth`, ctx.user on VS off.
4. KV: worker namespace caps, expiry, list prefix â€” reuse existing kv tests.
5. Redeploy-on-write, delete â†’ instant 404, revoke-grant â†’ script read fails.
6. Bundle scan: `build-hub.mjs scan` tier flips for the affected 15 apps.
7. Browser smoke: one worker deployed by a mock app through the real shim
   (create â†’ exec â†’ delete), run in chrome like the consent pass.

## 6. Security posture (matching README Â§12's voice)

- Worker code is the owner's code, so **the owner already trusts themself**;
  the protections that matter are: it cannot touch another person's space
  (every storage hop goes through the parent's `access()`), it cannot spawn
  processes or write arbitrary files (permission model), it cannot phone out
  (three layers, Â§12: module-resolve gate, deleted fetch globals, sockets are
  IPC-only), it is rate-limited and time-boxed per invocation with the Â§12
  limits, and every invocation is logged (app, user, route, status, ms,
  bytes) with the log visible in Admin â†’ Hub.
- Guest links (rsvp) are capability URLs with the same property the upstream
  worker enforces: only hash-of-token is stored; the raw token lives only in
  the link.
- Mail: worker-initiated sends are rate-limited **per caller identity**; the
  account-level SMTP stays optional and admin-configured (the one documented
  external exception).

## 7. What stays open / explicit non-goals for this phase

- `workers.exec` for **SMTP is the only mail capability**; `email.send` as a
  general hub SDK method is a later phase (calendar/email app install parity).
- No cron/schedules/queues: **nothing in the 51 apps calls them** â€” re-verified
  against source with the grep shown in Â§11.
- `net.fetch` (whiteboard/wiki) and `perms.request` (calendar, teamchat) land
  in the docs-fetched proxy / permissions phases respectively â€” named now so
  the scan line for those apps stays "partly" rather than pretending.
- `puter.hosting` (contracts/hiring/shifts publish worker+static bundles) is
  the next phase's design, not this one.

## 8. Order of work (each step merged + tested before the next)

1. `lib/hub-workers.js` + tables + registry tests.
2. Preamble + runner wired to fn-runner IPC + router (+ the Â§12 network gate
   and limits, tested).
3. Serving routes + auth matrix + public-route gate.
4. Shim `puter.workers` + exec (+ the `.puter.work` alias table from Â§10).
5. Redeploy-on-write + delete/revoke invalidation + deploy audit rows.
6. Upstream-source run selected tests tests (Â§15 list) + scan tier flip.
7. Browser smoke pass + README ledger/section updates.
8. Productize in the agreed order: **signatures first, then invoicing**, then
   the rest of the scan list alphabetically (documents last of the group â€” its
   two-Chromium co-edit smoke is the most involved), calendar/email when SMTP
   is configured.

---

# Part II â€” review additions (the eight questions, answered with evidence)

Status additions below were written during the review round before any code.
Each section answers one of the reviewer's questions; grep outputs are quoted
where the question asked for them.

## 9. Public worker routes vs private-only

Two listeners already exist in this server (private = loopback with the hub
UI; public = what the LAN reaches). Workers ride on both only as follows:

- **Default is private-only.** A worker whose deployment record has no
  `meta.public` flag 404s on the public listener and 401s on the private
  listener for any signed-in user who is neither the owner nor exec-forwarded
  (full matrix in Â§6).
- **Public requires `meta.public: true` at create** (an app-level choice,
  visible in `list()` and in Admin â†’ Hub), and public routes get:
  - **rate limit per IP+worker** (the `rateLimit` precedent in lib/http.js),
    threshold configurable, defaulting to functions.js',
  - **request body â‰¤ 1 MiB** (MAX_BODY) â†’ named `body_too_large`,
  - **no cookies or session**: the public dispatcher never reads the hub
    session cookie, never resolves a user; `ctx.user` is always undefined,
  - **no shim, no hub assets**: the public listener does not serve
    `/hub/puter.js`, `/h/*`, or `/api/hub/*` â€” a public worker is a worker,
    nothing else,
  - the handler's only identity channel is whatever the URL carries
    (capability tokens like rsvp's `/rsvp/<40-hex>` â€” sha256, only the hash
    stored, as upstream does).
- Apps that legitimately need public routes: calendar (guest share links,
  `cal-<host>` pattern, Â§10), meetings (the rooms directory worker),
  calendar-email (the `/rsvp/<token>` redirects guests follow from a mail).
  The rest of the 15 never need public exposure.

## 10. Hard-coded `https://<name>.puter.work` URLs â†’ system workers

Grep of all 51 apps' src for `https://<sub>.puter.work` finds these, complete:

| Hard-coded constant | App + site | Upstream worker source | Local name + route | Exposure |
| --- | --- | --- | --- | --- |
| `EMAIL_WORKER_URL` (calendar/invites.js:64) | calendar, email sending for invites | `calendar/src/workers/email-worker.js` | `calendar-email` â†’ `/wr/app/calendar/email` | exec (send) + public `/rsvp/<token>` capability pages |
| `field-service-email` (field-service/mailer.js:9) | field-service | `src/workers/email-worker.js` | `field-service-email` â†’ `/wr/app/field-service/email` | exec (send) |
| `invoicing-email` (invoicing/mailer.js:20) | invoicing | `src/workers/email-worker.js` | `invoicing-email` â†’ `/wr/app/invoicing/email` | exec (send) |
| `puter-meetings-rooms` (meetings/rooms.js:108) | meetings (room-code directory; VITE_ROOMS_ORIGIN build override exists) | `meetings/worker/rooms.js` (present in-tree) | `puter-meetings-rooms` â†’ `/wr/app/meetings/rooms` | public directory read |
| `https://cal-<host>.puter.work` (booking.js:108â€“595, rsvp-links.js:6,527,1038) | calendar guest share links, **rebuilt at runtime from a label** (`cal-` + label + `.puter.work`) | per-user rsvp-worker, deployed on first use (rsvp-links.js:6) | `cal-<user>` â†’ `/wr/<user>/cal-<user>` | **public**: guest links must work without a session |
| `https://${server}.puter.work` (help-desk) | help-desk | the name is **user-configured in settings**, not a constant | whatever the admin configures â†’ `/wr/<user>/<name>` | exec |

**Whose worker is it?** In this deployment, "the app owner" is the server
admin â€” so the four fixed-name shared workers are **packaged workers**
(Â§3 row 5): the app dist ships `workers/<name>.js`; install copies it into a
server-owned `app:<app>` registry entry, shown in Admin â†’ Hub for approval;
nobody's personal deploy can shadow or delete them. They run under the SAME
runtime and limits as user workers.

**Making the URLs resolve locally** (three layers, all no-external-calls):

1. **Serve-time rewrite of literal shapes in app bundles**: the calendar
   templates build guest links from the constant fragments `https://cal-` and
   `.puter.work` around a runtime label. The rewriter patches those literal
   fragments (`https://cal-` â†’ `${pageBase}/w/cal-`, `` .puter.work`` removed),
   so runtime interpolation produces a working local URL. Applied to every
   bundle at serve time (the same pass that rewrites `js.puter.com`).
2. **The system workers' own code** is likewise rewritten at packaging, so
   links they compose into mail messages are local URLs from the start.
3. **Runtime net-calls**: `workers.exec('https://calendar-email.puter.work/â€¦')`
   (email-worker.js:118 pattern) is aliased by the shim through the fixed
   table above (exact host â†’ `/wr/app/<app>/<name>`); an unknown
   `*.puter.work` host is a named `external_not_allowed` error, never a
   silent pass-through.

**Implemented (2026-10-21).** `installPackagedFromDist` (hub-workers.js) runs
after every app build/install and turns the dist's `workers/<name>.js` files
into packaged rows: server-owned (`user` NULL + `app`), served under
`/wr/app/<app>/<name>/`, re-approval reset on a changed sha (`redeploy` audit
row), unchanged source keeps its approval (`reinstall` row). Bare-name exec
resolves the PACKAGED row first â€” nobody's personal deploy can shadow a fixed
system name (their own same-named deploy stays reachable as `person1/<name>`)
â€” and an unknown `*.puter.work` exec target 403s
`external_not_allowed` (test/hub-workers-packaged.test.js). Layer 1 (the
serve-time `https://cal-` fragment rewrite) and layer 2 (per-app
`textTransform` at packaging) land with the calendar/field-service/invoicing
productization steps, where each link builder is productized. The actual
calendar-email / field-service-email / invoicing-email /
puter-meetings-rooms rows install automatically once those apps are built.

Guest share links use the short public shape **`/w/<label>/â€¦`**, resolved by
the registry: for calendar the label is `<user>`-derived (`cal-<user>`), so
`/w/cal-marta/book/<slug>` routes to owner `marta`, worker `cal-marta`. This
keeps links short in print/mail, works with the per-user name namespace
(Â§4), and needs exactly one new public route (no wildcard DNS, no new hosts).

## 11. WebSockets, long-lived state, and the warm pool

**Re-grep (evidence):** `new WebSocket|socket\.io|ws://|wss://|upgrade` over
documents, whiteboard, teamchat, meetings, help-desk src â†’ **zero WebSocket
uses**; the only `upgrade` hits are IndexedDB schema upgrades and UI prose.
Collaboration is HTTP: documents' rooms service answers POST `${server}/api`
(documents/api.js:31), co-editing syncs the Yjs log over it. `event.waitUntil`
hits are the apps' own client-side service worker (src/sw.js), not worker
handlers; `api.scheduled` in teamchat is its own REST endpoint over its
workspace worker. **Queues/schedules/cron re-grep**
(`workers\.queues|ctx\.waitUntil|event\.waitUntil|addEventListener\('scheduled'|\.scheduled\(`):
nothing â€” only the sw.js and prose false-positives above. So: no WebSocket
termination, no schedulers, no queues in Phase 3 â€” confirmed against source,
not just the old survey.

**Long-lived state** lives outside the process by contract: worker KV
(`worker:<user>:<name>`, the hub's kv tables) and the owner's cloud space
(documents keeps `documents-collab/<room>/<edit-log>` on the owner's fs,
collab/service.js:44). Nothing a worker needs to survive lives only in RAM â€”
which is exactly what makes eviction safe.

**Warm pool** (extends functions.js's pool, which already does this for
Functions):

- keyed `<user>:<name>` (and `app:<app>:<name>` for packaged) â€” the 12k-line
  teamchat/whiteboard bundles boot **once**, not per request;
- a warm process handles requests until **IDLE_MS** (functions.js value, 5
  min) with no work â†’ `child.kill()` â†’ evicted; next request cold-boots and
  re-reads state (for documents: re-applies the room's edit log, which the
  upstream service is already built to do on a fresh boot);
- **per-worker serialization**: one invocation in flight per process
  (MAX_CONCURRENT = 1 per worker, MAX_QUEUE = 50 â†’ named `worker_busy` 503),
  pool-wide cap MAX_CONCURRENT = 4 across workers with LRU eviction â€”
  strictly safer than upstream (isolates there may run concurrently; ours
  cannot diverge in-memory on the same Yjs room);
- pool size and idle time configurable (`workers.pool_max`,
  `workers.idle_ms`); Admin â†’ Hub shows live pool rows (worker, boot ms,
  requests served, idle for).

## 12. The Node permission model on Windows/Node 24 â€” exactly what it restricts, and the network story

Spawning (from server.js) uses `node --permission` (stable in Node 24) with:

- **restricted by default**: filesystem via `node:fs`/`fs/promises` (reads
  and writes outside the granted list throw), `child_process` (spawn/exec
  throw), native addons (throw; we never pass `--allow-addons`), worker
  threads (throw; we never pass `--allow-worker`), WASI (throw);
- **granted**: `--allow-fs-read`/`--allow-fs-write` scoped to the worker's
  sandbox dir + temp module dir â€” on Windows the same flags gate the same
  calls (the checks are at the Node layer, not OS DACLs), which we test on
  win32 explicitly;
- **NOT covered by `--permission`: the network.** That is Node's documented
  gap, and honestly the one that matters here. Closed concretely, in three
  layers, each with a named error and a test:
  1. **module gate** â€” the runner registers `module.registerHooks` (verified
     available in Node 24.21.0) *before* user code: a resolve hook denies
     `node:net`, `node:http`, `node:https`, `node:tls`, `node:dgram`,
     `node:dns`, `node:cluster`, `node:child_process`,
     `node:worker_threads`, `node:inspector`, and any non-`node:` absolute
     or `http(s)` specifier â†’ named `net_disabled`. Static import, dynamic
     `import()`, and `require()` all resolve through hooks, so all three are
     covered;
  2. **global gate** â€” the preamble deletes `fetch`, `WebSocket`,
     `XMLHttpRequest` from the worker realm (handlers *are* the server; they
     never need outbound fetch â€” `Response`/`Request` stay, worker-harness
     needs them);
  3. **no ambient sockets** â€” the child's only channel is `process.send`
     IPC to the hub parent, which enforces `access()` + audit on every hop.
- Residual honest weaknesses, stated in the README with the Functions
  warning's voice: resolved-builtin *caching* tricks and C++ addons are
  theoretical bypasses (addons are permission-blocked; bindings are gated by
  the same permission model), and a worker can still burn **CPU** â€” Node has
  no rlimit on Windows, so the wall-clock timeout is the control for runaway
  CPU.

**Limits, each with its test:**

| Limit | Value (config) | Test |
| --- | --- | --- |
| wall-clock per invocation | 30 s default (`functions.timeout_ms`) | worker with an infinite loop â†’ named `shim_timeout`, next request fine |
| memory | `--max-old-space-size=128` (`workers.memory_mb`) | worker allocates strings past the cap â†’ RangeError â†’ named failure, pool recovered |
| request body | 1 MiB (shared MAX_BODY) | POST 2 MiB â†’ `body_too_large`, handler never ran |
| response size | 8 MiB (`workers.max_response_mb`) | worker returns 9 MiB string â†’ truncated with named log + `response_too_large` to the caller |
| queue depth | 50 per worker, then 503 `worker_busy` | flood a slow handler with 60 calls â†’ first 50 queued|served, rest named-rejected |
| runtime script size | 1 MiB at `create`/redeploy | 2 MiB bundle â†’ `script_too_large` at create |
| worker KV | 2 MiB/namespace (existing MAX_KV_TOTAL) | covered by existing kv tests |
| per-user worker count | 8 (`workers.per_user_max`) | 9th create â†’ `quota_exceeded` |

## 13. Who may call `workers.create`; quota, audit, and owner deletion

- **Who**: any signed-in member of this server, through the shim from an
  app page â€” attribution works exactly like consent grants do: the route
  knows the session and the app (`X-CAD-Request`/cookie + referrer rules),
  and the registry stores both. There is no anonymous create, no admin-only
  carve-outs needed for the 15 apps (create is a normal user capability),
  and Drive reads of the script file follow the same grant rules as any
  other read (a worker deployed from a Drive path must have been granted by
  consent like every other app write into that area â€” consent smoke stays
  the proof).
- **Quota**: Â§12's table (default 8 per user, configurable); script files
  count in the owner's drive quota like any file; exec traffic is
  rate-limited like Functions.
- **Audit**: every create / redeploy / delete writes a row in a
  `hub_workers_log(id, at, user, app, action, name, sha, source_path)` â€”
  visible in Admin â†’ Hub, alongside the invocation log. A redeploy row's sha
  is what makes "overwrite = redeploy" observable and auditable, without any
  polling.
- **Owner deletion**: when an account is removed, `removeUser` (already the
  only deletion path) additionally: deletes the user's registry rows, wipes
  their `worker:<user>:*` kv namespaces, deletes their worker script files
  (the user's folder), and writes a `owner_deleted` audit row. Their
  `/wr/<user>/<name>` URLs 404 afterwards for everyone; packaged system
  workers are untouched (they belong to `app:<app>`, not to accounts).

## 14. Email workers: inbound or send-only?

**Send-only.** Upstream's email workers only *send* (and their interactive
side is guests opening capability **links** from the sent mail â€” inbound
POSTs to the worker's public routes, not inbound SMTP). Nothing in the 51
apps receives mail programmatically. So Phase 3 wires `me.puter.email.send`
to this server's **optional SMTP bridge** (user-configured, the one
documented external exception), rate-limited per caller identity; with no
SMTP configured the named error is `mail_not_configured`. Inbound mail
(local MTA, mail delivery into a Drive folder) is a separate future design
and is explicitly out of scope here â€” named so it cannot sneak in.

## 15. The test gate, per app: upstream tests to run selected tests, and the checklist for the ones with none

The values below count source matches of worker API names; they are occurrences, not test cases
(matches of `workers.(create|exec|get|list|delete)|instantiateWorker`):

| App | upstream worker API-use matches (not test cases) | Gate |
| --- | --- | --- |
| whiteboard | 102 | run selected tests its worker tests through our runner (capsule at Â§5.1) |
| teamchat | 90 | run selected tests deploy/updateOwnWorker + store flows |
| calendar | 51 | **mandated**: rsvp-worker.test.js in full; email-worker + booking tests same runner |
| signatures | 40 | run selected tests signlink/session flows |
| survey | 11 | run selected tests collector tests |
| spreadsheet | 8 | run selected tests its worker tests |
| property-management | 6 | run selected tests |
| invoicing | 3 | run selected tests (first productized app after signatures) |
| legal | 3 | run selected tests |
| field-service | 2 | run selected tests |
| fleet | 1 | run selected tests |
| meetings | 1 | run selected tests rooms.js directory test |
| video-studio | 1 | run selected tests (engines stay later-phase; workers assertions only) |
| childcare | **0** | **call-site checklist**: every workers.* call site in src becomes an HTTP test through our shim before its tier flips |
| documents | **0** (has dev/mock harness, `collab-dev-server.mjs`) | mount the deployed room worker where the dev harness runs, then run the **call-site checklist** (deploy â†’ create room â†’ join â†’ apply update â†’ presence â†’ invite) as protocol tests; live two-Chromium co-edit smoke lands with documents' own productization step |
| help-desk | **0** | call-site checklist |
| photo-studio | **0** | call-site checklist |

**Call-site checklist rule** (the honest substitute where upstream shipped no
test): the app's own src *is* the spec â€” grep its call sites
(files:lines, checked into the test), drive each through the real shim with
expectations read from the surrounding code, and a tier flips only when
every listed site passes. The same rule the consent and persist recipes used.

---

# Part III â€” round-2 amendments (post-approval additions, before any code)

Date: review round 2. Phase 3 runtime steps 1â€“7 are approved to START once
these are in the doc; **no app flips to "works" until it is tested** through
its own gate (Â§15).

## 16. Response safety at the `/wr/` boundary (both listeners)

Every response the worker runtime returns â€” exec-originated or public â€” gets:

- `Content-Security-Policy: sandbox allow-scripts allow-forms` (the same
  sandbox shape hub app-packaged content already uses) â€” a rendered response
  runs with no origin privileges: no cookies, no storage, no same-origin
  access to the hub;
- `X-Content-Type-Options: nosniff` (already a base header; asserted again at
  this boundary);
- a **content-type allow-list**: handler content-types must be one of
  `text/html`, `text/plain`, `application/json`, `text/css`, `text/javascript`,
  `application/javascript`, `image/png`, `image/jpeg`, `image/svg+xml`,
  `image/webp`, `application/octet-stream` (configurable list) â€” anything
  else â†’ named `content_type_not_allowed`, response refuses. Tests: one per
  type plus one denial.
- **Set-Cookie is stripped** from worker responses on BOTH listeners (never
  reaches the browser); **the Cookie request header is never forwarded into
  the worker** â€” `ctx.user` is resolved by the dispatcher from the hub session
  (private) or is undefined (public); the worker's Request object simply has
  no Cookie header. Tests: worker echoes its request headers (echo test
  worker) â†’ no `cookie` key; response tries to set `Set-Cookie` â†’ the browser
  proxy never receives one.

## 17. Authority of `me.puter` per invocation type

| Invocation | `ctx.user` | `me.puter.kv` | `me.puter.fs` | `me.puter.email` |
| --- | --- | --- | --- | --- |
| exec, private, caller = signed-in member | the CALLER's identity (user + app), never the owner | worker's own namespace | **owner-scoped only**: resolved through `access()` with the OWNING app's grants â€” a call by person2 cannot read person1's files; the worker acts with its owner's grants, and the grant's revocation is honored immediately | yes, rate-limited per caller + per worker |
| exec from another app of the same user | that user | own namespace | owner-granted only (same rule as above, attributed to the owning app's grants) | yes |
| **public guest** (share links, from the public listener) | **absent** | worker's own namespace, only through the worker | **none â€” no inherited Drive grants**: a public path never resolves a vm-path under the owner's Drive; the worker must copy anything guests need INTO its own KV namespace | **no** (send only fires through exec) |
| packaged system worker on a public route | absent | app worker's namespace | none | via exec only |

**Who may call a non-public worker?** The owner; the server admin; and any
signed-in member invoking it via `puter.workers.exec(...)` in whose context
the exec attaches (that member becomes `ctx.user`) â€” exactly upstream's shape.
What never happens: anonymous/direct calls to a non-public worker (401), and
the public listener serving it at all (404).

## 18. Public exposure: approval + script hash allow-list

- `meta.public` can be set by the app at create, but it only takes effect
  after **approval**: either an admin approval row (Admin â†’ Hub, per worker)
  or â€” for workers a signed-in member deploys from an app page â€” a
  consent-style prompt wording ("X wants to publish a public address") for
  the.invoking member; both do the same registry flag set + audit row.
- **Hash allow-list**: for workers whose script comes from an installed app
  dist (packaged workers now; later any app-script worker), the registry
  stores the script's SHA-256 from the build manifest, and serving checks
  the hash matches â€” a changed script (or a worker the dist no longer
  contains) fails closed until re-approved at the next app update.
- **Arbitrary code** (a member's own script deployed at runtime, not from a
  dist) is **private-only in this phase**; making it public requires the
  admin toggle (`allow_public_user_workers`, default **off**) â€” documented
  in the README ledger with the risk stated plainly.

## 19. Bypass test suite for the network layers (+ OS-level hardening note)

Test list (the built subset lives in `test/hub-workers.test.js` +
`test/hub-workers-net.test.js`, each with a named assert):

1. `import('node:net')` / `import('node:https')` / `import('node:http')` â€”
   dynamic import â†’ `net_disabled` (module hook covers dynamic resolution);
2. `require('node:tls')` â€” CJS resolution â†’ `net_disabled`, including the
   indirect road `getBuiltinModule('node:module')` â†’ `createRequire`;
3. `process.getBuiltinModule('node:net')` / `('node:tls')` â€” **this door has
   NO resolve-hook pathway at all** (measured on Node 24: a worker can open a
   TCP connection through it even under `--permission`), so the runner
   neutralizes the function itself, plus `process.binding` and
   `process.mainModule`, **before any worker code runs**
   (lib/worker-runner.js layer 2b); the test asserts the probes fail AND a
   real loopback listener sees zero connections;
4. `process.binding('tcp_wrap')` â€” throws/absent (neutralized above);
5. the **undici global dispatcher** (found by testing on Node 24.21, after the
   above was green): deep-touching the undici classes (consuming a
   Response/Request body) boots the bundled undici and installs
   `Symbol.for('undici.globalDispatcher.1')` on globalThis â€” its
   `dispatcher.request({ origin, path })` opens real sockets with fetch
   deleted and `--permission` on. The preamble (lib/worker-runner.js
   layer 2c) boots undici itself and then locks every `undici`-named
   globalThis symbol to frozen `undefined` before any worker module imports;
   the test asserts zero connections at a live listener;
6. `process.binding('tcp_wrap')` â€” throws/absent (neutralized above);
7. `globalThis` internals: `Object.getOwnPropertyNames(globalThis)` must not
   contain `fetch`, `WebSocket`, `XMLHttpRequest` after the preamble deletes
   them, and `new WebSocket('ws://127.0.0.1')` throws â€” plus the **durable
   realm allow-list** (test/hub-workers-net.test.js): the exact own names and
   symbols of the worker realm are frozen in the test, so a Node upgrade that
   introduces a new global fails it on purpose and forces review;
8. an attempt to re-acquire globals via `Function('return this')()` and via
   indirect eval â†’ still no `fetch`;
9. `process.env` inspection â€” the child env is an **explicit allow-list**
   built in `lib/hub-workers-run.js` (`CHILD_ENV_KEYS` + a pinned-empty
   `NODE_OPTIONS`), never the parent's env; the test plants a secret-shaped
   variable in the parent process first and proves the child cannot see it;
   Node itself insists on a small Windows floor (HOMEDRIVE, HOMEPATH,
   LOGONSERVER, TEMP, USERDOMAIN, USERNAME, USERPROFILE + the passed
   SystemRoot family) â€” measured, allow-listed in the test, and none of it is
   secret-bearing;
10. child_process spawn attempt â†’ throws (permission model).

**In-process layers are labeled best-effort in the README â€” the OS firewall
rule is the real control.** The honest residual risk list (other natives
handing out handles, memory/CPU abuse between checks, Node 25 API changes)
stays in the text next to the Function-constructor warning; the measured
subject is Node v24.21.0 on this deployment.

**OS-level hardening â€” the real control, now a runnable setup step
(README Â§1 step 5):**

- **Windows**: copy node.exe to a dedicated `data\bin\node-worker.exe` and
  add an **outbound firewall rule** (`cad-worker-net-block`) for that exact
  binary; the pool forks it when the server is started with
  `CAD_WORKER_NODE=data\bin\node-worker.exe`. The README step includes
  `node check-firewall.mjs` â€” a paired check whose CONTROL is the same
  outbound connection made by the normal node.exe (proving the PC is
  online) and whose worker probe must fail; **RULE OK** only when both
  hold, **NO INTERNET â€” INCONCLUSIVE** when the control fails. **Loopback
  is not filtered by the rule**: workers can still reach the hub's own
  listeners and local services on the server PC (Ollama etc.) â€” the hub's
  open surfaces are guarded (sign-in rate-limited to 10 wrong passwords per
  address+username / 15 min â†’ 429, tested; guest worker routes capped per
  address), and local services must be treated as reachable by anything
  running on that PC. **Public member-deployed workers must stay OFF until
  this step is done** (off by default â€” `workers.allow_public_user_workers`).
- **Linux**: run the pool in a systemd unit with `IPAddressDeny=any` +
  explicit `IPAddressAllow=localhost` (or an empty network namespace with
  only a UNIX socket) â€” network namespace adds a belt-and-braces socket
  barrier.

## 20. Parent-side RSS watchdog, cold-start budget, concurrency

- **Watchdog**: the parent polls each pooled child through its IPC heartbeat
  (the child reports `process.memoryUsage()` + busy flag every 2 s while
  alive); the parent additionally reads OS RSS (`process.kill(pid,0)` +
  platform RSS via `wmic`/`ps`, with the IPC number as the fast path) every
  5 s. A child past `workers.rss_mb` (default 256) is killed, the invocation
  gets named `worker_resource_limit`, and the worker is marked degraded (3
  hits â†’ auto-disabled + admin surfacing).
- **Tests**: (a) a worker that loops `Buffer.alloc(32 << 20, 0)` â†’ killed by
  the watchdog before allocation runs away, named error; (b) a synchronous
  infinite loop â€” heartbeats stop â†’ the parent's grace timer (2 s) fires â†’
  kill + named `shim_timeout`; (c) a normal worker stays pooled across both.
- **Measured budgets (measured 2026-10-21, evidence `_perf-workers.txt`, Node
  24.21.0)**: cold exec â€” spawn â†’ first response â€” **265 ms** wall from the
  HTTP call (child `bootMs` 220 ms: fork + module import + router + route);
  warm execs **p50 = 9 ms / p95 = 11 ms** over 11 repeats of a trivial GET;
  steady pooled-worker RSS **â‰ˆ 50 MB** (heartbeat `rssBytes` 49,729,536);
  parent server RSS 61 MB in the same run. Eight pooled workers fit
  comfortably inside the pool budget (`workers.pool_rss_budget_mb`, 512).
- **Pool-budget enforcement â€” tested 2026-10-21** (test/hub-workers-pool.test.js,
  4/4): a boot that would push pooled children past `workers.pool_rss_budget_mb`
  (80 MB in the test) evicts the LRU **idle** pool first (logged as `pool-evict`
  in the workers audit); only when nothing is evictable (the one warm worker is
  mid-flight) does the invocation refuse with the named `worker_busy` 503, and
  the busy worker survives the refusal. Unmeasured fresh boots count at
  `workers.boot_rss_estimate_mb` (64 MB, conservative against the measured â‰ˆ50).
  Found-and-fixed while testing: the watchdog measured quiet-time from
  `lastBeat = 0`, so any job in flight **before the first heartbeat** (~2 s
  after spawn) looked epoch-stale and was killed as `shim_timeout` â€”
  `lastBeat` is now anchored at spawn.
- **Per-worker concurrency is configurable** (`workers.concurrency`, default
  1 = serialized as in Â§11; settable up to 4 for stateless workers measured
  safe by the productization step for that worker).

## 21. Email caps

- per **worker**: N messages / 10 min (config `workers.email_per_worker`,
  default 50), HTTP 429 named `worker_email_rate_limited` otherwise;
- per **user** (across all their workers): `email_per_user` per day (default 200);
- per **message**: â‰¤ `email_recipients_max` (default 10) recipients â€” the
  adapter truncates and logs, never errors the whole flow;
- **forced From**: the SMTP bridge's own address from lib/mail.js is forced;
  a worker-passed `from` is replaced (logged in the audit row with the
  original address string). Tests for all four caps (a fake mail adapter in
  tests counts rows).

## 22. Rewrite rules and packaged workers maintenance

- **Zero-match rule â€” implemented + tested 2026-10-21**: the serve-time
  rewrites live as named rules in lib/hub-rewrite.js (`shim-swap`,
  `sw-guard`, `manifest`, `html-strip`); `countRuleHits` runs each rule over
  every built dist, `zeroMatchVerdict` flags zero-hit rules, and the build
  batch (`build-hub.mjs build-all`) **throws naming the rule** while
  `node build-hub.mjs rules` reports counts standalone. A rule deliberately
  retired goes through `hub.zero_match_leave` (config) or
  `CAD_ZERO_MATCH_LEAVE` (env); retiring prints alongside the counts so it
  stays audited. Current counts on this install: shim-swap 27, sw-guard 11,
  manifest 23, html-strip 133.
- **Packaged workers rebuild on update**: the packaged copies are built from
  the CURRENT app dist each time that app is rebuilt (the build step emits
  `data/hub/workers/<app>/<name>.js` freshly), registry sha updated, and a
  changed sha requires re-approval for public routes (Â§18) while private
  routes go live immediately â€” mirroring upstream's overwrite-redeploy rule.

## 23. `publicBaseUrl` and honest guest reachability

- Setting **`workers.public_base_url`** (`publicBaseUrl`) â€” implemented +
  tested 2026-10-21: settable in Admin â†’ **Server settings** ("Guest links
  address"), via `PUT admin/server` (URL-validated, trailing slash trimmed),
  exposed to surfaces that build guest links via `GET hub/workers/guest-base`
  â†’ `{ base, origin, note }`. All guest-facing link builders (Â§10 templates)
  consume it as each app is productized â€” never relative URLs, because guest
  links get pasted into conversations that live outside this network.
- **Honest note, recorded here and in the README**: when `publicBaseUrl` is
  not configured, guest links are generated as `${origin}/w/...` â€” they work
  for anyone who can reach the server's listener on the SAME address the
  link names. A hub bound to loopback-only is LAN-only: guests cannot reach
  it through the internet unless the admin picks a LAN-reachable URL (or
  proxies 443 â†’ this server) AND the public listener is on. The setup page
  shows exactly this sentence when serving public routes.

## 24. Signatures end-to-end browser acceptance (the first productized app)

One test, run after signatures' productization step, before its tier flips:

1. **deploy**: in the signatures app UI on the PRIVATE listener (real
   Chromium), complete a signing flow that calls `puter.workers.create` â€”
   assert the shim overlay flow deploys (create list row + the app's
   successful status), via the SAME overlay machinery as consent;
2. **sign as guest**: take the produced link, open it in a **fresh
   cookie-less context on the PUBLIC listener URL** (publicBaseUrl in the
   test) â€” assert the guest sees the signature page, the response was
   served by the `signatures-â€¦` worker with Â§16's headers, signing records
   the guest's reply into the owner's worker KV/fs, and the OWNER (private
   session) sees the completed signature.

### Pending until tested (Â§19â€“Â§24 status board, kept honest)

| Item | Status |
| --- | --- |
| Â§12 network-gate bypass suite (getBuiltinModule / binding / require / eval / real listener) | **tested 2026-10-21** â€” test/hub-workers-net.test.js, 6/6 on Node 24.21.0; getBuiltinModule / binding / mainModule neutralized pre-import |
| Â§19 worker env isolation | **tested 2026-10-21** â€” explicit allow-list + planted-secret probe green |
| Â§20 cold start / warm latency / steady RSS | **measured 2026-10-21** â€” _perf-workers.txt: cold 265 ms, warm p50 9 ms / p95 11 ms, RSS â‰ˆ 50 MB/worker |
| Â§20 pool-budget enforcement test (LRU eviction + worker_busy refusal) | **tested 2026-10-21** â€” test/hub-workers-pool.test.js 4/4: evict-not-refuse, refusal + recovery boot, `pool-evict` audit row; also fixed the watchdog's first-heartbeat kill (lastBeat anchored at spawn; regression test with a 3.2 s first call, test/hub-workers-heartbeat.test.js) |
| Â§21 email caps | **tested** (per-worker window + per-user day + cap-before-send proof) |
| Â§22 zero-match rewrite-rule failure | **tested 2026-10-21** â€” rules named in hub-rewrite.js (shim-swap / sw-guard / manifest / html-strip), `countRuleHits` + `zeroMatchVerdict` run over all built dists; `node build-hub.mjs rules` prints counts and the build batch throws on a zero-hit unretired rule; retirement via `hub.zero_match_leave` (config or `CAD_ZERO_MATCH_LEAVE`) is itself printed |
| Â§23 publicBaseUrl | **tested 2026-10-21** â€” `workers.public_base_url` settable (Admin â†’ Server settings field + PUT admin/server with URL validation), guest surface `GET hub/workers/guest-base` returns `{ base, origin, note }` with the honest LAN-only sentence when unset; per-app link builders consume it as each app is productized (Â§10 templates) |
| Â§12 undici global-dispatcher bypass (field-reported) | **confirmed + fixed + tested 2026-10-21** â€” reproduced on Node 24.21.0 (deep-touching Response/Request/Headers/FormData boots undici; `dispatcher.request({origin, path})` opened a real loopback socket with fetch deleted); the preamble now boots undici first and locks every `undici.*` globalThis symbol to frozen `undefined`; test asserts zero connections; durable realm allow-list test fails on any new Node global |
| Â§19 worker-node firewall setup | **runnable step 2026-10-21** â€” README Â§1 step 5: dedicated `data\bin\node-worker.exe` + outbound-block rule `cad-worker-net-block` + `node check-firewall.mjs` (paired check: CONTROL = the same outbound connection via the normal node.exe must succeed, worker probe must fail; RULE OK only when both hold, NO INTERNET â€” INCONCLUSIVE when the control fails, RULE NOT SET UP when the binary is missing). Pool forks that binary when `CAD_WORKER_NODE` is set; a version-drift warning at startup names both node versions and asks for a recopy (tested); the firewall does NOT filter loopback â€” documented in both docs, with the sign-in rate-limit proved (10 wrong passwords per address+username / 15 min â†’ 429, test/login-rate-limit.test.js); public member-deployed workers stay OFF until the step is done |
| Â§10 packaged system workers + `.puter.work` alias | **implemented + tested 2026-10-21** â€” `installPackagedFromDist` runs after every build (rows user-NULL + app, approval reset on changed sha / `redeploy` audit row, unchanged source keeps approval); bare-name exec resolves the packaged row first (no shadow by a member's same-named deploy); unknown `*.puter.work` exec target 403s `external_not_allowed`; worker requests carry the real origin so redirect fragments (`#w=&t=`) name a working URL (test/hub-workers-packaged.test.js 5/5) |
| Â§15 calendar RSVP worker run selected tests (upstream source, 3 deploy substitutions) | **tested 2026-10-21** â€” test/hub-workers-rsvp.test.js 12/12: Bearer-secret admin guard, sync mints raw links once + stores hashes only, invite shape with no token echo, POST/PUT answers + invalid_status, one-click `#w&t&s` redirects + prefetcher/scanner refusals, reissue kills the old token, event-ended 410, suggestion cap/idempotent re-suggest/ride-along filtering, responses pull without hashes, dismiss, revoke. Booking half gated with calendar productization |
| 24 signatures E2E browser acceptance | **passed 2026-10-21** - `node sign-e2e.mjs`, 27/27: field seeded in the saved doc record (no canvas drag), trusted deploy consent, public link on a cookie-less context, PDF served through the token-mapped local file route, guest consent/signature in worker KV, owner pull and completed view |
| signatures upstream app suite | **passed 2026-10-21** - 370/370 tests in 31 files. Worker adapter: 15/172 worker-focused cases; `sign-worker.test.js` itself is 15/15. |
| invoicing upstream app suite | **passed 2026-10-21** - 749/749 tests in 25 files. Worker adapter: 96/96 cases from `email-worker.test.js` (59) and `mailer.test.js` (37). |
| invoicing app acceptance | **passed 2026-10-21** - built, clean Chromium smoke, 11/11 browser sharing E2E steps, shared hosting tests, upstream suite 749/749. |

`node build-hub.mjs status` computes verdicts from build/install, smoke, upstream coverage, required E2E, and server services. `source_scan` remains diagnostic only.

---

Build order after the runtime is green: signatures first, then invoicing, then the rest alphabetically, documents last.

## 25. Status verdict and exact upstream case coverage

`node build-hub.mjs status` no longer uses the static API scan as its verdict.
Each app verdict uses build/install, clean smoke, cases that execute cad-home
runner/shim/hub code, required E2E, and required services. An upstream suite
result is informational: it does not count as server coverage when only
upstream code and harnesses execute. Apps without upstream tests use the
generic functional gate: instrument every `puter.*` call/result, fail on
missing or rejected methods, verify KV across server restart, and round-trip
an FS save/open.

| Adapter | Covered / upstream worker cases | Scope |
| --- | ---: | --- |
| calendar | 0/45 runtime cases | 45/45 RSVP adapter cases run upstream code through the upstream worker harness. |
| signatures | 0/172 runtime cases | 30/30 adapted (`sign-worker.test.js` 15 + `email-worker.test.js` 15), still upstream code/harness only. Full upstream suite: 370/370. |
| invoicing | 0/96 runtime cases | 96/96 email-worker + mailer adapter cases use upstream harnesses. Full upstream suite: 749/749. |

The 172 signatures worker-focused cases are from `accesscode.test.js` (19),
`advanceturn.test.js` (9), `consent.test.js` (18), `deleteflow.test.js` (3),
`email-worker.test.js` (15), `emailer.test.js` (11), `expiry.test.js` (27),
`ownernotify.test.js` (15), `pagerail.test.js` (5), `sign-worker.test.js`
(15), `signlinks.test.js` (9), `store.test.js` (12), and `templates.test.js`
(13). Classification: **0 (a) execute cad-home runtime; 172 (b) are pure
upstream app/unit cases independent of this server**. The 30 adapted worker
cases are a subset and remain in (b); adapter count is not server coverage.
The 370/370 and 749/749 complete suites also execute upstream-only code. Thus
signatures and invoicing keep the `does not` verdict until their required
server-runtime case counts reach 100%, despite clean smoke and E2E.

## 26. Worker request URL boundary

Workers receive a canonical `Request.url` such as
`https://<host-label>.puter.work/sign/token`, with the wrapper path removed.
`workerBase` stays separate: on signatures guest routes it is assembled only
from the configured public base URL and the public wrapper path. The browser
shim maps fetch, WebSocket, and EventSource transports to
`/w/host/<host-label>/...`; app state and validation continue to see canonical
URLs. Private pages get the mapper inside the shim. Guest and public HTML gets
the same mapper at serve time. On public routes, `Host`, `Forwarded`,
`X-Forwarded-Host/Proto/Port`, and `X-Original-Host` are not forwarded. The
canonical worker origin and request path never depend on an incoming Host.
Tests cover own route path/query, absent private Host/origin, configured
signatures base, and fetch/WebSocket/EventSource transport mapping.

## 27. Shared static hosting

`puter.hosting.create/get/list/update/delete` share one host registry and
static file service. Sites are served only on the public listener at
`/site/<subdomain>/...`; the shim maps app-generated `https://<name>.puter.site`
URLs to the configured public listener path. No wildcard DNS or per-app server
is required. Public handling permits GET and HEAD, serves an allow-list of
static MIME types, has no directory listing, applies a restrictive CSP
sandbox and `nosniff`, drops public-listener cookies, sets no cookies,
rate-limits by site/IP (120 requests per minute), records create/update/delete
audit rows, and checks aggregate per-user hosted bytes against the configured
quota (100 MiB by default), including later app writes under published roots.
Admin can disable hosting in Server settings. Invoice sharing is covered end-to-end by
the public listener test and `invoicing-e2e.mjs`.

### Per-app published-page census (2026-10-22, upstream src evidence)

| App | hosting calls | Published file set | /site allowlist status |
| --- | --- | --- | --- |
| invoicing | `src\lib\share.js:163,167` create per share | `<token>.html` per shared invoice | covered (E2E 11/11) |
| hiring | `src\ui\publish.js:80` create, `:96` delete | `index.html` + `<job>.html` + `sitemap.xml` + `robots.txt` | covered (.xml/.txt present) |
| shifts | `src\ui\share.js:43` create + delete | `index.html` schedule page | covered |
| documents | `src\lib\puter.js:375-383` (create/update/delete), `src\lib\publish.js` | `index.html` page + `site.json` records, `<dir>.json` | covered (.json present) |
| contracts | `src\lib\calendar.js:86` create, `:129` delete | `deadlines.ics` subscribable feed | **was NOT covered — `.ics` added to `lib\hub-hosting.js` MIME table (2026-10-22), test in `test\hub-hosting.test.js`** |
| whiteboard | none | — | n/a (no publishing in upstream src) |
| vector-studio | none | — | n/a |

Every publisher writes through `puter.fs.write` under a per-app SHARE/SITE dir first,
so the quota check on later app writes (§27) applies. No app relies on directory
listing or on extensions outside the closed allowlist. The earlier §4.5 assumption
that whiteboard and vector-studio publish pages does not hold in upstream src — they
use workers only (census in §28).

## 28. URL rewrite count for remaining worker apps — honest census (2026-10-22)

Method: the hosting URL conversion is one shared shim mapping, so these apps need zero
app-specific serve-time rules for `.puter.site`, and worker `.puter.work` targets are
translated by `puter.workers.exec` at the shim boundary (`lib\shim\puter.js:1002-1023`:
canonical alias targets are split to the bare label; `/wr/...` targets are direct
same-origin). The census below greps EVERY app's own code in `upstream\src\` (tests and
dev mocks noted where they carry behavior) and records, with file:line evidence, where
an app touches a worker address itself and whether its own validation accepts the
canonical `https://<host_label>.puter.work` shape the shim produces.

Census output (raw): `_census.mjs` over `upstream\src`; whole-app inventory at the
bottom. `${name}.puter.work`-from-`dep.url` silence means the row's URL from the shim
is canonical and the app stores what it gets.

| App | puter.work refs (own code, no tests) | Own address handling → patch needed? | Evidence |
| --- | ---: | --- | --- |
| calendar | 27 | the `cal-<host>` alias is built from hash params in the PUBLIC page and re-checked against a strict *.puter.work guard; canonical passes. Served guest pages get the mapper at serve time (§26). | `calendar\public\book.html:275-283,471-477`, `calendar\src\js\booking.js:108` |
| childcare | 7 | `normalizeWorkerUrl(dep.url || \`https://${name}.puter.work\`)` — canonical row URL wins over the name guess. | `childcare\src\team.js:274-284,346` |
| documents | 4 | collab deploy family (same shape as documents below). | `documents\src\collab\api.js:36,69-82` |
| field-service | 16 | team.js normalizeWorkerUrl family; the EMAIL constant is a packaged system name. | `field-service\src\team.js:199-209`, `field-service\src\mailer.js:9` |
| fleet | 8 | same family + `workers.delete`. | `fleet\src\team.js:237-252,423` |
| help-desk | 9 | builds `https://${server}.puter.work` from its saved config (the owner's stored label), portal API the same. | `help-desk\src\client\api.js:32`, `help-desk\src\client\portal-api.js:30` |
| legal | 8 | team.js family, incl. `workers.delete`. | `legal\src\team.js:233-261,321` |
| meetings | 2 | rooms origin constant `https://puter-meetings-rooms.puter.work` overridable by build-time env — default resolves by packaged name. | `meetings\src\lib\rooms.js:14,108` |
| photo-studio | 6 | collab deploy family. | `photo-studio\src\collab\api.ts:33,73-86` |
| property-management | 15 | team + mailer family. | `property-management\src\team.js:219-229`, `property-management\src\mailer.js:10` |
| signatures | 21 | RESTORED craft rules (sign-page-url, sign-link-host, sign-worker-self) cover the guest-page and 303 self-address; dev mock routes *.puter.work in-page. | `lib\hub-rewrite.js:354-370,377-390`, `signatures\dev\puter-mock.js:108,147,167-177` |
| spreadsheet | 19 | collab + email mocks (dev only), collab family in src. | `spreadsheet\src\collab\api.js:41,78` |
| survey | 8 | strict CSP `connect-src 'self' https://*.puter.work` and `sv-<label>` naming; canonical passes the CSP. | `survey\src\respond\main.js:36,63`, `survey\src\data\collector-client.js:68,215` |
| teamchat | 44 | OWN validator: `u.protocol === 'https:' && u.hostname.endsWith('.puter.work')` — accepts exactly the canonical shape. | `teamchat\src\config.js:10-29,56` |
| vector-studio | 6 | protocol type documents "https *.puter.work origin" only. | `vector-studio\src\features\collab\api.js:37-89`, `vector-studio\src\features\collab\protocol.js:88` |
| video-studio | 7 | protocol: "Only https://<name>.puter.work is trusted". | `video-studio\src\review\api.js:32-104`, `video-studio\src\review\protocol.js:124` |
| whiteboard | 190 | most refs live inside the BUILT worker chunk (`public\worker\whiteboard-worker.js`, minified); src collab family is the standard one. | `whiteboard\src\collaboration\api.js:53-147` |
| wiki | 5 | collab family + dev constant. | `wiki\src\collab\api.js:56-129` |

Honest conclusion: **0 new per-app serve-time rules are needed** for the whole list —
every app's own handling either consumes the shim's canonical row (`dep.url`) or
hardcodes a packaged system name that `workers.exec` resolves server-side
(`field-service-email`, `invoicing-email`, `puter-meetings-rooms`, `wiki-dev` in dev
only). The two apps with OWN validators (teamchat, video-studio/vector-studio protocol
checks) accept the canonical shape as-is.

Caveats the census found (honest diffs, no rule added):
- `meetings\src\lib\rooms.js:108` trusts a BUILD-TIME `VITE_ROOMS_ORIGIN` override — a
  build-time constant can point outside *.puter.work; runtime fetches then bypass the
  shim. Product flag for the §4.5 hosting analysis, not a serve-time rewrite.
- `calendar\public\book.html:283` restricts contacts to well-formed page ids/tokens —
  good; depends on the server-side `cal-<user>` label arm (`lib\hub-workers-http.js`
  `parseW`, fixed 2026-10-22 in the alias round).

### Earlier (now-corrected) claims kept for traceability

| App | Old count | Old mapping |
| --- | ---: | --- |
| (the table's per-app "0" rows all hold per the census above) | 0 | shared `.puter.work` worker mapping |
| invoicing / hiring / shifts / contracts | 0 | shared `.puter.site` mapping to `/site/` |

Correction to the earlier table: hiring, shifts, contracts have **no `puter.work`
references in their own code** (they appear in the "no refs" list below together with
all easy-tier apps); their row in the old table was about `.puter.site` hosting links,
which the shared `/site/` mapping covers with no per-app rule. The old table's
counts stand; the reasoning is now backed by greppable evidence instead of assertion.

Apps with NO `puter.work` references in upstream src (worker-tier list shrinks): 3d,
accounting, api-client, assets, audio-studio, backgammon, building-design, cad,
cap-table, checkers, chess, circuits, contacts, contracts, crm, email, expense,
hiring, inventory, music-studio, notes, parametric, pdf, pos, presentation, projects,
records, shifts, solitaire, sudoku, tasks, time-tracking.

## 29. Peer relay proposal for review before implementation

### Review design — no peer code written

The SDK peer feature is real WebRTC: `PuterPeerConnection` wraps browser
`RTCPeerConnection`, carries data channels, and supports published media
tracks. Reuse the Apache-2.0 client implementation in
`puter-main/src/puter-js/src/modules/Peer/` unchanged. Implement the server
side only: WebSocket signalling compatible with `Peer/signalling.js`, invite
codes, guest grants, and `ensureTurnRelays` results. This proposal is for
review before any Peer implementation starts.

The signalling socket accepts the SDK's JSON envelopes:

- `server.create` with `authToken`, optional `anonToken`, `port`, and optional
  resume token; return `success`, `invitecode`, and a resume token.
- `client.connect` with `authToken` or an authorized `anonToken`, an
  `invitecode`, optional `port`, and optional resume token; return `success`,
  the peer owner, and a resume token, or a named error.
- Route `offer`, `answer`, `candidate`, and `bye` envelopes by connection id;
  server-to-client copies carry that id. Handle `release`, disconnect,
  reconnect, and resume/refusal messages as the SDK expects.
- Do not rewrite SDP or candidate contents. Do not implement data channels or
  media: WebRTC negotiates those directly between the SDK clients.

Invite codes are random, short-lived capabilities mapped to an active server
session and scoped to its owner/grants. Store only a hash, bind a guest grant
to one invite and allowed use, and make acceptance atomic so concurrent
accepts cannot create extra peers. Guests use the SDK's `anonToken` plus the
grant; they do not need a cad-home account. Revocation closes the signalling
session and expires the grant. Keep short-lived session state in memory for
the first version; persist no offers, candidates, offline messages, or media.
Log invite/accept/revoke/rate-limit metadata, never tokens or SDP.

`ensureTurnRelays` must return configured local relay servers or an empty
relay list. Default ICE uses host candidates, which permits LAN and
Tailscale-routed connections. Do not use public STUN/TURN. Support optional
self-hosted coturn credentials/configuration later; credential lifetime and
scope are server settings. A data-only relay fallback is optional future
work, separate from the initial WebRTC signalling server; it must not claim
to carry media. Start with the SDK's default data channel semantics: ordered
and reliable. There is no offline delivery in v1.

Review acceptance questions: agree that LAN/Tailscale host candidates are the
default connectivity policy; approve the in-memory invite/session lifetime
and guest-grant scope; and decide whether self-hosted coturn belongs in the
first release. No peer-relay code has been written.

