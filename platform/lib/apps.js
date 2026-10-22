/**
 * Hosted web apps: a registry, staging deploys with atomic swaps, the launchers
 * and sandboxed content, the token handshake and the /appapi the SDK calls with
 * a bearer token.
 *
 * Layout on disk (data/apps/<name>/):
 *   site/        the published app (must contain index.html)
 *   .staging/    files uploaded for the next deploy
 *   .previous/   the version before the last publish, kept for rollback
 *
 * Content is always served with a CSP sandbox, so the page has an opaque
 * origin: no CAD cookies and no shared storage. The launcher (a trusted CAD
 * page) hands the app a scoped bearer token once its iframe says it is ready,
 * and every /appapi call carries it. Visitor tokens for public apps can never
 * touch people's files or their key-value data.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import * as db from './db.js';
import * as store from './store.js';
import * as drive from './drive.js';
import * as ai from './ai.js';
import * as mail from './mail.js';
import * as config from './config.js';
import { APPS_DIR, SDK_DIR } from './paths.js';
import { fnDir, dispose as disposeRunner } from './functions.js';
import { HttpError, send, sendHtml, readBody, readJSONBody, serveStatic, sendNotFound, clientIp, rateLimit, messagePage, Router } from './http.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const BAD_NAME = 'App names are 2 to 32 lowercase letters, digits or dashes, starting with a letter or digit.';
const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const TOKEN_TTL = 12 * 3600_000;
const MAX_STAGING_FILE = 16 * 1024 * 1024;
const MAX_AI_BODY = 1024 * 1024;
const MAX_KV_TOTAL = store.MAX_KV_VALUE * 8; // 2 MB per app/user namespace

export const validName = (name) => NAME_RE.test(String(name || ''));

const dir = (name) => path.join(APPS_DIR, name);
const siteDir = (name) => path.join(dir(name), 'site');
const stagingDir = (name) => path.join(dir(name), '.staging');
const previousDir = (name) => path.join(dir(name), '.previous');

// Registry -----------------------------------------------------------------------------------

export function get(name) {
  if (!validName(name)) return null;
  const row = db.get('SELECT * FROM apps WHERE name = ?', name);
  return row ? { ...row, publicAi: !!row.public_ai, publicEmail: !!row.public_email } : null;
}

export function requireApp(name) {
  const app = get(name);
  if (!app) throw new HttpError(404, 'unknown_app', `There is no app called "${name}" on this server.`);
  return app;
}

export function list(owner = null) {
  const rows = owner ? db.all('SELECT * FROM apps WHERE owner = ? ORDER BY name', owner) : db.all('SELECT * FROM apps ORDER BY name');
  return rows.map((r) => ({ ...r, publicAi: !!r.public_ai, publicEmail: !!r.public_email }));
}

/** Only accounts with the flag (and admins) may deploy. */
export const canHostApps = (account) => !!account && !!(account.is_admin || account.can_host_apps);

export function requireHost(ctx) {
  if (!ctx.account) throw new HttpError(401, 'not_signed_in', 'Sign in first.');
  if (!canHostApps(ctx.account)) throw new HttpError(403, 'hosts_only', 'Only people who can host apps may do that. Ask an admin, or run "npm run user -- host <name>".');
}

/** True when the published site actually serves (an index.html is there). */
export const isPublished = (name) => {
  try {
    return fs.statSync(path.join(siteDir(name), 'index.html')).isFile();
  } catch {
    return false;
  }
};

export const hasStaging = (name) => {
  try {
    return fs.readdirSync(stagingDir(name)).length > 0;
  } catch {
    return false;
  }
};

export const hasPrevious = (name) => fs.existsSync(previousDir(name));

/** Environment secrets an app will later see as ctx.env. Values are masked here. */
export function listEnv(name) {
  return db.all('SELECT key FROM app_env WHERE app = ? ORDER BY key', name).map((r) => ({ key: r.key, value: config.MASK }));
}

