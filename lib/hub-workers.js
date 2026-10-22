/**
 * Hub workers â€” the server side of `puter.workers` (Phase 3).
 *
 * Registry only: everything about RESOLVING and RUNNING a deploy lives in
 * hub-workers-run.js (parent) and worker-runner.js (child), and the HTTP
 * surface lives in hub-data routes + server mounts.
 *
 * Script sources:
 *   - kind 'virtual': a file in a member's cloud space (the calling app's
 *     sandbox or a consent-granted Drive path), read through the same
 *     access() rules as any other app read â€” no new path class;
 *   - kind 'packaged': copied from an installed app dist at install/update
 *     time into data/hub/workers/<app>/<name>.js, server-owned content.
 *
 * Names are unique per owner (upstream's are global; documented difference:
 * one person's deploy can never take another's name). Every mutation writes
 * a hub_workers_log row.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import * as db from './db.js';
import * as config from './config.js';
import { DATA_DIR } from './paths.js';
import { HttpError } from './http.js';

/** Â§20 audit reads: member-scoped and admin-wide views of hub_workers_log. */
export function recentLogsFor(user, limit = 100) {
  return db.all(
    'SELECT * FROM hub_workers_log WHERE user = ? ORDER BY at DESC, id DESC LIMIT ?',
    user, Math.min(500, Math.max(1, limit)),
  );
}

export function recentLogsAll(limit = 100) {
  return db.all(
    'SELECT * FROM hub_workers_log ORDER BY at DESC, id DESC LIMIT ?',
    Math.min(500, Math.max(1, limit)),
  );
}

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{1,63}$/;
/** Hard caps (Â§12). The config keys in the comments move the soft ones. */
export const MAX_SCRIPT_BYTES = 1024 * 1024; // 1 MiB runtime script cap
export const MAX_KV_TOTAL_KEY = 'limits.workers_kv_mb'; // â†’ MB, default 2

export const DEFAULT_WORKERS_CONFIG = {
  'workers.per_user_max': 8,
  'workers.script_bytes': MAX_SCRIPT_BYTES,
  'workers.timeout_ms': 30_000,
  'workers.memory_mb': 128,
  'workers.rss_mb': 256,
  'workers.pool_rss_budget_mb': 512,
  'workers.pool_max': 8,
  'workers.concurrency': 1, // per-worker concurrent in-flight calls (1 = serialized)
  'workers.max_response_mb': 8,
  'workers.email_per_worker_10min': 50,
  'workers.email_per_user_day': 200,
  'workers.email_recipients_max': 10,
  'workers.allow_public_user_workers': false, // §18: arbitrary member code stays private unless an admin turns this on
  'workers.alloc_cap_mb': 64, // single-allocation cap for worker code (runner layer 2d, best-effort)
  'workers.public_base_url': '', // §23: absolute guest origin for member-worker links (dep.url becomes <base>/w/<user>/<name>/)
  'workers.public_auto_approve': false, // with the §18 toggle on: create() publicly serves member deploys without a second admin click (audited)
};

export const cfg = (key, fallback) => {
  const v = config.get(key, DEFAULT_WORKERS_CONFIG[key] ?? fallback);
  if (DEFAULT_WORKERS_CONFIG[key] === undefined && fallback !== undefined) return v ?? fallback;
  return v;
};

const now = () => Date.now();
const newId = () => randomUUID();

export const puterDir = () => path.join(DATA_DIR, 'hub', 'workers');

/**
 * Â§10: install a PACKAGED system worker from an app dist â€” the app's own
 * `workers/<name>.js` files become server-owned registry rows (`user`
 * NULL + `app` set), served at `/wr/app/<app>/<name>/`, runnable at the
 * same runtime and limits as user workers, and visible for approval in
 * Admin â†’ Hub. nobody's personal deploy can shadow one (member exec
 * resolves the packaged row first by name) or delete it (delete is
 * owner-scoped). A CHANGED source means a changed sha â†’ the record's
 * public approval resets automatically (Â§22 note: private routes go live
 * immediately, public needs re-approval) and a `redeploy` audit row lands
 * â€” mirroring upstream's overwrite-redeploy rule.
 *
 * `textTransform` (optional) is the packaging-time rewrite from design
 * Â§10 layer 2 â€” an app's productization step passes it when the worker
 * composes links that must become local URLs from the start (never a
 * blind global rewrite).
 */
