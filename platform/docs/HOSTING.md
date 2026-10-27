# Hosting this server

This is the short, ordered checklist for a fresh machine. The full feature
documentation is in [`README.md`](../README.md); this page is the operational
path to a server other people can use.

## 1. What the machine needs

- **Node.js 22.13 or newer** (the platform uses the built-in SQLite and the
  worker permission model).
- **Windows or Linux**. Windows has the tested worker-firewall path; Linux
  needs the equivalent outbound block for the dedicated worker binary.
- **Disk:** roughly 2 GB for the app builds and `data/` plus the engine models
  (OCR ~4 MB, Piper voice ~64 MB, Pyodide vendored in the repo). Allow more
  for people's files and backups.
- **Network:** a private LAN, or a private overlay such as Tailscale. Do not
  port-forward the private listener to the internet.
- **Chrome** is only needed for the browser acceptance tests, not for serving.

## 2. Fresh install

```sh
cd platform
npm ci
npm run setup                 # installs/builds the CAD app
npm run engines:install       # pinned OCR + Piper downloads, one time
node build-hub.mjs build-all   # builds the 51 apps from ../upstream (network once)
```

The app clone is a sibling folder, `../upstream` by default. It must be the
fork revision described in `README.md`; the server never edits it at runtime.
If the clone is elsewhere, set **Admin → Hub → Everything dir** after first
boot.

Create the first owner:

```sh
npm run user -- add owner-name
```

The first account becomes the server administrator. Then start it:

```sh
npm start
```

Open `http://<server-lan-address>:8080/`, sign in, and finish configuration in
**Admin**.

## 3. Configure before inviting people

- **Admin → Server:** private and public addresses, ports, and TLS if you have
  a certificate. Plain HTTP on the LAN works, but secure-context features
  (installable PWA, clipboard, service worker) need HTTPS; the session cookie
  gains `Secure` only when TLS is configured.
- **Admin → AI:** either re-enter a cloud provider key (OpenRouter is the
  documented default) **or** enable local Ollama and set the Hub default model
  to it. No model is downloaded by this repository.
- **Admin → Hub → Engines:** confirm OCR and speech are installed and enabled.
  Pictures are cloud-only; set an image model only if you intentionally want
  that provider called.
- **Admin → Hub → Vehicle lookups:** leave off unless fleet users need NHTSA
  VIN/recall lookups; it is the only optional internet egress for an app.
- **Admin → Email:** SMTP is needed for invites, resets and share mail.
- **Admin → Hub → Apps:** review which apps are enabled and who may see them.
- **Admin → People:** remove or disable any test/tool accounts; grant
  **can host apps** only to people you trust.

## 4. Firewall and listeners

- Open **8080** to the private LAN/Tailscale interface. The public listener
  (8081) is for share links and is bound to loopback by default; expose it only
  through a deliberate tunnel or reverse proxy.
- On Windows, follow README §1.5 to block outbound traffic from the dedicated
  worker binary and run:

```sh
node check-firewall.mjs data\bin\node-worker.exe
```

  Expect `RULE OK`. The normal server process is not blocked.
- Public member-deployed workers stay off by default. Leave
  `allow_public_user_workers` unchecked unless you have a specific reason and
  the worker firewall rule is proven.

## 5. Verify the host

```sh
npm run lint
npm test
npm run verify              # lint, suite, engines, hub HTTP smoke, fresh host
npm run verify:full         # adds browser engines/Pyodide/peer/chess and the
                            # installed-app smoke + infrastructure gate
```

`verify:full` runs the app checks against a throwaway copy of `data/`, so it
does not create test accounts or test files in the live database; it copies
only the gate evidence back. It needs Chrome and a populated `data/hub/apps`.

The current expected evidence is tracked in `README.md` §“How any of this is
verified” and in `verification/REPORT.md`.

## 6. Keep it running

- **Windows:** Task Scheduler → run `npm start` in this folder at startup.
- **Linux:** a systemd unit with `WorkingDirectory=<platform>`,
  `ExecStart=/usr/bin/node server.js`, and `Restart=always`; an example is in
  `README.md` under *Keep it running*.
- Put the machine on a UPS if it is the household server. SQLite WAL survives
  hard kills, but power loss is still power loss.

## 7. Backups and updates

- Everything is under `data/`: the SQLite database, each person's files, app
  data, history and installed apps. Stop the service (or use the SQLite backup
  command) before copying, then copy the **whole** `data` folder; do not copy a
  live `.db` without its `-wal`/`-shm` siblings.
- Keep at least one backup off the server. The repo's `data/` is gitignored;
  secrets are in the database, not in git.
- Update: stop the service, `git pull` for the platform, update the
  `../upstream` clone, `npm ci`, `npm run build`, re-run `npm run verify`, then
  start. Migrations run on open; take a backup first.
- Re-run `npm run engines:install` after moving the data folder to a new host
  (the binaries are not in git).

## 8. Known limits (not failures)

- No STUN/TURN: peer calls need both people to reach the hub (LAN or private
  overlay); no internet-NAT traversal.
- Peer grants and live calls are in memory; a hub restart ends them.
- Events are same-user only; a shared file does not push a different person's
  changes.
- Image generation is cloud-only and off until configured; `txt2vid` and
  speech-to-text are named 501s. OCR, Piper speech, and the 3d Python runtime
  work locally.
- `puter.hosting` / public app publishing is available but disabled until the
  owner enables it.
- NHTSA lookups are opt-in and return an offline message when off.
- The generic app gate proves boot/shim/storage, not every app feature; those
  are tracked with the `works` / `boots` / `untested` / `does not` vocabulary
  in README.

## 9. CI

`.github/workflows/verify.yml` is configured for a **self-hosted Windows
runner on the host** because the tests need the sibling `../upstream` fork and
the installed engine models. It runs lint and the suite. For a GitHub-hosted
runner, clone the fork's app tree next to `platform` first.