export function setEnv(name, entries) {
  for (const [key, value] of Object.entries(entries || {})) {
    if (!/^[a-z][a-z0-9_]{0,63}$/i.test(key)) throw new HttpError(400, 'bad_env_key', `Environment key "${key}" must be letters, digits and underscores, starting with a letter.`);
    if (config.isMasked(value)) continue; // a masked echo of the stored value: keep the stored secret
    db.run('INSERT INTO app_env(app, key, value) VALUES (?, ?, ?) ON CONFLICT(app, key) DO UPDATE SET value = excluded.value', name, key, String(value ?? ''));
  }
}

// Files --------------------------------------------------------------------------------------

/** A relative path inside site/ or .staging/: no leading /, no .., Windows-safe names. */
function relParts(raw) {
  const text = String(raw ?? '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!text) throw new HttpError(400, 'bad_path', 'A file path is required.');
  const parts = text.split('/');
  for (const p of parts) {
    if (!p || p === '.' || p === '..' || drive.BAD_SEGMENT.test(p) || RESERVED_NAME.test(p) || p.length > 255) {
      throw new HttpError(400, 'bad_path', `The path "${text}" is not allowed.`);
    }
  }
  if (text.length > 1024) throw new HttpError(400, 'bad_path', 'That path is too long.');
  return parts;
}

export async function putStagingFile(name, rel, body) {
  const parts = relParts(rel);
  const root = stagingDir(name);
  const full = path.normalize(path.join(root, ...parts));
  if (full !== root && !full.startsWith(root + path.sep)) throw new HttpError(400, 'bad_path', 'That path is outside the app.');
  if (Buffer.byteLength(body) > MAX_STAGING_FILE) throw new HttpError(413, 'too_large', 'App files are at most 16 MB.');
  await fsp.mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
  await fsp.writeFile(full, body, { mode: 0o600 });
}

async function rmStaging(name) {
  await fsp.rm(stagingDir(name), { recursive: true, force: true });
}

/**
 * Swap .staging into place as the new site; the old site becomes .previous.
 * index.html must exist in the staging folder, so a broken deploy never takes
 * an already working app down.
 */
export async function publish(name, { owner, title, description, visibility, create = true } = {}) {
  try {
    if (!fs.statSync(path.join(stagingDir(name), 'index.html')).isFile()) throw new Error('no index');
  } catch {
    throw new HttpError(400, 'no_index', 'The deployed folder needs an index.html page.');
  }
  await fsp.mkdir(dir(name), { recursive: true, mode: 0o700 });
  const now = Date.now();
  db.tx(() => {
    if (!get(name)) {
      if (!create) throw new HttpError(404, 'unknown_app', `There is no app called "${name}".`);
      db.run('INSERT INTO apps(name, owner, title, description, visibility, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)', name, owner, title || name, description || '', visibility === 'public' ? 'public' : 'private', now, now);
    } else {
      db.run('UPDATE apps SET title = COALESCE(?, title), description = COALESCE(?, description), visibility = COALESCE(?, visibility), updated = ? WHERE name = ?', title ?? null, description ?? null, visibility ?? null, now, name);
    }
  });
  const prev = previousDir(name);
  await fsp.rm(prev, { recursive: true, force: true });
  try {
    await fsp.rename(siteDir(name), prev);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  await fsp.rename(stagingDir(name), siteDir(name));
  // functions/ is not part of the served site: it moves to <app>/functions/, where the runner finds it.
  const inSite = path.join(siteDir(name), 'functions');
  const target = fnDir(name);
  await fsp.rm(target, { recursive: true, force: true });
  try {
    await fsp.rename(inSite, target);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return get(name);
}

/** Put the previous version back. The current one is kept as .previous, so it can be toggled back. */
export async function rollback(name) {
  if (!get(name)) throw new HttpError(404, 'unknown_app', `There is no app called "${name}".`);
  const site = siteDir(name);
  try {
    if (!fs.statSync(site).isDirectory()) throw new Error('gone');
  } catch {
    throw new HttpError(400, 'no_site', 'The current version is missing, so there is nothing to roll back from.');
  }
  if (!fs.existsSync(previousDir(name))) throw new HttpError(400, 'no_previous', 'There is no earlier version to roll back to.');
  const swap = path.join(dir(name), '.swap');
  await fsp.rm(swap, { recursive: true, force: true });
  await fsp.rename(site, swap);
  await fsp.rename(previousDir(name), site);
  await fsp.rename(swap, previousDir(name));
  db.run('UPDATE apps SET updated = ? WHERE name = ?', Date.now(), name);
}

export function removeApp(name) {
  if (!get(name)) throw new HttpError(404, 'unknown_app', `There is no app called "${name}".`);
  disposeRunner(name); // stop this app's function runner, if it has one
  db.tx(() => {
    db.run('DELETE FROM apps WHERE name = ?', name);
    db.run('DELETE FROM app_env WHERE app = ?', name);
    db.run('DELETE FROM app_grants WHERE app = ?', name);
    db.run("DELETE FROM kv WHERE ns LIKE ? ESCAPE '\\'", `app:${name.replace(/[%_\\]/g, '\\$&')}:%`);
    db.run("DELETE FROM tokens WHERE app = ? AND kind IN ('app', 'visitor')", name);
  });
  fs.rmSync(dir(name), { recursive: true, force: true });
}

// Tokens --------------------------------------------------------------------------------------

export const issueAppToken = (user, app) => store.createToken('app', { user, app, ttlMs: TOKEN_TTL });
export const issueVisitorToken = (app) => store.createToken('visitor', { app, ttlMs: TOKEN_TTL });

const bearer = (req) => /^Bearer (\S{10,200})$/.exec(String(req.headers.authorization || ''))?.[1] ?? null;

/** Which scoped token does this request carry? kind: app (a signed-in user) or visitor. */
export function appToken(req, appName) {
  const token = bearer(req);
  if (!token) throw new HttpError(401, 'no_token', 'The app has no token from the launcher yet.');
  const row = store.findToken('app', token) ?? store.findToken('visitor', token);
  if (!row) throw new HttpError(401, 'invalid_token', 'The token expired or was revoked. Ask the launcher for a new one.');
  if (row.app !== appName) throw new HttpError(401, 'wrong_app', 'This token belongs to another app.');
  if (row.kind === 'app' && !store.getAccount(row.user)) throw new HttpError(401, 'gone_user', 'The account behind this token is gone.');
  return { kind: row.kind, user: row.kind === 'app' ? row.user : null, app: appName };
}

// Launcher and sandboxed content ----------------------------------------------------------------

const SANDBOX = {
  'Content-Security-Policy': "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; frame-ancestors 'self'",
  'Access-Control-Allow-Origin': '*',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

const notFoundPage = (res, title, text) => sendHtml(res, 404, messagePage(title, text));

/** The mount for /apps/<name>/ (private) and /p/<name>/ (public apps only). */
function appLauncher(kind) {
  const prefix = kind === 'public' ? '/p/' : '/apps/';
  return async (req, res, url) => {
    const name = url.pathname.slice(prefix.length).split('/')[0];
    const app = get(name);
    if (!app || (kind === 'public' && app.visibility !== 'public')) return notFoundPage(res, 'No such app', 'That app does not exist here, or it is not public.');
    if (kind === 'public' && url.pathname === `${prefix}${name}/token` && (req.method === 'POST' || req.method === 'GET')) {
      if (!rateLimit(`visitor-token:${name}:${clientIp(req)}`, 30, 10 * 60_000)) throw new HttpError(429, 'rate_limited', 'Too many tokens asked for. Wait a few minutes.');
      return send(res, 200, { token: issueVisitorToken(name) });
    }
    const ok = await serveStatic(req, res, SDK_DIR, '/launcher.html', { cache: 'no-cache' });
    if (!ok) sendNotFound(res);
  };
}

/** The sandboxed app itself: /app-content/<name>/... and /p-content/<name>/... */
function appContent(kind) {
  const prefix = kind === 'public' ? '/p-content/' : '/app-content/';
  return async (req, res, url, sessionToken) => {
    if (req.method === 'OPTIONS') return send(res, 204, '', { ...SANDBOX, 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS' });
    const name = url.pathname.slice(prefix.length).split('/')[0];
    const app = get(name);
    if (!app || (kind === 'public' && app.visibility !== 'public')) return notFoundPage(res, 'No such app', 'That app does not exist here, or it is not public.');
    if (!isPublished(name)) return notFoundPage(res, 'Not published', 'This app has no published version yet.');
    if (kind === 'private' && !store.sessionUser(sessionToken(req))) {
      return sendHtml(res, 401, messagePage('Sign in first', `Open this app from its CAD Home page (/apps/${name}/) after signing in.`));
    }
    const rel = url.pathname.slice(prefix.length + name.length);
    const ok = await serveStatic(req, res, siteDir(name), rel ? rel : '/index.html', { cache: 'no-cache', headers: SANDBOX });
    if (!ok) notFoundPage(res, 'Not found', 'That file is not part of this app.');
  };
}

// The SDK API -----------------------------------------------------------------------------------

const kvNamespace = (app, user) => `app:${app}:user:${user}`;

function checkKvKey(key) {
  if (typeof key !== 'string' || !key.length || key.length > store.MAX_KV_KEY) throw new HttpError(400, 'bad_key', 'KV keys are 1 to 256 characters.');
  return key;
}

/** fs is for signed-in users of the app only; public visitors have no drive. */
function fsTarget(kind, user, app, raw, need) {
  if (kind === 'visitor') throw new HttpError(403, 'not_for_visitors', 'Public visitors have no file access. Sign in to use your files.');
  return drive.resolveApp(user, app, raw, need);
}

function kvVisitorGuard(session) {
  if (session.kind === 'visitor') throw new HttpError(403, 'not_for_visitors', 'Public visitors have no key-value storage.');
}

const APPAPI = new Router();

APPAPI.add('GET', ':app/whoami', ({ res, session }) =>
  send(res, 200, session.kind === 'app' ? { username: session.user, displayName: store.displayName(session.user) } : null),
);

APPAPI.add('GET', ':app/fs/readdir', async ({ res, url, session }) => {
  const t = fsTarget(session.kind, session.user, session.app, url.searchParams.get('path'), 'view');
  return send(res, 200, await drive.listDir(t, Object.fromEntries(url.searchParams)));
});

APPAPI.add('GET', ':app/fs/stat', async ({ res, url, session }) => send(res, 200, await drive.statItem(fsTarget(session.kind, session.user, session.app, url.searchParams.get('path'), 'view'))));

APPAPI.add('GET', ':app/fs/read', ({ res, url, session }) => drive.sendFile(res, fsTarget(session.kind, session.user, session.app, url.searchParams.get('path'), 'view')));

APPAPI.add('PUT', ':app/fs/write', async ({ req, res, url, session }) => {
  const t = fsTarget(session.kind, session.user, session.app, url.searchParams.get('path'), 'edit');
  return send(res, 200, await drive.writeFile(t, req, { overwrite: url.searchParams.get('overwrite') !== '0' }));
});

APPAPI.add('DELETE', ':app/fs/delete', async ({ res, url, session }) => {
  const t = fsTarget(session.kind, session.user, session.app, url.searchParams.get('path'), 'delete');
  await drive.remove(t, { recursive: url.searchParams.get('recursive') === '1' });
  return send(res, 200, { ok: true });
});

APPAPI.add('POST', ':app/fs/mkdir', async ({ res, url, session }) => send(res, 200, await drive.mkdir(fsTarget(session.kind, session.user, session.app, url.searchParams.get('path'), 'edit'))));

APPAPI.add('POST', ':app/fs/rename', async ({ req, res, session }) => {
  const { from, to, overwrite } = (await readJSONBody(req)) || {};
  return send(res, 200, await drive.rename(fsTarget(session.kind, session.user, session.app, from, 'delete'), fsTarget(session.kind, session.user, session.app, to, 'edit'), { overwrite: !!overwrite }));
});

APPAPI.add('GET', ':app/kv/list', ({ res, url, session }) => {
  kvVisitorGuard(session);
  const ns = kvNamespace(session.app, session.user);
  const values = /^1|true$/i.test(url.searchParams.get('values') || '');
  return send(res, 200, store.kvList(ns, url.searchParams.get('pattern') || '*', values));
});

APPAPI.add('GET', ':app/kv/:key', ({ res, params, session }) => {
  kvVisitorGuard(session);
  return send(res, 200, { value: store.kvGet(kvNamespace(session.app, session.user), checkKvKey(params.key)) ?? null });
});

APPAPI.add('PUT', ':app/kv/:key', async ({ req, res, params, session }) => {
  kvVisitorGuard(session);
  const key = checkKvKey(params.key);
  const body = await readJSONBody(req, store.MAX_KV_VALUE + 1024);
  const value = body?.value ?? null;
  const before = store.kvGet(kvNamespace(session.app, session.user), key);
  const freed = key.length + JSON.stringify(before).length;
  const added = value == null ? 0 : key.length + JSON.stringify(value).length;
  if (store.kvSize(kvNamespace(session.app, session.user)) - freed + added > MAX_KV_TOTAL) {
    throw new HttpError(413, 'too_large', 'This app has used up its key-value space (2 MB per person). Delete some keys first.');
  }
  store.kvSet(kvNamespace(session.app, session.user), key, value);
  return send(res, 200, { ok: true });
});

APPAPI.add('DELETE', ':app/kv/:key', ({ res, params, session }) => {
  kvVisitorGuard(session);
  return send(res, 200, { ok: store.kvDel(kvNamespace(session.app, session.user), checkKvKey(params.key)) });
});

APPAPI.add('POST', ':app/kv/incr', async ({ req, res, session }) => {
  kvVisitorGuard(session);
  const { key, by } = (await readJSONBody(req)) || {};
  return send(res, 200, { value: store.kvIncr(kvNamespace(session.app, session.user), checkKvKey(key), by) });
});

APPAPI.add('POST', ':app/kv/flush', ({ res, session }) => {
  kvVisitorGuard(session);
  store.kvFlush(kvNamespace(session.app, session.user));
  return send(res, 200, { ok: true });
});

/** Public apps may use AI only when the admin switches it on, rate limited per IP. */
function publicAiGuard(app, req) {
  if (app.publicAi) {
    const limit = Number(config.get('limits.public_ai_per_hour'));
    if (!rateLimit(`appai:${app.name}:${clientIp(req)}`, limit, 3600_000)) {
      throw new HttpError(429, 'rate_limited', `This app allows ${limit} AI calls per hour per person, and it is busy. Try again later.`);
    }
    return;
  }
  throw new HttpError(403, 'public_ai_off', 'This app cannot use AI. The server admin can allow it in Admin → Apps.');
}

APPAPI.add('GET', ':app/ai/models', async ({ res, session, app, req }) => {
  if (session.kind === 'visitor') publicAiGuard(app, req);
  return send(res, 200, await ai.availableModels());
});

APPAPI.add('POST', ':app/ai/chat', async ({ req, res, session, app }) => {
  if (session.kind === 'visitor') publicAiGuard(app, req);
  const body = await readJSONBody(req, MAX_AI_BODY);
  return ai.streamChat(req, res, body, { user: session.kind === 'app' ? session.user : null, source: `app:${app.name}` });
});

APPAPI.add('POST', ':app/email/send', async ({ req, res, session, app }) => {
  const { to, subject, text, html } = (await readJSONBody(req, 1024 * 1024)) || {};
  if (session.kind === 'visitor') {
    if (!app.publicEmail) throw new HttpError(403, 'public_email_off', 'This app cannot send email. The server admin can allow it in Admin → Apps.');
    const owner = store.getAccount(app.owner);
    const ownerAddr = String(owner?.email || '').trim();
    if (!ownerAddr || !store.validEmail(ownerAddr)) throw new HttpError(403, 'no_owner_address', 'The app owner has no email address, so this app cannot send email.');
    const dest = (Array.isArray(to) ? to.map(String) : [String(to ?? '')]).map((a) => a.trim()).filter(Boolean);
    if (dest.length !== 1 || dest[0].toLowerCase() !== ownerAddr.toLowerCase()) {
      throw new HttpError(403, 'wrong_recipient', 'Public apps can only send email to the app owner.');
    }
    const limit = Number(config.get('limits.public_email_per_hour'));
    if (!rateLimit(`appmail:${app.name}:${clientIp(req)}`, limit, 3600_000)) {
      throw new HttpError(429, 'rate_limited', `This app allows ${limit} emails per hour per person. Try again later.`);
    }
    await mail.send({ to: ownerAddr, subject, text, html, user: owner.name, source: `app:${app.name}` });
    return send(res, 200, { ok: true });
  }
  const grant = db.get("SELECT id FROM app_grants WHERE app = ? AND user = ? AND mode = 'email'", app.name, session.user);
  if (!grant) {
    const err = new HttpError(403, 'email_permission', `${app.title || app.name} wants to send email; allow it in the launcher dialog first.`);
    err.askPermission = true;
    throw err;
  }
  await mail.send({ to, subject, text, html, user: session.user, source: `app:${app.name}` });
  return send(res, 200, { ok: true });
});

/** Same dispatch for both listeners; appapi answers always carry CORS headers, since the sandboxed app is a cross-origin caller. */
function appApiHeaders(res) {
  const writeHead = res.writeHead.bind(res);
  res.writeHead = (code, headers) => writeHead(code, { 'Access-Control-Allow-Origin': '*', ...headers });
}

async function handleAppApi(req, res, url) {
  if (req.method === 'OPTIONS') {
    return send(res, 204, '', {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
    });
  }
  const m = APPAPI.match(req.method, url.pathname.slice('/appapi/'.length));
  if (!m) return sendNotFound(res, 'Unknown app API call.');
  appApiHeaders(res);
  const app = get(m.params.app);
  if (!app) throw new HttpError(404, 'unknown_app', `There is no app called "${m.params.app}".`);
  if (req.isPublic && app.visibility !== 'public') throw new HttpError(404, 'unknown_app', 'Unknown app.');
  const session = appToken(req, app.name);
  return m.fn({ req, res, url, params: m.params, app, session });
}

// register ---------------------------------------------------------------------------------------

export function register(s) {
  const { api, privateMounts, publicMounts } = s;
  const sessionToken = (req) => s.sessionToken(req);

  privateMounts.push(['/apps/', appLauncher('private')]);
  privateMounts.push(['/app-content/', (req, res, url) => appContent('private')(req, res, url, sessionToken)]);
  privateMounts.push(['/appapi/', handleAppApi]);
  publicMounts.push(['/p/', appLauncher('public')]);
  publicMounts.push(['/p-content/', (req, res, url) => appContent('public')(req, res, url, sessionToken)]);
  publicMounts.push(['/appapi/', handleAppApi]);

  const sdkStatic = async (req, res, url) => {
    if (req.method === 'OPTIONS') {
      return send(res, 204, '', {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      });
    }
    const ok = await serveStatic(req, res, SDK_DIR, url.pathname.slice('/sdk'.length), { cache: 'no-cache' });
    if (!ok) sendNotFound(res);
  };
  privateMounts.push(['/sdk/', sdkStatic]);
  publicMounts.push(['/sdk/', sdkStatic]);

  // /fn/ is registered by lib/functions.js (Step 7b): the runner lives there.

  // Launcher support routes (cookie auth, private listener only).
  api.add('POST', 'apps/:name/token', ({ res, params, user }) => {
    const app = requireApp(params.name);
    // Any signed-in person may open and use a hosted app; the launcher signs them
    // in, and their token only ever reaches their own AppData folder and grants.
    return send(res, 200, { token: issueAppToken(user, app.name), title: app.title || app.name });
  });

  api.add('POST', 'apps/:name/grants', async ({ req, res, params, user }) => {
    const app = requireApp(params.name);
    const { paths, mode } = (await readJSONBody(req)) || {};
    const need = mode === 'edit' ? 'edit' : 'view';
    const picked = (Array.isArray(paths) ? paths.map(String) : [String(paths ?? '')]).map((p) => p.trim()).filter(Boolean);
    if (!picked.length) throw new HttpError(400, 'bad_request', 'Pick at least one file or folder.');
    const items = [];
    for (const p of picked) {
      const t = drive.resolve(user, p, need);
      const row =
        db.get('SELECT id FROM app_grants WHERE user = ? AND app = ? AND owner = ? AND path = ? AND mode = ?', user, app.name, t.owner, t.ownerRel, need) ??
        null;
      const id = row?.id ?? crypto.randomBytes(6).toString('base64url');
      if (!row) db.run('INSERT INTO app_grants(id, user, app, owner, path, mode, created) VALUES (?, ?, ?, ?, ?, ?, ?)', id, user, app.name, t.owner, t.ownerRel, need, Date.now());
      items.push({ id, name: path.posix.basename(t.ownerRel) || t.owner, path: `~grant/${id}` });
    }
    return send(res, 200, { items });
  });

  api.add('POST', 'apps/:name/email-permission', ({ res, params, user }) => {
    const app = requireApp(params.name);
    const existing = db.get("SELECT id FROM app_grants WHERE app = ? AND user = ? AND mode = 'email'", app.name, user);
    if (existing) return send(res, 200, { ok: true, id: existing.id });
    const id = crypto.randomBytes(6).toString('base64url');
    db.run("INSERT INTO app_grants(id, user, app, owner, path, mode, created) VALUES (?, ?, ?, '', '', 'email', ?)", id, user, app.name, Date.now());
    store.audit(user, 'apps.email_allowed', { app: app.name });
    return send(res, 200, { ok: true, id });
  });

  setUpAdminRoutes(api);
}

// Admin and owner routes ---------------------------------------------------------------------------

function rowForBrowser(a) {
  return {
    name: a.name,
    owner: a.owner,
    title: a.title || '',
    description: a.description || '',
    visibility: a.visibility || 'private',
    publicAi: !!a.publicAi,
    publicEmail: !!a.publicEmail,
    created: a.created,
    updated: a.updated,
    published: isPublished(a.name),
    staging: hasStaging(a.name),
    previous: hasPrevious(a.name),
  };
}

function ownedAppOrHost(ctx, name) {
  const app = get(name);
  if (!app) return null;
  if (!ctx.account.is_admin && app.owner !== ctx.user) throw new HttpError(403, 'not_yours', 'You can only manage your own apps.');
  return app;
}

/** Every direct disk/table route validates the name before touching APPS_DIR or the database. */
function checkName(name, res) {
  if (!validName(name)) throw new HttpError(400, 'bad_name', BAD_NAME);
}

function setUpAdminRoutes(api) {
  api.add('GET', 'admin/apps', ({ res, account, user }) => {
    if (!account.is_admin && !account.can_host_apps) return send(res, 200, []);
    return send(res, 200, list(account.is_admin ? null : user).map(rowForBrowser));
  });

  api.add('GET', 'admin/apps/:name', async (ctx) => {
    const app = ownedAppOrHost(ctx, ctx.params.name);
    if (!app) throw new HttpError(404, 'unknown_app', `There is no app called "${ctx.params.name}".`);
    const grants = db
      .all('SELECT id, user, app, owner, path, mode, created FROM app_grants WHERE app = ? ORDER BY created DESC', app.name)
      .map((g) => ({ ...g, path: g.mode === 'email' ? null : g.owner === g.user ? g.path : `/@${g.owner}${g.path}` }));
    return send(ctx.res, 200, { ...rowForBrowser(app), env: listEnv(app.name), grants });
  });

  api.add('PUT', 'admin/apps/:name', async (ctx) => {
    const app = ownedAppOrHost(ctx, ctx.params.name);
    if (!app) throw new HttpError(404, 'unknown_app', `There is no app called "${ctx.params.name}".`);
    const b = (await readJSONBody(ctx.req)) || {};
    const fields = {};
    if ('title' in b) fields.title = String(b.title ?? '').trim().slice(0, 120);
    if ('description' in b) fields.description = String(b.description ?? '').trim().slice(0, 500);
    if ('visibility' in b) fields.visibility = b.visibility === 'public' ? 'public' : 'private';
    if ('publicAi' in b) fields.public_ai = b.publicAi ? 1 : 0;
    if ('publicEmail' in b) fields.public_email = b.publicEmail ? 1 : 0;
    if (Object.keys(fields).length) {
      const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
      db.run(`UPDATE apps SET ${sets}, updated = ? WHERE name = ?`, ...Object.values(fields), Date.now(), app.name);
    }
    if (b.env && typeof b.env === 'object') setEnv(app.name, b.env);
    store.audit(ctx.user, 'apps.updated', { app: app.name });
    return send(ctx.res, 200, rowForBrowser(get(app.name)));
  });

  api.add('PUT', 'admin/apps/:name/staging', async ({ req, res, params, user, account, url }) => {
    requireHost({ account, user });
    checkName(params.name, res);
    ownedAppOrHost({ account, user }, params.name); // 403 when it exists and is not ours; ok otherwise
    const path_ = url.searchParams.get('path');
    const body = await readBody(req, MAX_STAGING_FILE + 4096);
    await putStagingFile(params.name, path_, body);
    return send(res, 200, { ok: true });
  });

  api.add('DELETE', 'admin/apps/:name/staging', async ({ res, params, user, account }) => {
    requireHost({ account, user });
    checkName(params.name, res);
    ownedAppOrHost({ account, user }, params.name);
    await rmStaging(params.name);
    return send(res, 200, { ok: true });
  });

  api.add('POST', 'admin/apps/:name/publish', async ({ res, params, user, account }) => {
    requireHost({ account, user });
    checkName(params.name, res);
    const app = ownedAppOrHost({ account, user }, params.name);
    const published = await publish(params.name, { owner: app?.owner || user, create: !app });
    store.audit(user, 'apps.published', { app: params.name });
    return send(res, 200, rowForBrowser(published));
  });

  api.add('POST', 'admin/apps/:name/rollback', async (ctx) => {
    const app = ownedAppOrHost(ctx, ctx.params.name);
    if (!app) throw new HttpError(404, 'unknown_app', `There is no app called "${ctx.params.name}".`);
    await rollback(app.name);
    store.audit(ctx.user, 'apps.rolled_back', { app: app.name });
    return send(ctx.res, 200, rowForBrowser(get(app.name)));
  });

  api.add('DELETE', 'admin/apps/:name', async (ctx) => {
    const app = ownedAppOrHost(ctx, ctx.params.name);
    if (!app) throw new HttpError(404, 'unknown_app', `There is no app called "${ctx.params.name}".`);
    removeApp(app.name);
    store.audit(ctx.user, 'apps.removed', { app: app.name });
    return send(ctx.res, 200, { ok: true });
  });

  api.add('GET', 'admin/apps/:name/logs', async (ctx) => {
    const app = ownedAppOrHost(ctx, ctx.params.name);
    if (!app) throw new HttpError(404, 'unknown_app', `There is no app called "${ctx.params.name}".`);
    const before = ctx.url.searchParams.get('before') ? Number(ctx.url.searchParams.get('before')) : null;
    return send(ctx.res, 200, db.all('SELECT * FROM function_logs WHERE app = ? AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT 200', app.name, before, before));
  });
}