export async function installPackagedFromDist(app, distDir, { say = console.log, textTransform = null } = {}) {
  const workersDir = path.join(distDir, 'workers');
  if (!fs.existsSync(workersDir)) return [];
  const names = fs.readdirSync(workersDir).filter((f) => f.endsWith('.js'));
  for (const fileName of names) {
    const name = fileName.replace(/\.js$/, '');
    validateName(name);
    let text = fs.readFileSync(path.join(workersDir, fileName), 'utf8');
    if (typeof textTransform === 'function') text = String(textTransform(text, name));
    const dest = packagedScriptPath(app, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
    const sha = hashOf(text);
    const existing = db.get('SELECT * FROM hub_workers WHERE user IS NULL AND app = ? AND name = ?', app, name);
    let action = 'install';
    if (existing) {
      // Reinstall: approval survives an UNCHANGED source; a CHANGED sha is the
      // Â§22 redeploy rule â€” approval resets, a `redeploy` audit row lands.
      const oldMeta = JSON.parse(existing.meta || '{}');
      const meta = { ...oldMeta, packagedOriginSha: sha, packagedFrom: String(distDir) };
      if (sha !== existing.sha) {
        meta.public = false;
        meta.publicApproved = false;
        action = 'redeploy';
      }
      db.run(
        'UPDATE hub_workers SET sha = ?, file_path = ?, meta = ?, updated_at = ? WHERE id = ?',
        sha, `${name}.js`, JSON.stringify(meta), now(), existing.id,
      );
      log(null, app, action, name, sha, existing.sha === sha ? 'unchanged source' : 'source changed');
    } else {
      create({ user: null, app, name, filePath: dest, initialSha: sha, meta: { public: false, publicApproved: false, packagedOriginSha: sha, packagedFrom: String(distDir) } });
    }
    say(`packaged worker ${app}/${name} installed (${sha.slice(0, 12)})`);
  }
  return names.map((f) => f.replace(/\.js$/, ''));
}
export const packagedScriptPath = (app, name) => path.join(puterDir(), app, `${name}.js`);

function validateName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new HttpError(400, 'bad_name', 'Worker names are 2â€“64 characters: letters, digits and dashes, starting with a letter or digit.');
  }
}

/** Registry row for one owner identity: (user, name) or (app=<packaged>, name). */
function rowFor({ user, app }, name) {
  validateName(name);
  const row = user
    ? db.get('SELECT * FROM hub_workers WHERE user = ? AND name = ?', user, name)
    : db.get('SELECT * FROM hub_workers WHERE user IS NULL AND app = ? AND name = ?', app ?? '', name);
  if (!row) throw new HttpError(404, 'worker_not_found', `No worker named "${name}" ${user ? `for ${user}` : `for app ${app}`}.`);
  return row;
}

function log(user, app, action, name, sha, detail) {
  try {
    db.run('INSERT INTO hub_workers_log(at, user, app, action, name, sha, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
      now(), user ?? null, app ?? null, action, name ?? '', sha ?? null, detail ? String(detail).slice(0, 400) : null);
  } catch {
    /* the audit trail must never break the flow */
  }
}

export function meta(row) {
  try { return JSON.parse(row.meta || '{}'); } catch { return {}; }
}

function shape(row) {
  const m = meta(row);
  const hostLabel = canonicalHostLabel(row);
  return {
    name: row.name,
    // Where this worker answers. Member workers with a §23 public base
    // configured get the ABSOLUTE guest URL — apps build their public
    // sign/RSVP links from dep.url; without a base the relative private
    // /wr/ path stays (same-origin use, the old shape).
    url: `https://${hostLabel}.puter.work`,
    host_label: hostLabel,
    file_path: row.file_path,
    created_at: row.created_at,
    public: !!m.public,
    publicApproved: !!m.publicApproved,
    kind: row.script_kind,
    app: row.app ?? null,
    user: row.user ?? null,
  };
}

function allocateHostLabel({ name, user, app, id = null }) {
  const base = String(name || '').toLowerCase();
  const identity = user ? `user:${user}` : `app:${app || ''}`;
  const suffix = createHash('sha256').update(identity).digest('hex').slice(0, 8);
  const collides = (label) => id
    ? db.get(`SELECT id FROM hub_workers WHERE id <> ? AND (LOWER(host_label) = LOWER(?)
        OR (host_label IS NULL AND LOWER(name) = LOWER(?))) LIMIT 1`, id, label, label)
    : db.get(`SELECT id FROM hub_workers WHERE LOWER(host_label) = LOWER(?)
        OR (host_label IS NULL AND LOWER(name) = LOWER(?)) LIMIT 1`, label, label);
  let label = base.length <= 63 ? base : `${base.slice(0, 54)}-${suffix}`;
  if (collides(label)) label = `${base.slice(0, 54)}-${suffix}`;
  let n = 0;
  while (collides(label)) {
    n += 1;
    label = `${base.slice(0, 50)}-${suffix}-${n.toString(36)}`;
  }
  return label;
}

