# CAD Home

Run the CAD app (from [HeyPuter/everything](https://github.com/HeyPuter/everything/tree/main/src/cad)) on your own computer, with every cloud feature served by that computer instead of Puter:

- **Accounts.** Only people you add can sign in. Passwords are stored as scrypt hashes. Invites and password resets can arrive by email.
- **Server drive.** Each person gets a private `Drawings` folder for saving and opening `.cad` and `.dxf` files from any device.
- **Sharing between accounts.** Share a file or a whole folder with another person on the server, view-only or editable.
- **Live co-editing.** Every `.cad` on the server drive is always live: everyone who opens it joins the same session, with named cursors, selections and avatars. The server saves continuously, and keeps safety snapshots you can restore.
- **Public share links.** Send a link that works without an account — view-only or editable — served from a separate public address (Tailscale Funnel), so nothing else is exposed.
- **AI assistant.** Chat inside the app that reads and edits the drawing, using your own keys: ChatGPT (OpenAI), Claude (Anthropic), DeepSeek, Kimi (Moonshot), GLM (Zhipu/Z.ai), Groq, Google AI Studio (Gemini), OpenRouter or local Ollama. Every call is logged.
- **Email.** SMTP through `nodemailer`: invites, password resets, share notifications — and an email API for hosted apps.
- **Hosted web apps.** Deploy your own small web apps (from a folder, via the admin panel or the command line). They run in a sealed frame with a Puter-compatible SDK: file pickers, key-value storage, AI, email and serverless functions.
- **Admin panel and account page.** Manage people, sharing, AI, email, apps and the server in the browser; everyone gets an account page.

The server's only dependencies are Node.js itself plus `ws` (WebSockets) and `nodemailer` (email). There are no native modules. All data stays in the `data` folder on this machine.

```
everything/
  platform/      the server (this repo): two listeners, the /api/, live sessions, hub, tests, data
    server.js    the server: two listeners, the /api/, live sessions and graceful shutdown
    users.js     add, remove and manage accounts from the command line
    apps.js      deploy, list, roll back and remove hosted apps from the command line
    lib/         the server modules (database, drive, sharing, live, ai, mail, apps, workers…)
    panel/       the admin panel and account page (static, no build step)
    sdk/         the SDK and launcher pages that hosted apps run on
    test/        server tests (node:test)
    data/        created on first run: cad.db, everyone's drawings, history and deployed apps
  upstream/      the app tree the hub builds every hosted app from (52 apps incl. cad)
    src/cad/     the CAD app — a local-fork commit since 2026-10-22 (owner's unification:
                 one app folder per app, no special casing; its original upstream version
                 stays recoverable in the clone's git history)
```

All apps — cad included — live in `upstream\src\<app>` now; the platform builds,
installs, serves and gates them through the same machinery.

## 1. Set up the server PC (once)

1. Install **Node.js 22.13 or newer** from https://nodejs.org (Windows, macOS or Linux). The server needs 22.13 for the built-in SQLite module and the permission model that sandboxes serverless functions.
2. Copy the `platform` folder and the `upstream` tree (which contains the apps, including the CAD app) to the server PC.
3. Open a terminal in the `platform` folder and run the setup. This needs internet once, to download the build tools and build the CAD app:

   ```sh
   npm run setup
   ```

4. Create your own account. You will be asked for a password, which is hidden as you type. The first account becomes the server admin:

   ```sh
   npm run user -- add yourname
   ```

5. **(Windows, required before enabling public member-deployed workers)** give
   workers their own node binary and an OS block on outbound connections, so
   even a genuine in-process bypass dies at the socket. In a terminal as
   Administrator, in the `platform` folder:

   ```sh
   mkdir data\bin 2>nul & copy "%ProgramFiles%\nodejs\node.exe" data\bin\node-worker.exe /y
   netsh advfirewall firewall delete rule name="cad-worker-net-block" >nul 2>&1
   netsh advfirewall firewall add rule name="cad-worker-net-block" dir=out program="<full path to platform>\data\bin\node-worker.exe" action=block enable=yes profile=any
   ```

   Check that it works (this must print **RULE OK** — it first proves the PC
   is online by making the same outbound connection with the normal
   `node.exe`, then proves `node-worker.exe` cannot):

   ```sh
   node check-firewall.mjs data\bin\node-worker.exe
   ```

   If the control probe cannot reach the internet either, the script prints
   **NO INTERNET — INCONCLUSIVE** instead of a verdict; other outcomes are
   RULE NOT SET UP (binary missing) and RULE FAILED.

   Point the workers pool at that binary by starting the server with
   `CAD_WORKER_NODE=data\bin\node-worker.exe`. Until this step is done,
   public member-deployed workers must stay OFF (the default) — Admin → Hub
   → `allow_public_user_workers` stays unchecked.

   **What the rule does NOT cover — loopback.** Windows Firewall does not
   filter loopback traffic, so a worker can still reach this server's own
   listeners (private and public) and other local services on this PC (for
   example a local Ollama or a database on localhost). The hub's own open
   surfaces are guarded against that: sign-in is rate-limited (10 wrong
   passwords per address+username in 15 minutes → HTTP 429, tested in
   test/login-rate-limit.test.js) and public worker routes have their own
   per-address cap — but treat this PC's local services as reachable by
   anything running on it.

## 2. Start it

```sh
npm start
```

It prints the addresses to use, for example:

```
  On this computer:     http://localhost:8080/
  On your network:      http://192.168.1.50:8080/
  Public listener:      http://127.0.0.1:8081/  (share links and public apps only)
```

Open the network address in a browser on any computer, tablet or phone on your home network, then select **Sign in** at the top right. Save with **Save as → Server drive**; **Open** lists the drawings on your server drive.

To use another port, start it with `PORT=9000 npm start`. On Windows PowerShell, use `$env:PORT=9000; npm start`.

If other devices cannot connect, allow Node.js through the server PC's firewall. Windows asks the first time you run `npm start`; choose **Private networks**.

### Safely backing up the data folder

`data\` holds everything: `data\cad.db` (accounts, shares, the hub's app
registry, per-user app data), the users' file trees, and work-in-progress like
run logs. **Never copy `data\` while the server is running** — the database
writes sidecar files (`cad.db-wal`) continuously, so a copy taken mid-run can
end up half-written.

Stop the server first (`Ctrl+C`), then copy the folder — or, from any state
(including while the server is running), write one consistent single-file
snapshot with the bundled tool:

```sh
node tools/db-backup.mjs
```

It writes `data\backups\cad-<stamp>.db` with every committed record folded in
(no sidecar files involved). Give a different output folder as the argument
(`node tools/db-backup.mjs D:\backups`) if you keep backups off the server
disk.

On a healthy shutdown the server also folds the WAL back into `data/cad.db`
itself, so a plain folder copy taken after a clean stop is complete too.

If the database file is damaged (the server refuses to start with
`database disk image is malformed`), the startup check makes a byte-for-byte
copy into `data\_dbrecover-...\` **before** it refuses to continue — do not
delete that folder; it is your last working copy. The server never
automatically deletes or rewrites it.

## 3. Reach it from anywhere (Tailscale)

Accounts are Tailscale-only: the server is never opened to the whole internet. Install [Tailscale](https://tailscale.com) (free for personal use) on the server PC and on each person's device, and share the server PC with the people who should have access.

Run these two commands once on the server PC — they survive reboots until you turn them off:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:8080
tailscale funnel --bg --https=8443 http://127.0.0.1:8081
```

- **Serve** puts the app on your tailnet at `https://<server-pc-name>.ts.net/`. Only devices you allow reach it. Sign in and use everything here.
- **Funnel** publishes the *second* port (8081) to the internet at `https://<server-pc-name>.ts.net:8443/` — but that port only serves share links, public apps and nothing else. It never reads sign-in cookies, so a stranger with the address gets nothing. You only need Funnel if you want public links or public apps.

`tailscale serve status` shows what is currently published. Use `tailscale serve --https=443 off` / `tailscale funnel --https=8443 off` to take either down.

### Telling the server its own addresses

For links in emails, share-link URLs and the Funnel health check, the server needs to know both addresses. Set them in **Admin → Server** (Private address, Public address). Environment variables take precedence if you prefer them: `CAD_PRIVATE_URL` and `CAD_PUBLIC_URL`.

The Admin → Server page also shows the exact Tailscale commands with your current ports, copy-paste ready.

### HTTPS without Tailscale (optional)

Browsers enable a few extras only on secure connections: the app working offline after one visit, saving back to the same file on the device, and the system clipboard between drawings. Over plain `http://192.168…` these extras are off, and everything else works. If you have a certificate and key, start the server with them:

```sh
CAD_TLS_CERT=/path/cert.pem CAD_TLS_KEY=/path/key.pem npm start
```

## 4. Accounts and people

Command line (changes apply immediately, even while the server runs):

```sh
npm run user -- add sam                        # create an account and choose their first password
npm run user -- add sam --admin --email s@x.com
npm run user -- passwd sam                     # change a password (signs them out on every device)
npm run user -- remove sam                     # remove the account; their drawings are kept in data/files/sam
npm run user -- remove sam --delete-files      # …and delete their files, shares, links and app data
npm run user -- admin sam [--off]              # grant or revoke server admin
npm run user -- host sam [--off]               # grant or revoke "can host apps"
npm run user -- email sam sam@example.com
npm run user -- list
```

In the browser, **Admin → People** does the same plus **Invite by email**, which sends a link the person uses to pick a password (valid 7 days). People manage their own profile, password, devices and connected apps at **Account** (in the CAD app's account menu, or `/account/`).

## 5. Sharing between people

Select **Share** in the title bar (or run `SHARE`) while a server `.cad` drawing is open:

- **People tab**: give another person on the server view or edit access to the drawing — or to a whole folder, which covers everything inside. They find it under **Shared with me** in the Open dialog. Editors can save changes; the shared root itself cannot be deleted out from under you. The other person gets an email notification if email is set up.
- **Link tab**: create a public link (view-only or editable) that works without an account, with optional expiry (1/7/30 days). Links can be revoked at any time, which immediately disconnects everyone using them.

`.dxf` files cannot be co-edited; the Share dialog offers to save a copy as `.cad` first.

## 6. Live co-editing

A `.cad` file on the server drive is always live: when two people open the same drawing, they edit the same session — named cursor arrows and selection outlines in each person's colour, avatars in the title bar, and a status chip (Live · Saved / Saving… / Reconnecting… / View only).

- The server saves continuously (about 2 seconds after the last change, at most every 10 seconds while editing). There is no explicit save step; `SAVE` shows the status and forces an immediate flush.
- If the server can't write (a full disk, say), everyone sees a persistent "Changes aren't being saved on the server" banner until it recovers.
- Undo only reverts your own changes — if someone else already changed what you're undoing, that part is skipped.
- A drawing that is open live cannot be overwritten by a plain upload (the server answers 409), and deleting it closes the session for everyone.
- **Version history** (application menu) lists automatic safety snapshots the server keeps — on room open, every 30 minutes of activity, and before a restore — newest 30 per file. Restore brings an old version back and everyone in the drawing gets it.
- Someone with view-only access sees everything live but cannot edit.

## 7. Public links and guest mode

Anyone with a link opens the drawing at `https://<public-address>/s/<token>/` — no account, works over the Funnel from a phone on cellular. View links see live changes and cursors but can't edit; edit links can join in and are asked for a display name. The guest view hides sign-in, the server drive, Share, Version history and the Assistant; Export and local Save As still work, so a guest gets a copy. Guests appear to others as "<name> (guest)".

Anyone with an edit link can change the drawing — that's the point of a link — so share edit links carefully and revoke them when done. Safety snapshots (above) are the recovery path.

## 8. AI

Configure providers and API keys in **Admin → AI**: OpenAI, Anthropic, DeepSeek, Kimi (Moonshot), GLM (Zhipu/Z.ai), Groq, Google AI Studio (Gemini), OpenRouter and local Ollama (no key). For Groq, Gemini and OpenRouter, paste a key from console.groq.com/keys, aistudio.google.com/api-keys or openrouter.ai/keys. Fetch each provider's model list, tick the ones to enable, and optionally set prices per model to see estimated costs.

Inside the CAD app, open the **Assistant** panel (or run `ASSISTANT`, alias `AI`). It can look at the drawing and edit it: info, find, add, update, delete, transform (move/rotate/scale/mirror/copy), layers, select and zoom. All edits in one reply are a single undo step; locked layers are respected; in live drawings the edits sync like any other edits. Every call is logged in `ai_usage`, and Admin → AI shows totals per person, model and day with CSV export. There are no usage caps.

## 9. Email

Set up SMTP in **Admin → Email** and send a test. With email on: invites, password resets and share notifications are sent from the server; without it, those features explain where to set it up. Every message is logged in `email_log` (no bodies, just who/what/when).

## 10. Hosted web apps

People with the **can host apps** flag (Admin → People, or `npm run user -- host sam`) can deploy small web apps. Admins always qualify.

- **Deploy**: Admin → Apps → Deploy folder picks a folder with an `index.html` (plus whatever it needs), or use the command line:

  ```sh
  npm run app -- deploy parts-catalog ./parts-catalog --public --title "Parts catalog"
  npm run app -- list
  npm run app -- rollback parts-catalog
  npm run app -- remove parts-catalog
  ```

  The previous version is kept for one-click rollback. Deploying to the same name replaces it.
- **Run**: private apps at `/apps/<name>/` (sign-in required), public ones also at the public address `/p/<name>/`. The app runs in a sealed frame — it cannot see CAD cookies, localStorage or other people's data, and it can only reach your files through pickers.
- **SDK**: apps use a small Puter-compatible SDK (`puter.fs`, `puter.kv`, `puter.ai`, `puter.email`, `puter.ui.showOpenFilePicker/showSaveFilePicker`, `puter.functions`). Picked files are grants, listed under **Account → Connected apps**, where they can be revoked. Key-value values are ≤256 KB; each app's per-user space is 2 MB.
- **Serverless functions**: an app folder may contain a `functions/` directory with `functions/<name>.js` files exporting `default async (request, ctx) => response`. They're reachable at `/fn/<app>/<name>` — private with a token, and on public apps also anonymously (webhooks). Each app gets one sandboxed child process: Node's permission model blocks file writes, child processes, workers, addons and WASI; the function reaches the server only through its `ctx` (kv, userKv, ai, email, env). Timeouts (30 s default, settable in Admin → Server), kill and restart, 4 concurrent calls and a queue of 50 per app. `console.*` shows up in Admin → Apps → Logs.

> **Functions can use the network.** The sandbox restricts files and processes — **not** network access. A serverless function can reach the internet and your LAN. Only give "can host apps" to people you trust.

## 11. The hub — the 50 apps from HeyPuter/everything

The [HeyPuter/everything](https://github.com/HeyPuter/everything) collection (49 apps + CAD) runs on this server through the hub. The clone lives at the **everything dir** (default `../upstream` next to the platform folder, change with the Everything dir setting in Admin → Hub) and stays **pristine**: apps are never edited, only rebuilt (`git -C upstream pull` to update), and every cloud touchpoint is exchanged when files are *served*, not in the source.

**Layout on this server:** `/` opens the hub (a redirect to `/hub/`, each person's app grid — CAD is listed there like any other app and does not own the root any more). Signed-out visitors get the hub's own sign-in form right there (no JavaScript, works in any browser); apps live at `/h/<name>/` (the `/apps/` prefix belongs to the older hosted-apps feature), and the shim is at `/hub/puter.js`.

```sh
npm run hub -- status            # clone state + installed apps + checks
npm run hub -- list
npm run hub -- install <name>    # one at a time: npm ci/--ignore-scripts, build, import, verify
npm run hub -- update <name>     # rebuild after pulling the clone (--force to redo a commit)
npm run hub -- remove <name>
npm run hub -- install <name> --from <dist-folder>   # import a build made elsewhere
```

`build-all` resumes by itself: state and results land in `data/hub/build-state.json`, already-built apps are skipped with `already built … — use --force to rebuild`, and a crashed or interrupted run simply continues where it stopped. The file is plain UTF-8 JSON written by node — edit it (if ever) with node or a byte-clean editor, not PowerShell's `utf8`, which adds a BOM that makes the JSON unparseable and forces a full rebuild.

Install rules: setup-time only, always `npm ci --ignore-scripts` (or `npm install --ignore-scripts` when the app ships no lockfile) inside the clone, one app at a time with a 3 GB Node memory cap, `--prune` deletes node_modules after the build, and the clone must come out `git status --porcelain` clean or the install aborts. Only build output is imported, into `data/hub/apps/<name>/` (icons into `data/hub/icons/`); the previous build is kept until a new one is fully in place.

**Serve-time rewriting** (all of it provable, none of it in the app's source):

- `https://js.puter.com/v2/…` script tags — and the same URL built into app bundles (chess, checkers, backgammon and 3d load Puter from their own code) — become `/hub/puter.js`, the local shim.
- External `<script src>` (Plausible analytics in 8 apps, CDN bundles) and external `<link>` (canonical, preconnect, CDN stylesheets) are stripped and logged; the Admin → Hub **Scan** button lists every external URL a build contains, so nothing is hidden.
- PWA manifests with absolute paths (`start_url`, icon srcs) get the `/h/<name>/` prefix; vite `--base` is forced the same way for apps without relative paths.
- Apps that call `puter.*` anywhere still only ever talk to this server (same origin, `connect-src 'self'`). Signatures also calls the admin-configured guest listener while preparing signing links; only that app's CSP adds the configured guest origin, read from Admin -> Server settings.

**Strict CSP:** every HTML response carries `default-src 'self'`, `connect-src 'self'`, hashed `script-src` (each inline script's hash, matched the way the HTML preprocesses lines), and reports violations to `/hub/csp-report` (viewed in Admin → Hub). Violations after using an app = the app tried to load something remote; an empty list = it runs from this server only. Per-app additions (e.g. `wasm-unsafe-eval` for Pyodide) are allowed later, per app, never globally.

**The shim** (`/hub/puter.js`, a real hand-written file — no AGPL backend code, the upstream SDK it mirrors is Apache-2.0 and the note stays in the file) grows per phase. In this phase it provides, with method names and return shapes matching the upstream SDK:

- **`puter.fs`** — read, write, mkdir, readdir, stat, delete, rename, move, copy, space, getReadURL, upload. Relative paths resolve into the app's **own data folder**; rooted paths (`/`, `~`, `/<your own username>/…`) are aliases of your Drive — for details see *Where app data lives* below.
- **`puter.kv`** — get, set, del, list, add, incr, decr, update, expire, expireAt, flush, with the same key (1024 B) and value size (399 KiB) limits the SDK documents, including `MAX_KEY_SIZE`/`MAX_VALUE_SIZE`.
- **`puter.ai.chat`** — all call shapes (prompt string, string + media, messages array, options with `stream`/`model`/`temperature`/`max_tokens`, image blocks with data URIs), streamed chunk shapes included. It answers from this server's own AI providers (Admin → AI); cloud model names are aliases configured there. **Every hosted app gets the same AI surface the CAD assistant uses** — measured per app in the generic functional gate (`ai=true`; the gate points `hubAiDefaultModel` at its test provider, CAD's own adapter resolves the same provider ids directly), so "AI works" is no longer a CAD-only property.
- **`puter.ui`** — open/save file pickers (an inline overlay on the app page, no popups, no external assets, cancel resolves undefined exactly like the SDK), the alert/prompt dialogs, window-title handling and the `onLaunchedWithItems` no-ops carried in the gap ledger below.
- **Drive consent** — a mutating `puter.fs` call on a Drive path this app has no grant for opens the in-page consent overlay (Allow/Deny, the wording names the app and the folder); Allow stores a revocable grant and retries once. See *Where app data lives*.
- Everything else (`hosting`, `workers`, `net`, `email`, `perms`, `peer`, sharing/login flows) fails with an explicit, named error rather than pretending — every one of those is an entry in the gap ledger or a documented local equivalent.

**Which apps are served:** Admin → Hub switches apps on or off, and each app is either for everyone (default) or restricted to a named list of accounts, enforced on the home page and at serve time. `node build-hub.mjs scan` reports, straight from each app's source, which `puter.*` calls it makes and therefore its tier — 23 apps need only what this phase provides and are installed with `node build-hub.mjs build-all [--prune]` (state and results land in `data/hub/build-state.json`, so a batch can resume).

**Why apps run on the same origin as the server:** strict CSP, and the shim's origin-relative API paths, need it — and it keeps configuration zero. Same-origin is a *namespace, not a security boundary*; the actual protections are: no upstream code is ever modified (every swap is re-derived at serve time and checkable with the Scan button), all mutating API calls require `X-CAD-Request` plus a same-origin `Origin`/`Sec-Fetch-Site` check, cookies are HttpOnly + SameSite=Strict, and every install is admin-approved. Anything a *user* authors (published docs, embeds, user SVG) never renders on this origin — it goes to the public listener or a sandboxed frame in later phases.

Counted from the real-Chromium load pass over all 23 installed apps (re-run
`node browser-smoke.mjs load` + `node _smoketable.mjs` after any mass update):
**23/23 render; over every request they made, not one went to an external
origin; 0 CSP violations; 0 uncaught errors; 0 failed requests; exactly 5
non-200 responses — the same-origin first-run 404s listed in the table above.**
String counts over the builds agree and include everything, not just runtime:
576 distinct absolute-URL strings on disk, overwhelmingly *not* runtime paths
(OOXML namespace URIs inside generated documents, the apps' own marketing
domains in prose, licence links). The genuinely fetched external origins that
remain are the ones the serve-time rules already cover: the lazy
`js.puter.com` SDK tag (chess/checkers/backgammon/3d), rewritten to the hub
shim, and stripped analytics/CDN tags, every one logged for the Scan button.
**Recommendation:** keep serving from `/h/<name>/` on this one origin. Per-app
origins (subdomains) would buy nothing here — same-origin is documented as a
namespace, not a boundary, and every actual protection listed above would have
to be rebuilt per origin (cookies, CORS, TLS wildcard, CSP) while stripping the
shim's zero-config relative paths. The observed request behavior is the proof:
no app *asked* for anything but this origin.

### Where app data lives (Phase 2)

Every hub app keeps its own files in `data/hub-users/<person>/<app>/` — on the drive where this server stores its data, inside your account's own folder space. They count toward your storage quota and the Admin → Server backup, and **Account → Hub app data → "Export my hub app data"** zips them up (per app folder, with a `data.json` of that app's kv pairs). Removing an app does not delete its folder; revoking grants does.

Path model, exactly:

| What the app says | Where it lands | Who may say yes |
| --- | --- | --- |
| Relative (`report.json`, `data/x.db`) | the app's own data folder | no grant needed — it is the app's space |
| `~`, `/`, `/<your own username>/…` | your Drive (`data/files/<person>/`) | only after you picked it |
| `../`, another person's name, `C:`, backslashes, `..%2e` and friends | rejected | — |

**Grants** are what let an app touch Drive paths: you pick a file (exact file, read on open / read-write on save) or a folder (subtree) in the app's picker, and that grant persists until you revoke it in **Account → Hub app data**. Revoked means refused at once — the picker's own listed grants and every later call. Grants never cross apps: app B cannot ride app A's grant, and person 2's session never sees person 1's app data.

**Read URLs:** `fs.getReadURL` returns a short-lived (`≤ 24 h`), HMAC-signed URL on this same origin bound to the person, the app, the path and an expiry. It streams the file bytes without a session; a wrong or expired token is a plain 404.

**Apps that write Drive paths on their own** (not through the `puter.fs` write you granted via a picker) still never get silent access: the server refuses the write with a structured grant request, and the app's page shows the one-time consent overlay — *"chess" wants to save into Documents/…* — with explicit **Allow** / **Deny**. Allow creates exactly the same revocable grant the Account page lists (source `consent`); Deny hands the app the ordinary no-permission error, as if no overlay had appeared. Sandbox writes never prompt. Verified end-to-end per app in the browser (`node browser-smoke.mjs consent`: overlay mounts on the first Drive write, Allow lands the file in `data/files/<person>/Documents/`, the grant silences repeat writes to the same file, the Account revoke re-arms the prompt, Deny refuses).

Which apps can write outside their own data folder, from their source:

| App | How it reaches the Drive | Status | What you see |
| --- | --- | --- | --- |
| audio-studio | export writes `/<person>/AudioStudio/…` directly | installed | the consent overlay, once per path until revoked |
| projects, music-studio | "Save as…" flows through `ui.showSaveFilePicker` — the folder you pick in that dialog **is** the consent, granted under source `picker-save` | installed | the pick dialog itself; the file lands where you chose |
| video-studio | export writes `/<person>/Videos/…` directly | workers tier, not installed yet | the consent overlay, same rule |
| spreadsheet | "Save to Drive" via `ui.showSaveFilePicker` | workers tier, not installed yet | the pick dialog itself, same rule |

No other installed app writes outside its own folder — checked for every app the scan reports as touching `fs`, not just the named ones (email composes to the app's own data folder by design; presentation, notes, cap-table, pos, crm and survey save relative paths only). Every path above is refused before grant, never auto-granted, and revocable in **Account → Hub app data**.

### The gap ledger (Phase 2)

Nothing here: everything an installed app asks for is answered, and where the answer is "not yet", the app gets a named error and the gap is listed. The current entries:

| Gap | Who hits it | Local behaviour | The way to enable it |
| --- | --- | --- | --- |
| `ui.onLaunchedWithItems` / `ui.onItemsOpened` never fire | cad, building-design, pdf, records | no-op; the app runs without the "opened from the file manager" path | Windows shell integration phase |
| Window management beyond the pickers (`ui.launchApp`, picture-in-picture) | meetings | named "not yet" error when called | desktop-shell phase |
| Generative engines (`txt2img`, `img2txt`, `txt2speech`, `speech2txt`, `txt2vid`) | presentation+ (only if an app calls them; none of the 23 do) | `engine_missing` with the exact engine to install | see *Engines* |
| Sharing files to other people / email from hub apps | none of the 23 | named "managed in the CAD app" error | hosted-apps sharing phase |
| `puter.peer` (online play over Puter's WebRTC peer channels) | chess, checkers, backgammon — online mode only; offline play is complete | named "not yet" error when Online is clicked (the SDK is loaded lazily there, so offline play never touches it) | LAN peer phase (local signaling on this server, no external rendezvous) |
| Upstream's `src/assets` (AssetDesk) does not build | assets tier table | cannot be installed until upstream commits its `src/` | upstream fix |

### The app tiers, re-derived from source

The Phase 0 inventory was written conversationally and never committed; this
table re-derives it with `node build-hub.mjs scan`, which reads each app's source
and reports exactly which `puter.*` calls it makes, and reconciles it with
`node build-hub.mjs status` (installed vs not) and the real-Chromium smoke
(`node browser-smoke.mjs load`, columns: loads / CSP violations / external
requests / failed+404 requests / uncaught errors). **Totals: 51 scanned = 23
installed (10 works + 13 loads-not-exercised) + 28 not installed (1 unbuilt, 5
partly, 22 does-not-yet).**

| Tier (scan) | Installed | Smoke status | Apps |
| --- | --- | --- | --- |
| easy | yes (10) | **works** — loads and proven through the real UI, surviving reload + server restart (persist pass) | contacts¹, crm, music-studio, notes, pos, presentation, projects, solitaire, sudoku, tasks |
| easy | yes (13) | loads, not exercised — renders clean (0 externals, 0 CSP hits, 0 uncaught errors); data flows not driven by a recipe yet | 3d, accounting, audio-studio, backgammon, cap-table, checkers, chess², circuits, expense, inventory, parametric, survey, time-tracking |
| easy | no | cannot build — upstream never committed `src/` | assets |
| partly | no | — | building-design, cad, pdf, records (only the "opened from the file manager" entry point never fires → shell integration phase); meetings (window UI beyond pickers) |
| partly | no | — | chess, checkers, backgammon offline is complete; **Online** needs `puter.peer` (the SDK is loaded lazily there, so the load pass never touched it) |
| does not | no | — | api-client (net.tls/net.Socket); calendar, email (SMTP/perms phases); childcare, documents, field-service, fleet, help-desk, invoicing, legal, photo-studio, property-management, signatures, spreadsheet, teamchat, vector-studio, video-studio, whiteboard³, wiki³ (workers — Phase 3); contracts, hiring, shifts (hosting — publishing phase) |

¹ contacts was imported in Phase 1; it is easy tier except the never-firing
`onLaunchedWithItems`. ² chess/checkers/backgammon scan `easy` (they only call
`auth.signIn`) but their **Online** mode is peer-dependent — recorded as easy-
tier installs whose one feature is the named peer gap. ³ whiteboard and wiki
also want `net.fetch` — hard-refused by the no-external-calls rule until a
documented local proxy exists.

Where the older survey was wrong, for the record:

- The Phase 0 audit (conversational, never scan-backed) listed
  **txt2speech in 3d, audio-studio, notes and pdf.** The source grep
  (`node _ai-survey.mjs`, `puter.ai.\*` over all 51 apps' src, no tests/dist)
  shows TTS lives in **documents** (`src/lib/puter.js:355`) and
  **video-studio** (`src/media/tts.js:36`), both workers-tier, and that
  neither 3d, audio-studio, notes nor pdf calls any generative engine beyond
  `ai.chat` where the scan already says easy. The call sites for the record:
  3d → `src/assistant/ai.ts:71` (ai.chat only); audio-studio → none;
  notes → `src/ui/assist.js:11` (ai.chat only); pdf → none. Which scan was
  wrong: the Phase 0 audit (no data behind it); the build-hub tier scan was
  right all along, and the labels follow it.

### How any of this is verified

- `npm test` — 109 checks over the data layer and the worker runtime, end to end (fs sandbox/Drive paths and grants incl. the consent request shape, kv contract incl. the `list` prefix semantics, AI chat shapes, import/export; Phase-3 worker registry/pool/limits incl. the network-bypass and env-hop tests; repo ASCII hygiene).
- `node smoke-hub.mjs` — **35/35 smoke checks, HTTP-only**: it exercises the server's endpoints (accounts, fs, kv, grants, statics, CSP headers) over plain requests. No app is ever opened in it, so it proves the backend contract, not what an app renders.
- `node browser-smoke.mjs` — real Chrome against the real server, which is where app-side truth lives:
  - **pass A (loads):** every installed app is opened through the shim; all 23 render, and a navigation that never settles is a **failure** unless the app is on the measured long-poll list below. Per-app numbers from the last full run (SW guard on):

    | Apps | renders | external requests | unexpected 404s | nav timeout |
    | --- | --- | --- | --- | --- |
    | 3d, accounting, backgammon, cap-table, checkers, chess, contacts, crm, inventory, parametric, pos, presentation, projects, survey, tasks, time-tracking | yes | 0 | 0 | — |
    | audio-studio, music-studio, solitaire, sudoku | yes | 0 | 0 | **timed out — excused, measured (below)** |
    | circuits | yes | 0 | 1 | — |
    | expense | yes | 0 | 2 | — |
    | notes | yes | 0 | 2 | — |

    - **One definition of a "failed request"**, used for every smoke row in
      this section: (a) any request to an **external origin** — always
      counted, always expected to be zero — and (b) a request that failed
      abnormally (network error or HTTP ≥ 500). Same-origin first-boot 404s
      are *expected first-run probes*, named per app rather than hidden —
      the five above are exactly that: `circuits` →
      `Libraries/My components.circuitslib`, `expense` →
      `expenses-data/reports.json` + `statements.json`, `notes` →
      `notes/library.json` + `trash.json`; each app probes for a file it
      creates on first save. Zero CSP violations, zero uncaught errors, zero
      "not available on this server" errors (chess/checkers/backgammon load
      the shim only when *Online* is clicked, and the smoke pokes them).
    - **The four navigation timeouts, measured.** Each of them runs a
      recurring account/sync poll through the shim — `auth.isSignedIn()`
      resolves to `GET /api/hub/auth/whoami`, paired with kv reads/writes —
      landing more often than puppeteer's 500 ms idle window, so
      `networkidle2` never fires, while **zero requests are ever stuck in
      flight** and the page is fully interactive (element counts 425–2246;
      evidence tool `_netchurn.mjs`). Solitaire draws the whole board on a
      canvas, which is why it shows only 63 characters of text ("Solitaire /
      Moves 0 / Klondike · Draw 1 / Undo / New 24 / Powered by Puter") while
      all 237 elements are live. These four sit on the smoke's `LONG_POLL`
      exemption list with exactly this recorded reason; any other app that
      times out now fails the run.
  - **pass B (persist):** 10/10 sampled apps create data through the real UI, show it again after reload, and survive a server restart (server-side + UI-visible). Every `persist` run first wipes the smoke user's app data, so recipes always prove a true first run — onboarding dialogs included.
  - **consent drive-through:** 9/9 (hardened overlay: closed shadow root + trusted-input gating — see *Where app data lives*).

### Service workers: measured, with the guard proof

Eleven installed apps ship a `sw.js`. Serve time prepends a cache guard
(lib/hub-rewrite.js) to every one of them, and the smoke verifies each
served `sw.js` is HTTP 200 + `nosniff` + guarded and carries the app CSP
(`default-src 'self'; script-src 'self'; connect-src 'self'; object-src
'none'`). The probe: after the app loads and its worker activates, fetch
`/api/hub/apps` once online, wait, then refetch it **offline** — an SW that
had cached hub APIs would still "work" offline, which is exactly the bug
the guard removes.

| App | sw.js shipped + guarded | registers at load? | probe, guard **on** | probe, guard **off** (control run) |
| --- | --- | --- | --- | --- |
| accounting | yes | yes | cached none · offline **rejected** | cached the API · offline served-from-cache |
| crm, inventory, pos, projects, tasks | yes | yes | cached none · offline **rejected** | cached the API · offline served-from-cache |
| solitaire | yes | yes | cached none · offline **rejected** | cached the API · offline served-from-cache |
| contacts | yes | **no — the app's own rule** | not applicable | not applicable |
| audio-studio, time-tracking | yes | no (conditional registration, never at load) | not applicable | not applicable |
| expense | yes | no — its own `isDevHost` check skips SW registration on 127.0.0.1 | not applicable | not applicable |

Both probe columns are real runs (control run: `BROWSER_SMOKE_SW_GUARD=off`
in browser-smoke.mjs; the flag pins the guard back on for every normal
run). Under the guard the seven registering workers cache nothing from
`/api/hub/*` and the offline re-fetch is rejected; without the guard the
same apps cache the API response and serve it offline — the problem is
real and the fix removes it. `contacts` skips registration because its
upstream code registers the offline worker only outside an app shell
(`isPuterApp()` is true here since the shim sets `puter.env = 'app'`);
kept as designed and listed rather than normalized away.

### Worker runtime hardening, in short (Phase 3)

- **Workers are forked Node children** (one pooled child per worker, idle
  evicted after 5 min) behind the server. Inside: permission-gated
  filesystem (`--allow-fs-read` scoped to the staged worker only), a resolve
  hook that denies `net/http/https/tls/dgram/dns/http2/cluster/
  child_process/worker_threads/inspector/module` (both `node:x` and bare
  names, for `import`, dynamic `import` and `createRequire`), the three
  bypass doors (`process.getBuiltinModule`, `process.binding`,
  `process.mainModule`) neutralized **before any worker code runs** —
  `getBuiltinModule` really did hand out `node:net` and open a TCP socket on
  Node 24 without the fix — and `fetch` / `WebSocket` / `XMLHttpRequest`
  deleted from the realm. The test suite drives a worker to attempt a real
  connection to a live loopback listener: the attempt fails and the
  listener sees zero connections.
- **The undici global dispatcher is locked too** (found by testing on Node
  24.21, after the doors above were closed): merely *touching* the undici
  classes — consuming a `Response` or `Request` body — boots the bundled
  undici and installs `Symbol.for('undici.globalDispatcher.1')` on
  globalThis, whose `dispatcher.request({ origin, path })` opened a real
  socket with fetch deleted and the permission model on. The preamble now
  boots undici itself, locks every `undici.*` symbol to a frozen
  `undefined`, and a durable allow-list test freezes the exact global
  surface of the worker realm — a Node upgrade introducing a new global
  fails the test on purpose and forces review.
- **Best-effort by design, and labelled so:** the in-process gates are the
  convenience layer; the **real control is the OS firewall rule** blocking
  outbound connections from the dedicated worker binary
  (`data\bin\node-worker.exe`) — a runnable setup step with a check command
  at README §1 step 5 (Linux: systemd `IPAddressDeny=any`). **Public
  member-deployed workers stay OFF until that step is done.** Measured
  subject: Node v24.21.0.
- **Environment:** a worker child receives an explicit allow-list env —
  `PATH`/`PATHEXT` plus the Windows spawn floor Node insists on, and
  `NODE_OPTIONS` pinned empty (no flag or preload smuggling); never the
  server's `process.env`. A test plants secret-shaped variables in the
  parent process first and proves the child sees none of them; nothing
  SMTP-, key-, token- or password-shaped can exist in the worker's eyes.
- **Measured budgets** (Node 24.21.0, evidence `_perf-workers.txt`): cold
  exec — spawn to first response — **265 ms** wall (child boot 220 ms);
  warm execs **p50 = 9 ms / p95 = 11 ms**; steady pooled-worker RSS
  **≈ 50 MB** (parent server 61 MB in the same run). Eight pooled workers
  fit the 512 MB pool budget comfortably.
- **Pool budget enforced** (`workers.pool_rss_budget_mb`, 512; fresh boots
  estimated at `workers.boot_rss_estimate_mb`, 64): a boot that would push
  the pooled children past the budget evicts the least-recently-used **idle**
  worker first (audit row `pool-evict`); only when nothing can evict does the
  call refuse with the named `worker_busy` 503, and a busy worker is never
  the victim. Tested end-to-end in test/hub-workers-pool.test.js.
- **Guest links address** (`workers.public_base_url`, Admin → Server
  settings): where guest-facing link builders point. Unset, the honest note
  is the rule: links name this listener's own address and are reachable only
  from networks that reach it — a loopback-only hub is LAN-only. Surfaces
  read it from `GET hub/workers/guest-base` (returns `base`, `origin`, and
  the note in either state). Signatures' stored guest sign links compose the
  public base with the worker's canonical hostname mapped through the
  `/w/host/<host-label>` public alias (serve-time rule `sign-guest-link`);
  with no public base configured the link keeps the honest canonical worker
  URL and a real out-of-system guest cannot open it (documented degrade).
- **Packaged system workers**: an app build/install copies the dist's
  `workers/<name>.js` files into server-owned rows (Admin → Hub shows them
  for approval), served at `/wr/app/<app>/<name>/`. A member's personal
  deploy can never shadow or delete one; bare-name exec resolves the
  packaged row first; a changed source resets public approval until an
  admin re-approves (`redeploy` audit row); an unknown `*.puter.work`
  exec target is the named `external_not_allowed` 403, never a silent
  pass-through. The first rows (calendar-email, field-service-email,
  invoicing-email, puter-meetings-rooms) install when those apps are
  built. Tested in test/hub-workers-packaged.test.js.

### `puter.env` across the installed apps: surveyed, and the recommendation

The shim answers `puter.env` with `'app'` (lib/shim/puter.js), the truthful
equivalent of running inside the Puter desktop — which is what this hub is.
Every installed app was run through a source survey (evidence:
`_env-survey.txt`, tool `_env-survey.mjs`) for real `puter.env` /
`isPuterApp()` branches; everything else these apps test (`import.meta.env`,
the Vite build flag) is unrelated.

| App | branch / what it does under `'app'` (this hub) |
| --- | --- |
| accounting | signOut() is a no-op; the Sign out menu item is hidden |
| audio-studio | registers a `puter.ui.onWindowClose` hook (also interface-guarded) |
| cap-table | skips the `isSignedIn()` probe and boots straight in; Sign out hidden |
| circuits | auto-loads the signed-in user; Sign in / Sign out buttons hidden |
| contacts | cloud store active without a sign-in gate; Sign out hidden; **skips sw.js registration** (documented above) |
| crm, expense, inventory, pos, projects, tasks, time-tracking | Sign out control(s) hidden |
| music-studio | sign-in prompts hidden; window-title sync through `setWindowTitle`, plus `onWindowClose` and `onLaunchedWithItems` hooks — each also interface-guarded, so they no-op where the shim lacks the interface |
| notes | starts straight in without the sign-in screen; Sign Out hidden |
| presentation | `canSignOut` false → button hidden |
| sudoku | `isHostedSession()` true → no sign-out button that could strand the player |
| survey | records `env` in its backend descriptor (metadata only, no behavior) |
| 3d, backgammon, checkers, chess, parametric, solitaire | no `puter.env` branch in app sources |

**Recommendation: keep `puter.env = 'app'`.** Upstream's meaning of `'app'`
is "the platform around us owns the session" — precisely this hub's model
(one session per person, sign-in/out at the CAD home page, not per app).
Every observed effect matches hub truth: implicit signed-in state, no
per-app sign-out, and desktop-only integrations that are interface-guarded
upstream and safely no-op here. The alternative (`'web'` + a signed-in
answer) would make apps show sign-in screens and per-app Sign-out buttons
that cannot work in a server-owned session — strictly worse. The single
behavioral difference (contacts not registering its SW) is already
documented above as a kept, deliberate difference.

### Engines (puter.ai's generative calls)

`puter.ai.txt2img / img2txt / txt2speech / speech2txt` answer honestly (`engine_missing`, with the message naming what to install) until the matching local engine is switched on in Admin → Hub. No external service is ever called: the engines themselves are the local install (Stable Diffusion for images, tesseract for OCR, Piper for speech, whisper.cpp for speech-to-text), each wired into the same no-external-calls rule. Until then the 23 easy-tier apps do not call any of them.

### Known honest differences (Phases 1–2)

| Difference | Reason | How to work around it |
| --- | --- | --- |
| App data folders auto-create missing parents inside the app's own space (puter makes you pass `createMissingParents`); on the Drive the strict puter behaviour is kept | easy-tier apps save to relative paths without mkdir-ing first, and inside its own folder the app cannot harm anything | none needed; noted here for honesty |
| A still-live external URL string in a bundle (scan-reported) stays blocked rather than rewired | wiring local replacements (Pyodide, tile packs) is its own phase | the CSP blocks the call at runtime and logs it |
| Apps that need hosting, workers, net, email or perms | the local worker runtime and packaged email workers are available; app-specific hosting and service wiring remain in progress | each app stays at "does not" until its own services and smoke gates pass; see `docs/phase3-workers-design.md` |
| Cloud model names in `puter.ai.chat` are aliases, not the actual models | no external calls allowed | Admin → AI enables models; Admin → Hub → "Hub AI (puter.ai.chat)" sets the Default model as `provider:model` (e.g. `openrouter:deepseek/deepseek-v4.1-flash-1017` — the id is listed verbatim in Admin → AI) and optionally an alias map; any unknown name a hub app asks for falls back to the Default model. The field's dropdown suggests exactly the enabled ids. |
| `auth.signIn` answers with the person's own session (they are already signed in to this server) | one server account per person, used everywhere | sign out/in on the CAD home page instead |
| music-studio's `puter.appDir()` resolves to `.` (its own data folder root) instead of real Puter's absolute `~/AppData/<app>/` | the shim's relative-path rule is the app's own space by design; appDir's absolute form needs a Drive grant here | none needed — saves land in the same place with or without the wrapper; only paths *printed* by the app could show the difference |

| Signatures' guest signing page is served from the public listener, and its worker PDF route returns only a token-mapped document file | the private app and anonymous signer use separate listener origins; public workers never receive general filesystem access | set the correct Guest links address in Admin -> Server; the worker checks its token and document record before the server reads the PDF |

## 12. The security model, in short

- **Two listeners, kept apart by socket.** The private one (port 8080) serves the app, the APIs, the admin panel and live sessions, and requires sign-in. The public one (port 8081, bound to `127.0.0.1`) serves *only* share links, public apps and their functions — it never reads the session cookie. If you never run the Funnel command, that port is unreachable from outside anyway.
- **Sign-in** uses secure httpOnly cookies plus a `X-CAD-Request` header on every API call; passwords are scrypt-hashed; sessions can be signed out per device.
- **Hosted apps** get a scoped bearer token (12 hours) handed over only after their frame announces it's ready. Tokens work only for that app and that person; public visitors get even less (no files, no key-value storage).
- **Hub apps** run with the session of the person who opened them, but scoped: relative paths land in that app's own data folder, and Drive paths only answer after the person picked them in the file picker (a *grant*, visible and revocable in Account → Hub app data). Grants stop honest apps and honest bugs from touching Drive areas nobody picked. **They do not stop deliberately hostile code**: an app's JavaScript runs on the same origin as the hub APIs, so code written to abuse its own session could read what the session sees. What does apply to hostile code is the strict CSP (no remote loads, provable by the Scan button), admin-approved installs, and every mutation needing the request header plus a same-origin check. The honest statement of this server's model is: *trusted-by-construction code, enforced at serve time; not a defence against compromised app code.*
- **Secrets** (API keys, SMTP password, app env values) live in the database. The browser is only ever shown a masked version (`••••`), and secrets never appear in logs.
- **Public apps** can't use AI or email unless the admin turns those on per app, and then only with a per-IP rate limit (default 30 AI calls and 5 emails per hour, editable in Admin → Server).
- Only admins can manage the server. The admin panel requires `is_admin` server-side and every change is written to an audit log.

## 13. Backups

Everything is in the `data` folder:

- `data/cad.db` — the database (accounts, sessions, shares, links, settings, logs, app registry). WAL mode means a raw copy can miss recent writes: either stop the server and copy the folder, or use **Admin → Server → Download backup**, which produces a consistent copy with `VACUUM INTO` while the server runs.
- `data/files/<name>/` — each person's drawings as normal files.
- `data/hub-users/<name>/<app>/` — each person's hub-app data folders (named in Account → Hub app data).
- `data/apps/` — deployed apps (site, functions and the previous version).
- `data/history/` — the safety snapshots.

Copy `data` somewhere safe from time to time. To keep the data elsewhere, set `CAD_DATA_DIR=/path/to/folder`.

The CAD app is an early alpha, so keep copies of important drawings.

## 14. Settings

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | Private listener port |
| `HOST` | `0.0.0.0` | `127.0.0.1` allows only this computer |
| `CAD_PUBLIC_PORT` | `8081` | Public listener (always bound to `127.0.0.1`) |
| `CAD_PRIVATE_URL` | | The private address as configured in Admin → Server (env wins) |
| `CAD_PUBLIC_URL` | | The public (Funnel) address as configured in Admin → Server (env wins) |
| `CAD_DATA_DIR` | `./data` | Where accounts, drawings, apps and history are stored |
| `CAD_MAX_FILE_MB` | `200` | Largest drawing that can be saved |
| `CAD_TLS_CERT`, `CAD_TLS_KEY` | | Serve the private listener over HTTPS |

Server settings edited in Admin → Server and Admin → AI (private/public URLs, public rate limits, function timeout, AI providers/models/prices, SMTP) are stored in the database and survive restarts.

## Keep it running

- **Windows:** create a Task Scheduler task that runs `npm start` in the `platform` folder **At startup**.
- **Linux:** add a systemd service, for example `/etc/systemd/system/cad-platform.service`:

  ```ini
  [Unit]
  Description=CAD platform (self-hosted server)
  After=network.target

  [Service]
  WorkingDirectory=/home/you/platform
  ExecStart=/usr/bin/node server.js
  Restart=always
  User=you

  [Install]
  WantedBy=multi-user.target
  ```

  Then run `sudo systemctl enable --now cad-platform`.

Shutting down gracefully (Ctrl+C, or stopping the service) flushes every open drawing to disk first. On Windows, closing the terminal sends no signal — give it a moment or check Admin → Overview that no rooms are open before killing it.

## Changing the app

Run `npm start` in `platform`, then `npm run dev` in `upstream/src/cad`. The dev server forwards `/api/` (including WebSockets) to port 8080. Run `npm run build` in `platform` (or in `upstream/src/cad`) to publish your changes.

All changes from the original app are app-side and additive:

- `src/local-cloud.js`: replaces the Puter SDK — auth, fs and kv over `/api/`, plus the live URL builder and guest-mode detection (`/s/<token>/` in the URL).
- `src/collab/` (new): `live.js` (the live session: connect, resume, pending ops, id leases, presence, reconnect), `ops.js` (drawing records → sync ops) and `presence.js` (peers, colours, cursors).
- `src/core/drawing.js`: small additive hooks — `opsListener` (local edit/undo/redo notifications), `applyRemote` (apply other people's ops without touching undo), undo that skips conflicts in live drawings, an injectable id source, `readOnly` support and reorder records.
- `src/editor/overlay.js`: a `drawRemote` hook that draws other people's cursors and selections.
- `src/ui/shell.js`: the Share button, peer avatars and the live status chip in the title bar.
- `src/ui/dialogs.js`: the **Shared with me** section in the Open dialog, the Share dialog (People and Link tabs), the "save a copy as .cad" helper and the Version history dialog.
- `src/app.js`: opening a server `.cad` joins its live session (the drawing loads from the session snapshot), Save-as of a live drawing, guest boot (skip the start screen, ask for a name), the closed-session dialog and the account menu entries.
- `src/ui/assistant.js` and `src/ai/tools.js` (new): the AI assistant panel and the drawing-editing tools it uses.
- `index.html`: no longer loads Puter's script.
- `public/sw.js`: never caches `/api/`; guests never install it at all.
- `vite.config.js`: the dev server forwards `/api/` to port 8080.
- Interface wording now says "server drive" instead of "Puter drive".

The CAD app is MIT licensed; see `app/LICENSE`.

## Known limitations

- Concurrent edits to the same object: the last change wins. There's no character-level merging inside text.
- Live editing covers `.cad` only. `.dxf` drawings need a `.cad` copy to share or edit together.
- Function sandboxing restricts files and processes but not the network.
- Anyone with an edit link can change the drawing. Safety snapshots are the recovery path.
- **nodemailer** (runtime dependency, SMTP): `npm audit` reported 15 advisories against 6.10.1, mostly **high** — GHSA-mm7p-fcc7-pg87, GHSA-c7w3-x93f-qmm8, GHSA-vvjj-xcjg-gr5g, GHSA-268h-hp4c-crq3, GHSA-wqvq-jvpq-h66f, GHSA-rcmh-qjqh-p98v, GHSA-p6gq-j5cr-w38f, GHSA-8m3c-c648-2xjj, GHSA-wmmp-3585-3rmp, GHSA-2x7j-588g-ccc2, GHSA-cc9r-2j5m-2m83, GHSA-6vj9-mwq6-2f5v, GHSA-8vvx-rff5-p5rq, GHSA-v53p-9fqp-m79j, GHSA-r7g4-qg5f-qqm2. Most are out of reach here (no OAuth2, no `raw` option, no `disableFileAccess` flows, no multi-credential transports, recipients come from local accounts), but the **addressparser denial-of-service pair (GHSA-rcmh/trailing GHSA-2x7j, GHSA-v53p)** and the **CRLF injection classes** are reachable through any attacker-supplied recipient address, and email sending is a real feature of this server — so instead of reporting-only, applied the non-breaking upgrade **6.10.1 → 10.1.7** (the transport/sendMail/jsonTransport API surface this server uses is unchanged across those majors; `npm audit --omit=dev` now clean; full suite passes).
