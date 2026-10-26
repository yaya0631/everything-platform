/**
 * The hub: apps built from the pristine HeyPuter/everything clone, served to
 * the signed-in person as their own software.
 *
 * Layout (private listener only; the public listener never touches the hub)
 *   /hub/             home page — the person's app grid
 *   /hub/puter.js     the Puter shim that replaces js.puter.com everywhere
 *   /hub/icon/:name   an app's icon, as copied at install time
 *   /hub/csp-report   POST target for CSP violation reports
 *   /h/<name>/…       a built app's files, rewritten at serve time
 *
 * Only build outputs are served, from data/hub/apps/<name>; no source file is
 * ever modified. Why same-origin? The strict CSP needs it, the shim's
 * origin-relative API paths need no per-app configuration, and apps behave like
 * they came from one machine — because they did. Same-origin is a namespace,
 * not a security boundary: what actually protects people is that no upstream
 * code is modified, every external URL is stripped at serve time and provable,
 * the CSP allows exactly the inline scripts each page ships, mutating calls
 * need the X-CAD-Request header plus a same-origin Origin/Sec-Fetch-Site check,
 * cookies are HttpOnly + SameSite=Strict, and every installed app is approved
 * by an admin with an optional per-user allow-list. User-generated HTML never
 * renders on this origin (public listener / sandboxed frames).
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as db from './db.js';
import * as store from './store.js';
import * as config from './config.js';
import * as rewrite from './hub-rewrite.js';
import * as fsops from './hub-fsops.js';
import { registerData } from './hub-data.js';
import { shimSource, shimCss, workerUrlMapSource } from './hub-shim.js';
import { HUB_DIR } from './paths.js';
import { HttpError, send, sendHtml, serveStatic, readJSONBody, escapeHtml, messagePage, requestOrigin, rateLimit, clientIp } from './http.js';

const APPS_DIR = path.join(HUB_DIR, 'apps');
const ICONS_DIR = path.join(HUB_DIR, 'icons');
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

const appDir = (name) => path.join(APPS_DIR, name);
const iconFile = (name) => path.join(ICONS_DIR, `${name}.png`);

/** The signatures client posts to its configured guest listener while it
 * prepares a signing link. Keep every other hub app strictly same-origin. */
function cspConnectExtras(name) {
  if (name === 'video-studio') return ['data:'];
  if (name !== 'signatures') return [];
  try {
    const url = new URL(String(config.get('workers.public_base_url', '') || ''));
    if (url.protocol === 'https:' || url.protocol === 'http:') return [url.origin];
  } catch { /* unset or invalid settings add no CSP source */ }
  return [];
}

/** External embeds are off by default; Admin → Hub → External embeds turns on
 * the frame-src allowlist (m4). The setting is read per response, so a change
 * applies to the next page load without a restart. */
function cspFrameExtras() {
  return config.get('hubExternalEmbeds', false) === true ? rewrite.EXTERNAL_EMBED_SOURCES : [];
}

/** The bootstrap line before the shim for ?app= callers: the name rides ahead
 * of the shim so document.currentScript.dataset has it (same contract as the
 * static data-cad-app tag). */
const shimPreludes = new Map();
function shimPrelude(name) {
  let s = shimPreludes.get(name);
  if (!s) {
    // Only reached for names that already passed NAME_RE in the caller.
    s = `window.CAD_HUB_APP = ${JSON.stringify(name)};`;
    shimPreludes.set(name, s);
  }
  return s;
}

// Catalog -------------------------------------------------------------------------------

function requireRow(name) {
  if (!NAME_RE.test(name)) throw new HttpError(404, 'not_found', 'No such app.');
  const row = db.get('SELECT * FROM hub_apps WHERE name = ?', name);
  if (!row) throw new HttpError(404, 'not_found', `The app "${name}" is not installed.`);
  return row;
}

function safeUsers(v) {
  try {
    const arr = JSON.parse(v || '[]');
    return Array.isArray(arr) ? arr.filter((u) => typeof u === 'string') : [];
  } catch {
    return [];
  }
}

function rowForBrowser(row) {
  let meta = {};
  try {
    meta = JSON.parse(row.meta || '{}') || {};
  } catch {
    /* legacy empty rows */
  }
  return {
    name: row.name,
    title: row.title || row.name,
    sha: row.sha,
    builtAt: row.built_at,
    size: row.size,
    files: row.files,
    base: row.base,
    source: row.source,
    enabled: !!row.enabled,
    access: row.access || 'all',
    users: safeUsers(row.users),
    hasIcon: fs.existsSync(iconFile(row.name)),
    deps: meta.deps || null,
    pathIssues: meta.pathIssues || null,
  };
}

