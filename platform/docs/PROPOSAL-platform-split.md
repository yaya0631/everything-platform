# PROPOSAL — platform split (no code yet; awaiting owner approval)

Goal per owner correction: one home platform hosting ALL of `upstream\src\<app>`;
`cad-home` demoted to just the AutoCAD app; platform code must not live in or
depend on it. Small steps, one commit each, suites green each step.
`data\cad.db`, the data folder and git history stay intact; `tools\db-backup.mjs`
backup before the move. `upstream\` untouched (clean at `0fc4d361`).

## New layout (D:\Stream\)

    D:\Stream\everything\
      upstream\            apps source folder — UNTOUCHED, stays clean at 0fc4d361
      platform\            ALL platform code (moved OUT of cad-home):
                           server.js, hub.js, users.js, apps.js, lib\, sdk\, panel\,
                           test\, tools\, build-hub.mjs, run-upstream-suite.mjs,
                           functional-gate.mjs, browser-smoke.mjs, smoke-hub.mjs,
                           check-firewall.mjs, data\ (cad.db + user files, moved as-is),
                           package.json (platform scripts), *_e2e.mjs runners,
                           docs\, README.md, node_modules\ (fresh install)
      cad\                 the CAD app ONLY (owner-approved rename of cad-home\app\)
                           — same shape as any other app folder
      _app-folder-archive\ the 51 loose top-level app folders (move, not delete)

Internal identifiers (cad.db, CAD_TEST, cad_session cookie, "cad-home" inside
evidence JSONs) are NOT renamed in this move — zero-risk step, rename later if wanted.

## Move list (cad-home → platform)
Everything listed under "platform" above; `app\` stays in place until step S4.
Junk at cad-home root (`prototype-data-browsercheck`, `browser-smoke-results*.json`)
moves/deletes in the final cleanup commit (results files are platform evidence → platform).

## Commit sequence
- S1  Backup db (`tools\db-backup.mjs`), archive the 51 folders → move, suites green.
- S2  Lift git root cad-home → D:\Stream\everything (move .git only; nothing else
      changes; history intact). Upstream + archive gitignored.
- S3  Create `platform\`; git-mv the platform files + `data\` into it; fix relative
      anchors (`../upstream` stays correct for platform\; test imports go
      `../server.js` → `../../server.js` etc. — grep sweep, one commit, suites green).
- S4  `git mv app → cad\app` (or `cad\` root — owner pick); cad README; suites green.
- S5  Rename the remaining `cad-home` directory → `cad` (owner pick y/n).
- S6  Junk cleanup + final count report.

## Risks
1. Relative-path blast radius (~40 test files + lib modules): mitigated by grep sweep +
   suites after S3; one commit.
2. `data\` moves while server is STOPPED; db backup taken first; db unchanged internally.
3. Git history: preserved by lifting the repo root (rename-detection keeps
   `git log --follow`); alternative (fresh root repo + graft) only if S2 bothers you.
4. package.json split (platform vs cad app) — cad keeps its own package.json already.
5. `everythingDir` config default `../upstream` still resolves correctly from
   `platform\`.

## Owner decisions needed
1. Platform folder name: `platform` (default) or `hub`?
2. S5 rename `cad-home` → `cad`: yes/no?
3. S2 repo-root lift (history intact, single repo) — approve / prefer alternative?