/** Give every worker a stable, DNS-safe canonical host label. */
export function canonicalHostLabel(row) {
  if (row.host_label) return row.host_label;
  const label = allocateHostLabel(row);
  db.run('UPDATE hub_workers SET host_label = ? WHERE id = ?', label, row.id);
  row.host_label = label;
  return label;
}

/** Resolve a canonical worker hostname. Ambiguous legacy rows fail closed. */
export function resolveHostLabel(label) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(String(label || ''))) return null;
  const row = db.get('SELECT * FROM hub_workers WHERE LOWER(host_label) = LOWER(?)', label);
  if (row) return row;
  const legacy = db.all('SELECT * FROM hub_workers WHERE LOWER(name) = LOWER(?) ORDER BY created_at, id', label);
  if (legacy.length !== 1) return null;
  canonicalHostLabel(legacy[0]);
  return legacy[0];
}

export const urlPath = (row) => (row.user ? `/wr/${row.user}/${row.name}/` : `/wr/app/${row.app}/${row.name}/`);

/** Create one deploy record. Returns the record upstream shapes rely on. */
export function create({ user = null, app = null, name, filePath, meta: extraMeta = {}, initialSha = null }) {
  validateName(name);
  if (!user && !app) throw new HttpError(400, 'bad_worker_source', 'A worker needs an owner (user) or a packaged app.');

  let kind;
  let storedPath;
  if (app && user == null) {
    // Packaged: the install step already rewrote + copied the script; its
    // existence is re-checked each serve (hub-workers-run reads it there).
    kind = 'packaged';
    storedPath = `${name}.js`;
    if (!fs.existsSync(packagedScriptPath(app, name))) {
      throw new HttpError(400, 'script_missing', `No packaged worker script for ${app}/${name}.`);
    }
  } else {
    kind = 'virtual';
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new HttpError(400, 'script_missing', 'workers.create needs the path of a script file in your cloud space.');
    }
    if (filePath.includes('..') || path.isAbsolute(filePath)) {
      throw new HttpError(400, 'bad_path', 'That script path is not allowed.');
    }
    storedPath = filePath;
  }

  const existing = user
    ? db.get('SELECT * FROM hub_workers WHERE user = ? AND name = ?', user, name)
    : db.get('SELECT * FROM hub_workers WHERE user IS NULL AND app = ? AND name = ?', app ?? '', name);

  const byUser = user
    ? db.get('SELECT COUNT(*) AS n FROM hub_workers WHERE user = ?', user).n
    : 0;
  if (!existing && user && byUser >= cfg('workers.per_user_max')) {
    throw new HttpError(429, 'quota_exceeded', `You already have ${byUser} workers (limit ${cfg('workers.per_user_max')}). Delete one first.`);
  }

  const id = existing?.id || newId();
  const hostLabel = existing
    ? canonicalHostLabel(existing)
    : allocateHostLabel({ name, user, app });
  // §18 + §23: an admin who turned the public toggle AND auto-approve on
  // gets member deploys served publicly at create time, no second click.
  // Audited as its own action so the Admin log shows exactly what happened.
  const auto = !!(user && !existing && cfg('workers.allow_public_user_workers') && cfg('workers.public_auto_approve'));
  const insertMeta = auto ? { ...extraMeta, public: true, publicApproved: true } : extraMeta;
  db.run(
    'INSERT INTO hub_workers(id, user, app, name, script_kind, file_path, url_path, sha, meta, created_at, updated_at, host_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, user ?? null, app ?? null, name, kind, storedPath,
    user ? `/wr/${user}/${name}/` : `/wr/app/${app}/${name}/`,
    initialSha, JSON.stringify(insertMeta), now(), now(), hostLabel,
  );
  log(user, app, existing ? 'create_existing' : 'create', name, initialSha, kind === 'virtual' ? filePath : 'packaged');
  if (auto) log(user, app, 'auto-approved', name, initialSha, 'public serving granted at create (workers.public_auto_approve)');
  const row = rowFor({ user, app }, name);
  return { ...shape(row), sha: row.sha, success: true };
}

/**
 * Script validation shared by the create route (the caller app's access()
 * read happens there, not here). A deployable script must be JavaScript and
 * â‰¤ MAX_SCRIPT_BYTES.
 */
export function assertScript(text) {
  if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'script_empty', 'That file is empty â€” there is nothing to deploy.');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > (cfg('workers.script_bytes') || MAX_SCRIPT_BYTES)) {
    throw new HttpError(413, 'script_too_large', `Worker scripts can be ${MAX_SCRIPT_BYTES / 1024 | 0} KiB. That one is ${(bytes / 1024) | 0} KiB.`);
  }
  return bytes;
}