export function listApps() {
  return db.all('SELECT * FROM hub_apps ORDER BY name').map(rowForBrowser);
}

export function getApp(name) {
  return rowForBrowser(requireRow(name));
}

/** The installed apps this person sees (admins see disabled ones too, marked). */
export function appsForUser(user, account) {
  const isAdmin = !!account?.is_admin;
  return listApps().filter((a) => {
    if (!a.enabled && !isAdmin) return false;
    if (a.access === 'users' && !isAdmin && (!user || !a.users.includes(user))) return false;
    return true;
  });
}

// Install / update / remove ---------------------------------------------------------------

function dirStats(dir) {
  let size = 0;
  let files = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        files++;
        size += fs.statSync(full).size;
      }
    }
  };
  walk(dir);
  return { size, files };
}

/**
 * Atomic install: copy into a staging folder, keep the previous build around
 * until the new one is in place (previous stays for rollback if anything
 * fails), then record it in the catalog.
 */
export function installFromDist(name, distDir, meta = {}) {
  if (!NAME_RE.test(name)) throw new HttpError(400, 'bad_name', 'App names are 1–64 letters, digits, "-" or "_".');
  if (!fs.existsSync(path.join(distDir, 'index.html'))) throw new HttpError(400, 'no_index', 'That folder has no index.html — not a built app?');

  fs.mkdirSync(APPS_DIR, { recursive: true });
  fs.mkdirSync(ICONS_DIR, { recursive: true });
  const staging = `${appDir(name)}.staging`;
  const prev = `${appDir(name)}.prev`;
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    fs.cpSync(distDir, staging, { recursive: true });
    const { size, files } = dirStats(staging);
    // Static path-prefix issues of this build (see lib/hub-rewrite.js), while
    // the staged copy still exists.
    const pathIssues = rewrite.scanPathIssues(staging);

    fs.rmSync(prev, { recursive: true, force: true });
    const hadOld = fs.existsSync(appDir(name));
    if (hadOld) fs.renameSync(appDir(name), prev);
    try {
      fs.renameSync(staging, appDir(name));
    } catch (err) {
      if (hadOld && !fs.existsSync(appDir(name))) fs.renameSync(prev, appDir(name)); // roll back
      throw err;
    }
    fs.rmSync(prev, { recursive: true, force: true });
    rewriteCache.clear();

    // The icon for the home page: whatever the build shipped, copied next to it.
    const icon =
      meta.icon ??
      [
        path.join(distDir, 'icon.png'),
        path.join(distDir, 'favicon.png'),
        path.join(distDir, 'favicon.ico'),
        path.join(distDir, 'icons', 'icon-192.png'),
        path.join(distDir, 'icons', 'icon-512.png'),
        path.join(distDir, 'icons', 'favicon-32.png'),
      ].find((f) => fs.existsSync(f));
    if (icon) {
      fs.rmSync(iconFile(name), { force: true });
      fs.copyFileSync(icon, iconFile(name));
    }

    db.run(
      `INSERT INTO hub_apps(name, title, sha, built_at, size, files, base, source, enabled, access, users, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'all', NULL, ?)
       ON CONFLICT(name) DO UPDATE SET title = excluded.title, sha = excluded.sha, built_at = excluded.built_at,
         size = excluded.size, files = excluded.files, base = excluded.base, source = excluded.source,
         enabled = 1, meta = excluded.meta`,
      name,
      String(meta.title || name),
      meta.sha ?? null,
      Date.now(),
      size,
      files,
      String(meta.base || 'relative'),
      String(meta.source || 'import'),
      // Resolved dependency versions (from the build) and the per-app
      // path-prefix issues found in this build (see lib/hub-rewrite.js).
      JSON.stringify({
        deps: meta.deps ?? null,
        pathIssues,
      }),
    );
    return getApp(name);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(500, 'install_failed', `The install failed: ${err.message}`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export function removeApp(name) {
  requireRow(name);
  fs.rmSync(appDir(name), { recursive: true, force: true });
  fs.rmSync(`${appDir(name)}.prev`, { recursive: true, force: true });
  fs.rmSync(iconFile(name), { force: true });
  rewriteCache.clear();
  db.run('DELETE FROM hub_apps WHERE name = ?', name);
  return { ok: true };
}

export function setAppState(name, { enabled, access, users } = {}) {
  requireRow(name);
  if (enabled !== undefined) {
    if (typeof enabled !== 'boolean') throw new HttpError(400, 'bad_input', 'Enabled must be true or false.');
    db.run('UPDATE hub_apps SET enabled = ? WHERE name = ?', enabled ? 1 : 0, name);
  }
  if (access !== undefined) {
    if (!['all', 'users'].includes(access)) throw new HttpError(400, 'bad_input', 'Access must be "all" or "users".');
    db.run('UPDATE hub_apps SET access = ? WHERE name = ?', access, name);
  }
  if (users !== undefined) {
    if (users !== null && !Array.isArray(users)) throw new HttpError(400, 'bad_input', 'Users is a list of account names, or null.');
    let clean = users;
    if (Array.isArray(users)) {
      const known = new Set(store.listUsers().map((u) => u.name));
      clean = users.map((u) => store.normalizeName(String(u))).filter((u) => known.has(u));
    }
    db.run('UPDATE hub_apps SET users = ? WHERE name = ?', clean === null ? null : JSON.stringify((clean || []).slice().sort()), name);
  }
  return getApp(name);
}

// Rewritten static serving -----------------------------------------------------------------

/** key → { body, hashes?, html? } for text files we rewrite (HTML, JS). */
const rewriteCache = new Map();
function cacheGet(key) {
  return rewriteCache.get(key);
}
function cachePut(key, value) {
  if (rewriteCache.size > 600) rewriteCache.clear();
  rewriteCache.set(key, value);
}

const cacheRule = (p) => (p.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');

function injectMapperTag(html) {
  if (html.includes('/hub/worker-url-map.js')) return html;
  // Classic sync script (NOT defer): it must install its fetch/WebSocket/
  // EventSource overrides during parsing, BEFORE the app's deferred module
  // scripts can fire their first fetches (the sign-e2e guest flow broke when
  // the deferred tag lost the race with the app chunk's /api call).
  const tag = '<script src="/hub/worker-url-map.js"></script>';
  return /<\/head\s*>/i.test(html) ? html.replace(/<\/head\s*>/i, `${tag}</head>`) : `${tag}${html}`;
}

/**
 * Serve one file of app "name" for URL path /h/<name>/<rel>. Extensions
 * without one fall back to index.html (client-side routing).
 */
/** §23 substitution: the per-app rules emit `__CAD_GUEST_BASE__` where the
 * absolute guest origin belongs (signatures' sign page). Empty config leaves
 * the marker in place — the feature degrades coherently (the admin has not
 * turned the public link base on yet). */
function guestBaseSub(text) {
  const base = String(config.get('workers.public_base_url', '') || '').replace(/\/+$/, '');
  return base ? text.replaceAll('__CAD_GUEST_BASE__', base) : text;
}

/**
 * Public listener guest pages (§24): productized apps that must hand a page
 * to signed-out visitors get EXACTLY that page's file set here — the page
 * plus the assets it references in the built HTML (parsed, cached by mtime)
 * — nothing else. Anything else 404s like any unknown public address. The
 * page's own capability tokens are the authorization; sessions never exist
 * on this mount.
 */
const GUEST_PAGES = {
  signatures: '/sign.html',
};

/** The asset set a guest page references, from the built file on disk. */
const guestPageAssetsCache = new Map();
function guestPageAssetPaths(app) {
  const page = appDir(app) + GUEST_PAGES[app];
  const st = statFile(appDir(app), GUEST_PAGES[app]);
  const key = `${GUEST_PAGES[app]}|${st ? `${st.mtimeMs}|${st.size}` : 'gone'}`;
  if (guestPageAssetsCache.get(key)) return guestPageAssetsCache.get(key);
  guestPageAssetsCache.clear();
  const set = new Set([GUEST_PAGES[app]]);
  try {
    const html = fs.readFileSync(page, 'utf8');
    const prefix = `/h/${app}`;
    for (const m of html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)) {
      const u = m[1];
      let resolved;
      try { resolved = new URL(u, `http://hub${prefix}${GUEST_PAGES[app]}`); } catch { continue; }
      if (resolved.origin === 'http://hub' && resolved.pathname.startsWith(`${prefix}/`)) {
        set.add(resolved.pathname.slice(prefix.length));
      }
    }
    // PDF.js imports its local module worker dynamically; sign.html does not
    // contain a src/href for it, so add only the app's bundled PDF worker.
    if (app === 'signatures') {
      const assets = path.join(appDir(app), 'assets');
      for (const entry of fs.readdirSync(assets, { withFileTypes: true })) {
        if (entry.isFile() && /^pdf\.worker(?:\.[a-z0-9_-]+)?\.mjs$/i.test(entry.name)) {
          set.add(`/assets/${entry.name}`);
        }
      }
    }
  } catch {
    /* a missing/unreadable page yields the page itself only */
  }
  const out = [...set];
  guestPageAssetsCache.set(key, out);
  return out;
}

function guestPageMount() {
  return async function (req, res, url) {
    const p = url.pathname;
    const app = Object.keys(GUEST_PAGES).find((a) => p === `/h/${a}` || p.startsWith(`/h/${a}/`));
    if (!app) return sendHtml(res, 404, messagePage('Not found', 'Unknown public page.'));
    const rel = p.slice(`/h/${app}`.length) || '/';
    const relPath = rel.endsWith('/') ? `${rel}index.html` : rel;
    const allowed = guestPageAssetPaths(app);
    if (!allowed.includes(relPath)) {
      return sendHtml(res, 404, messagePage('Not found', 'That file is not part of the public sign-in surface.'));
    }
    return serveAppPath(req, res, app, relPath, { injectWorkerMap: true });
  };
}

async function serveAppFile(req, res, name, rel, me) {
  const row = requireRow(name);
  const isAdmin = !!me.account?.is_admin;
  if (!row.enabled && !isAdmin) {
    return sendHtml(res, 404, messagePage('Disabled', 'This app is switched off by your administrator.'));
  }
  if (row.access === 'users' && !isAdmin && (!me.user || !safeUsers(row.users).includes(me.user))) {
    return sendHtml(res, 403, messagePage('Not for you', 'Your account is not on this app access list.'));
  }
  return serveAppPath(req, res, name, rel);
}

/**
 * Session-free PWA metadata. `GET /hub/app-manifest/<name>/<file>` answers the
 * app's rewritten manifest with icons pointing at
 * `GET /hub/app-asset/<name>/<image>` (browsers fetch both without cookies, so
 * neither can live behind /h/'s session gate). The manifest's own app fields
 * stay on /h/<name>/, so installing an app still opens the private shell.
 */
async function serveAppPublicFile(req, res, p) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { code: 'method_not_allowed' });
  const isManifest = p.startsWith('/hub/app-manifest/');
  const rest = p.slice((isManifest ? '/hub/app-manifest/' : '/hub/app-asset/').length);
  const parts = rest.split('/');
  const name = parts.shift();
  const file = parts.join('/');
  if (!name || !NAME_RE.test(name) || !file) return send(res, 404, { code: 'not_found' });
  if (isManifest) {
    if (parts.length !== 1 || !/^(?:manifest[^/]*\.json|[^/]*\.webmanifest)$/i.test(file)) return send(res, 404, { code: 'not_found' });
  } else if (!/\.(?:png|jpe?g|gif|svg|webp|ico)$/i.test(file)) {
    return send(res, 404, { code: 'not_found' });
  }
  let row;
  try {
    row = requireRow(name);
  } catch {
    return send(res, 404, { code: 'not_found' });
  }
  if (!row.enabled) return send(res, 404, { code: 'not_found' });

  if (isManifest) {
    let text;
    try {
      text = await fsp.readFile(path.join(appDir(name), file), 'utf8');
    } catch {
      return send(res, 404, { code: 'not_found' });
    }
    const body = rewrite.rewriteManifest(text, name, { assetBase: `/hub/app-asset/${name}/` });
    return send(res, 200, body, {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
  }
  const ok = await serveStatic(req, res, appDir(name), `/${file}`, {
    cache: 'no-cache',
    headers: { 'X-Content-Type-Options': 'nosniff' },
  });
  return ok || send(res, 404, { code: 'not_found' });
}

/**
 * The serving core: stat, rewrite (cached), respond. Reused by the public
 * guest-page mount (§24: signatures' sign.html to anonymous visitors — no
 * session there, the page's own capability token is the authorization).
 */
async function serveAppPath(req, res, name, rel, { injectWorkerMap = false } = {}) {
  if (rel && !rel.startsWith('/')) rel = `/${rel}`;

  let wanted = rel;
  let st = statFile(appDir(name), wanted);
  if (!st && !path.extname(rel)) {
    wanted = '/index.html';
    st = statFile(appDir(name), wanted);
  }
  if (!st) return sendHtml(res, 404, messagePage('Not found', 'That file is not part of this app.'));

  const isHtml = /\.html?$/i.test(wanted);
  const isJs = /\.(js|mjs)$/i.test(wanted);
  const isManifest = /\.webmanifest$/.test(wanted) || /(^|\/)manifest[^/]*\.json$/.test(wanted);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { code: 'method_not_allowed' });

  if (!isHtml && !isJs && !isManifest) {
    const staticScriptExtras = rewrite.CSP_SCRIPT_EXTRAS[name] || [];
    const ok = await serveStatic(req, res, appDir(name), wanted, {
      cache: cacheRule,
      headers: {
        'Content-Security-Policy': `default-src 'self'; script-src 'self' ${staticScriptExtras.join(' ')}; object-src 'none'; report-uri /hub/csp-report`,
      },
    });
    return ok || sendHtml(res, 404, messagePage('Not found', 'That file is not part of this app.'));
  }

  const key = `${name}|${wanted}|${st.mtimeMs}|${st.size}|${config.get('workers.public_base_url', '')}|${injectWorkerMap ? 'map' : 'plain'}`;
  let entry = cacheGet(key);
  if (!entry) {
    const buf = await fsp.readFile(path.join(appDir(name), path.normalize(wanted)));
    const text = buf.toString('utf8');
    if (isHtml) {
      const out = rewrite.rewriteHtml(text, { name });
      let html = guestBaseSub(out.html);
      if (injectWorkerMap) html = injectMapperTag(html);
      entry = { body: Buffer.from(html, 'utf8'), hashes: out.hashes, html: true };
      if (out.stripped.length) {
        const uniq = [...new Set(out.stripped)];
        console.warn(`[hub] ${name}${wanted}: stripped ${out.stripped.length} external resource(s): ${uniq.slice(0, 3).join(', ')}${uniq.length > 3 ? ' …' : ''}`);
      }
    } else if (isManifest) {
      entry = { body: Buffer.from(rewrite.rewriteManifest(text, name), 'utf8'), manifest: true };
    } else {
      const out = rewrite.rewriteJs(text, { name });
      // Service workers get the cache guard prepended (see hub-rewrite.js):
      // upstream SWs cache same-origin GETs, which locally would swallow
      // /api/hub/* responses. Detected by file name, the only way SW scripts
      // are shipped (sw.js at the app root; registered by ./sw.js or /sw.js).
      // The knob exists ONLY for the smoke's control run that proves the
      // cache problem is real without the guard.
      const guarded = config.get('hub.sw_guard', true) !== false
        && /(^|\/)(sw|service-?worker)\.js$/i.test(wanted);
      // Per-app productization rules (§24; zero-match checked at build time)
      // and the §23 guest base live-substitution, then the result is cached.
      const apped = rewrite.applyAppJsRules(
        guarded ? rewrite.rewriteServiceWorker(out.text) : out.text,
        name,
      );
      entry = {
        body: Buffer.from(guestBaseSub(apped.text), 'utf8'),
        sw: guarded,
      jsCsp: "default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'",
      };
    }
    cachePut(key, entry);
  }

  const contentType = isHtml
    ? 'text/html; charset=utf-8'
    : isManifest
      ? 'application/manifest+json; charset=utf-8'
      : 'text/javascript; charset=utf-8';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(entry.body),
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': entry.html
      ? rewrite.cspHeader({
        hashes: entry.hashes,
        extras: rewrite.CSP_SCRIPT_EXTRAS[name],
        connectExtras: cspConnectExtras(name),
        frameExtras: cspFrameExtras(),
      })
      : `default-src 'self'; script-src 'self' ${(rewrite.CSP_SCRIPT_EXTRAS[name] || []).join(' ')}; connect-src 'self'; object-src 'none'`,
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(req.method === 'HEAD' || req.method !== 'GET' ? undefined : entry.body);
}

function statFile(root, rel) {
  try {
    const full = path.join(root, path.normalize(rel));
    if (full !== root && !full.startsWith(root + path.sep)) return null;
    const st = fs.statSync(full);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

// Home page -----------------------------------------------------------------------------------

/** The hub's own sign-in page — identity is a platform concern, not an app
 * feature (owner directive: CAD is not special). A plain HTML form posts to
 * /api/hub/signin, which accepts urlencoded bodies and 303-redirects back;
 * it works without any JavaScript. `message` renders a failure line. */
export function signInPage(message = '', to = '/') {
  const dest = typeof to === 'string' && to.startsWith('/') && !to.startsWith('//') ? to : '/';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in — CAD Home</title>
<style>
:root{color-scheme:light dark;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText}
main{max-width:24rem;padding:24px;width:100%}h1{font-size:18px;margin:0 0 12px}
p{margin:.4rem 0;opacity:.85}a{color:inherit}
form{display:grid;gap:10px;margin-top:12px}
label{display:grid;gap:3px;font-size:.9rem}
input{padding:8px 10px;border:1px solid color-mix(in srgb,CanvasText 25%,transparent);border-radius:8px;background:Canvas;color:CanvasText;font:inherit}
button{padding:9px 12px;border:0;border-radius:8px;background:Highlight;color:HighlightText;font:inherit;cursor:pointer}
.error{color:CanvasText;background:color-mix(in srgb,Red 22%,Canvas);border-radius:8px;padding:8px 10px;margin:0 0 4px;opacity:1}
.hint{font-size:.85rem;opacity:.65}
</style></head>
<body><main><h1>Sign in</h1>
${message ? `<p class="error">${escapeHtml(message)}</p>` : ''}
<form method="POST" action="/api/hub/signin">
<input type="hidden" name="to" value="${escapeHtml(dest)}">
<label>Username <input name="username" autocomplete="username" autofocus required></label>
<label>Password <input name="password" type="password" autocomplete="current-password" required></label>
<button type="submit">Sign in</button>
</form>
<p class="hint">Your account lives on this server. Apps open from <a href="/">the launcher</a> once you are signed in.</p>
</main></body></html>`;
}

function homeHtml(me, apps) {
  const cards = apps
    .map((a) => {
      const icon = a.hasIcon
        ? `<img src="/hub/icon/${escapeHtml(a.name)}" alt="" loading="lazy">`
        : `<span class="letter" aria-hidden="true">${escapeHtml((a.title || a.name)[0].toUpperCase())}</span>`;
      return `<a class="card${a.enabled ? '' : ' off'}" href="/h/${escapeHtml(a.name)}/" title="${escapeHtml(a.title)}">${icon}
<span class="label">${escapeHtml(a.title)}${a.enabled ? '' : ' (off)'}</span></a>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hub — CAD Home</title>
<style>
:root{color-scheme:light dark;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
body{margin:0;background:Canvas;color:CanvasText}
header{display:flex;gap:12px;align-items:baseline;max-width:62rem;margin:0 auto;padding:22px 20px 6px}
h1{font-size:18px;margin:0}
.side{margin-left:auto;display:flex;gap:16px}.side a{opacity:.8}
a{color:inherit}
main{max-width:62rem;margin:0 auto;padding:10px 20px 46px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(122px,1fr));gap:10px}
.card{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;padding:18px 8px;text-decoration:none;background:color-mix(in srgb,CanvasText 6%,Canvas);border:1px solid color-mix(in srgb,CanvasText 12%,Canvas);border-radius:10px;text-align:center}
.card:hover{border-color:color-mix(in srgb,CanvasText 30%,Canvas)}
.card img{width:48px;height:48px;object-fit:contain}
.letter{width:48px;height:48px;display:grid;place-items:center;font-size:22px;font-weight:600;background:color-mix(in srgb,CanvasText 10%,Canvas);border-radius:10px}
.label{font-size:13px;opacity:.85}
.off{opacity:.45}
.empty{opacity:.7;padding:26px 0}
.note{opacity:.6;font-size:13px;margin-top:20px}
code{font-family:ui-monospace,monospace}
</style></head>
<body>
<header><h1>Hub</h1><span class="side"><span>${escapeHtml(me.displayName || me.user)}</span>${me.isAdmin ? '<a href="/admin/">Admin</a>' : ''}<a href="/account/">Account</a></span></header>
<main>
${cards ? `<div class="grid">\n${cards}\n</div>` : '<p class="empty">No apps for you yet.</p>'}
<p class="note">${apps.length} app${apps.length === 1 ? '' : 's'} here. Apps run entirely from this server; nothing is loaded from the internet.</p>
</main></body></html>`;
}

// Serving /hub — the mount handler ---------------------------------------------------------------

const cspReports = [];

function recordCspReport(report) {
  const r = report['csp-report'] || report;
  const entry = {
    at: Date.now(),
    app: r['document-uri'] ? new URL(r['document-uri'], 'http://x').pathname.split('/').slice(0, 3).join('/') : '?',
    directive: r['violated-directive'] || r['effective-directive'] || '?',
    blocked: String(r['blocked-uri'] || '').slice(0, 200),
    source: String(r['source-file'] || '').slice(0, 200),
  };
  cspReports.unshift(entry);
  if (cspReports.length > 200) cspReports.length = 200;
  console.warn(`[hub] CSP report: ${entry.directive} blocked ${entry.blocked} on ${entry.app}`);
  return entry;
}

export const listCspReports = () => cspReports.slice();
export const clearCspReports = () => cspReports.splice(0);

function createMount(s) {
  const sessionToken = (req) => s.sessionToken(req);

  return async function hubMount(req, res, url) {
    const p = url.pathname;

    if (p === '/hub' || p === '/hub/') {
      const token = sessionToken(req);
      const user = token ? store.sessionUser(token) : null;
      if (!user) {
        return sendHtml(res, 401, signInPage());
      }
      const account = store.getAccount(user);
      const apps = appsForUser(user, account);
      return sendHtml(res, 200, homeHtml({ user, displayName: store.displayName(user), isAdmin: !!account?.is_admin }, apps), {
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; frame-ancestors 'self'",
      });
    }

    if (!(p.startsWith('/hub/') || p === '/hub' || p.startsWith('/h/'))) {
      if (p.startsWith('/hub')) return send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }

    if (p === '/hub/worker-url-map.js') {
      return send(res, 200, workerUrlMapSource(), {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Content-Security-Policy': "default-src 'none'; object-src 'none'",
        'X-Content-Type-Options': 'nosniff',
      });
    }

    if (p === '/hub/puter.js') {
      // Apps that inject the Puter loader JS themselves (chess, checkers,
      // backgammon, 3d) get the shim at /hub/puter.js?app=<name> — the query
      // carries their app name, because a runtime-injected script tag has no
      // data-cad-app attribute. The name is validated against the app-name
      // rules; anything else is ignored and the shim uses its generic fallback.
      const wantApp = url.searchParams.get('app');
      const known = wantApp && NAME_RE.test(wantApp) ? wantApp : null;
      const hostingBase = config.publicUrl() ? `${config.publicUrl()}/site/` : '';
      const body = known ? `${shimPrelude(known)}\n${shimSource({ hostingBase })}` : shimSource({ hostingBase });
      return send(res, 200, body, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
    }

    if (p === '/hub/shim.css') {
      // The shim's overlay styling, as a real file (strict CSP: no inline
      // styles anywhere in the shim's picker).
      return send(res, 200, shimCss(), {
        'Content-Type': 'text/css; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
    }

    if (p.startsWith('/hub/f/')) {
      // fs.getReadURL tokens: short-lived, HMAC-bound to user+app+path. No
      // session needed — the token IS the authorization, and a bad one is a
      // plain 404 so tokens stay opaque.
      return fsops.serveReadToken(req, res, p.slice('/hub/f/'.length));
    }

    if (p.startsWith('/hub/icon/')) {
      const name = p.slice('/hub/icon/'.length).replace(/\.png$/, '');
      if (!fs.existsSync(iconFile(name))) return send(res, 404, { code: 'not_found' });
      return serveStatic(req, res, ICONS_DIR, `/${name}.png`, { cache: 'no-cache' });
    }

    // Session-free app metadata: browsers fetch PWA manifests with credentials
    // omitted, so the private /h/ mount can never answer them (m1). Only a
    // manifest-shaped file or an image is reachable, only from an enabled
    // app's own folder.
    if (p.startsWith('/hub/app-manifest/') || p.startsWith('/hub/app-asset/')) {
      return serveAppPublicFile(req, res, p);
    }

    if (p === '/hub/csp-report') {
      if (req.method !== 'POST') return send(res, 405, { code: 'method_not_allowed' });
      if (!rateLimit(`csp-report:${clientIp(req)}`, 60, 10 * 60_000)) return send(res, 429, { code: 'rate_limited' });
      const origin = req.headers.origin;
      if (origin && origin !== requestOrigin(req)) return send(res, 403, { code: 'forbidden' });
      try {
        const report = await readJSONBody(req, 64 * 1024);
        if (report) recordCspReport(report);
      } catch {
        /* an unparsable report is still worth noting */
      }
      return send(res, 204, '');
    }

    // /h/<name>/<rest> — a built app's files.
    if (p.startsWith('/h/')) {
      const token = sessionToken(req);
      const user = token ? store.sessionUser(token) : null;
      const rest = p.slice(3);
      const name = rest.split('/')[0];
      const rel = rest.slice(name.length);
      if (!user) return sendHtml(res, 401, signInPage());
      const me = { user, displayName: store.displayName(user), account: store.getAccount(user) };
      return serveAppFile(req, res, name, rel || '/', me);
    }

    // Every known /hub path is handled above; anything else must still get a
    // response, or the connection hangs until the client times out.
    return send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  };
}

// Panels/data for admins -------------------------------------------------------------------------------

function requireAdmin(ctx) {
  if (!ctx.account?.is_admin) throw new HttpError(403, 'admins_only', 'Only admins can do that.');
}

/** Mutating hub admin calls must come from this origin (same rule the browser enforces). */
function sameOriginGuard(ctx) {
  const { req } = ctx;
  const origin = req.headers.origin;
  if (origin && origin !== requestOrigin(req)) throw new HttpError(403, 'bad_origin', 'Cross-origin requests are not allowed here.');
  const site = req.headers['sec-fetch-site'];
  if (site && !['same-origin', 'none'].includes(site)) throw new HttpError(403, 'bad_origin', 'Cross-site requests are not allowed here.');
}

function scanApp(name) {
  const row = requireRow(name);
  return {
    name,
    sha: row.sha,
    urls: rewrite.scanForExternalUrls(appDir(name)),
  };
}

export function register(s) {
  const { api, privateMounts, publicMounts } = s;
  const hubMount = createMount(s);
  privateMounts.push(['/hub', hubMount]);
  privateMounts.push(['/h/', hubMount]);
  if (publicMounts) {
    publicMounts.push(['/h/', guestPageMount()]);
    publicMounts.push(['/hub/worker-url-map.js', (req, res) => send(res, 200, workerUrlMapSource(), {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': "default-src 'none'; object-src 'none'",
      'X-Content-Type-Options': 'nosniff',
    })]);
  }

  // Signed-in management (admins only).
  const admin = (method, route, fn) =>
    api.add(method, `hub/${route}`, async (ctx) => {
      requireAdmin(ctx);
      return fn(ctx);
    });

  // The shim's identity endpoint: who the signed-in person is (or null when
  // the session is gone). Unauthenticated calls answer 401; the shim reads
  // that as "not signed in" instead of guessing.
  api.add('GET', 'hub/auth/whoami', ({ res, user, account }) =>
    user ? send(res, 200, { ...store.publicUser(account), uuid: account.stamp }) : send(res, 401, { code: 'unauthorized' }),
  );
  api.add('POST', 'hub/auth/logout', ({ req, res }) => {
    store.endSession(s.sessionToken(req));
    return send(res, 200, { ok: true });
  });
  const mut = (method, route, fn) => admin(method, route, async (ctx) => (sameOriginGuard(ctx), fn(ctx)));

  // Shim data routes — fs, kv, ai.chat, grants, export (see lib/hub-data.js).
  registerData(s);

  admin('GET', 'apps', ({ res }) => send(res, 200, { everythingDir: config.get('everythingDir'), apps: listApps() }));
  mut('PUT', 'apps/:name', async ({ req, res, params }) => {
    const body = (await readJSONBody(req)) || {};
    return send(res, 200, setAppState(params.name, body));
  });
  mut('DELETE', 'apps/:name', ({ res, params }) => send(res, 200, removeApp(params.name)));
  admin('GET', 'apps/:name/scan', ({ res, params }) => send(res, 200, scanApp(params.name)));
  admin('GET', 'ai-settings', ({ res }) => send(res, 200, { defaultModel: config.get('hubAiDefaultModel') || '', aliases: config.get('hubAiAliases') || '' }));
  mut('PUT', 'ai-settings', async ({ req, res }) => {
    const body = (await readJSONBody(req)) || {};
    const dm = String(body.defaultModel || '').trim();
    // The model part may contain '/' (openrouter and google style ids:
    // openrouter:deepseek/deepseek-v4.1-flash-1017).
    if (dm && !/^[a-zA-Z0-9_-]{1,40}:[\w .:/\-*]{1,120}$/.test(dm)) {
      throw new HttpError(400, 'bad_model', 'Use a model id like provider:modelname (for example ollama:llama3.2 or openrouter:google/gemma-2b-it:free).');
    }
    config.set('hubAiDefaultModel', dm || null);
    const aliases = String(body.aliases || '').trim();
    if (aliases) {
      let parsed;
      try {
        parsed = JSON.parse(aliases);
      } catch {
        throw new HttpError(400, 'bad_aliases', 'The alias map must be JSON, for example {"gpt-4o": "ollama:llama3.2"}.');
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new HttpError(400, 'bad_aliases', 'The alias map must be a JSON object.');
      }
      for (const [cloud, local] of Object.entries(parsed)) {
        if (!/^[a-zA-Z0-9 .:_-]{1,80}$/.test(cloud) || !/^[a-zA-Z0-9_-]{1,40}:[\w .:*-]{1,120}$/.test(String(local))) {
          throw new HttpError(400, 'bad_aliases', `"${cloud}" is not a cloud-name-to-model mapping.`);
        }
      }
    }
    config.set('hubAiAliases', aliases ? JSON.stringify(JSON.parse(aliases)) : null);
    return send(res, 200, { ok: true });
  });
  admin('GET', 'external-embeds', ({ res }) => send(res, 200, { enabled: config.get('hubExternalEmbeds', false) === true }));
  mut('PUT', 'external-embeds', async ({ req, res }) => {
    const body = (await readJSONBody(req)) || {};
    const enabled = body.enabled === true;
    config.set('hubExternalEmbeds', enabled ? true : null);
    return send(res, 200, { ok: true, enabled });
  });
  admin('GET', 'csp-reports', ({ res }) => send(res, 200, listCspReports()));
  mut('DELETE', 'csp-reports', ({ res }) => send(res, 200, clearCspReports()));
  mut('POST', 'reports/clear', ({ res }) => send(res, 200, clearCspReports()));
}