/** list() â€” per owner, newest first (upstream returns array or {items}). */
export function listFor({ user, app }) {
  const rows = user
    ? db.all('SELECT * FROM hub_workers WHERE user = ? ORDER BY created_at DESC', user)
    : db.all('SELECT * FROM hub_workers WHERE user IS NULL AND app = ? ORDER BY created_at DESC', app ?? '');
  return rows.map(shape);
}

/** delete() â€” idempotent-ish: deleting an unknown name is a named error. */
export async function deployDelete({ user, app }, name) {
  const row = rowFor({ user, app }, name);
  db.run('DELETE FROM hub_workers WHERE id = ?', row.id);
  log(user, app, 'delete', name, row.sha);
  return true;
}

/** The redeploy hook: which worker (if any) is deployed from this exact path? */
export function deployedAt({ user, app }, virtualPath) {
  return db.get(
    'SELECT * FROM hub_workers WHERE user = ? AND app = ? AND script_kind = ? AND LOWER(file_path) = LOWER(?)',
    user ?? null, app ?? '', 'virtual', virtualPath ?? '',
  );
}

/** Mark a source file touched â€” sha recomputed on the next serve. */
export function invalidate({ user, app }, virtualPath) {
  const row = deployedAt({ user, app }, virtualPath);
  if (!row) return false;
  db.run('UPDATE hub_workers SET sha = NULL, updated_at = ? WHERE id = ?', now(), row.id);
  log(user, app, 'source-change', row.name, null, virtualPath);
  return true;
}

/** Owner deletion cleanup (Â§13): called by the account-removal path. */
export function purgeUser(user) {
  const rows = db.all('SELECT * FROM hub_workers WHERE user = ?', user);
  db.run('DELETE FROM hub_workers WHERE user = ?', user);
  for (const r of rows) log(null, r.app, 'owner_deleted', r.name, r.sha, `user ${user} removed`);
  return rows.length;
}

/* -- public exposure (Â§9/Â§18) ------------------------------------------- */

export function requestPublic({ user, app }, name) {
  const row = rowFor({ user, app }, name);
  const m = meta(row);
  m.public = true; // requested; takes effect only once approved
  db.run('UPDATE hub_workers SET meta = ?, updated_at = ? WHERE id = ?', JSON.stringify(m), now(), row.id);
  log(user, app, 'request-public', name, row.sha);
  return shape(db.get('SELECT * FROM hub_workers WHERE id = ?', row.id));
}

export function approvePublic({ user, app }, name, approved = true) {
  const row = rowFor({ user, app }, name);
  if (row.user && !cfg('workers.allow_public_user_workers')) {
    // Â§18: arbitrary member code stays private unless the admin toggle is on.
    // Packaged (dist-sourced) workers always qualify for approval.
    throw new HttpError(403, 'public_worker_toggle_off', 'Publishing a member-deployed worker is disabled on this server. An admin can enable it.');
  }
  const m = meta(row);
  m.public = true;
  m.publicApproved = !!approved;
  db.run('UPDATE hub_workers SET meta = ?, updated_at = ? WHERE id = ?', JSON.stringify(m), now(), row.id);
  log(user, app, approved ? 'approve-public' : 'revoke-public', name, row.sha);
  return shape(db.get('SELECT * FROM hub_workers WHERE id = ?', row.id));
}

export function isPublicServing(row) {
  const m = meta(row);
  return !!m.public && !!m.publicApproved;
}

export function recordDeploy(row, sha, action) {
  db.run('UPDATE hub_workers SET sha = ?, updated_at = ? WHERE id = ?', sha, now(), row.id);
  log(row.user, row.app, action, row.name, sha);
}

/* -- resolution ---------------------------------------------------------- */

/** Resolve a route of the shape /wr/<user>/<name>/ or /w/<label>/... (guest).
 *  Packaged rows: pass { app, name } for an exact match, or just the name to
 *  find the packaged worker with that (hard-coded) system name. */
export function resolveRoute({ user, app, name }) {
  const row = user
    ? db.get('SELECT * FROM hub_workers WHERE user = ? AND name = ?', user, name)
    : app !== undefined && app !== null
      ? db.get('SELECT * FROM hub_workers WHERE user IS NULL AND app = ? AND name = ?', app, name)
      : db.get('SELECT * FROM hub_workers WHERE user IS NULL AND name = ?', name);
  return row || null;
}

export const logRow = log;
export const shapeOf = shape;
export const hashOf = (text) => createHash('sha256').update(text).digest('hex');

/** Add the workers settings to the config module's documented defaults. */
export function registerConfigDefaults() {
  for (const [k, v] of Object.entries(DEFAULT_WORKERS_CONFIG)) {
    if (config.DEFAULTS[k] === undefined) config.DEFAULTS[k] = v;
  }
}
