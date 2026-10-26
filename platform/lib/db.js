/**
 * The SQLite database (data/cad.db) through Node's built-in node:sqlite, so
 * there is nothing native to install. The server, users.js and apps.js all open
 * the same file; WAL mode and a busy timeout let them do that safely.
 *
 * Migrations are numbered by PRAGMA user_version. On first open, the JSON files
 * the earlier version of CAD Home wrote (users.json, sessions.json, kv/*.json)
 * are imported and renamed to *.migrated.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, DB_FILE } from './paths.js';

// node:sqlite prints an ExperimentalWarning on load. Hide only that one and
// print every other warning the way Node normally does.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w?.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
  if (w?.name === 'DeprecationWarning' && process.noDeprecation) return;
  process.stderr.write(`(node:${process.pid}) ${w?.name || 'Warning'}: ${w?.message ?? w}\n`);
});
const { DatabaseSync } = await import('node:sqlite');

const MIGRATIONS = [
  // 1: everything the server needs.
  `
  CREATE TABLE users(name TEXT PRIMARY KEY, hash TEXT, stamp TEXT, created TEXT, display_name TEXT, email TEXT,
    color TEXT, is_admin INT DEFAULT 0, can_host_apps INT DEFAULT 0, disabled INT DEFAULT 0, notify_shares INT DEFAULT 1);
  CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, user TEXT REFERENCES users(name) ON DELETE CASCADE, stamp TEXT,
    created INT, expires INT, last_seen INT, user_agent TEXT);
  CREATE INDEX sessions_user ON sessions(user);
  CREATE TABLE tokens(token_hash TEXT PRIMARY KEY, kind TEXT, user TEXT, app TEXT, expires INT, data TEXT);
  CREATE TABLE kv(ns TEXT, key TEXT, value TEXT, updated INT, PRIMARY KEY(ns, key));
  CREATE TABLE file_shares(id INTEGER PRIMARY KEY, owner TEXT, path TEXT, grantee TEXT, mode TEXT, created INT,
    UNIQUE(owner, path, grantee));
  CREATE INDEX file_shares_grantee ON file_shares(grantee);
  CREATE TABLE links(token TEXT PRIMARY KEY, owner TEXT, path TEXT, mode TEXT, created INT, created_by TEXT,
    expires INT NULL, revoked INT NULL, last_used INT NULL, uses INT DEFAULT 0);
  CREATE INDEX links_owner_path ON links(owner, path);
  CREATE TABLE history(id INTEGER PRIMARY KEY, owner TEXT, path TEXT, file TEXT, created INT, size INT, reason TEXT, by TEXT);
  CREATE INDEX history_owner_path ON history(owner, path);
  CREATE TABLE ai_usage(id INTEGER PRIMARY KEY, at INT, user TEXT NULL, source TEXT, provider TEXT, model TEXT,
    input_tokens INT, output_tokens INT, ms INT, status TEXT, error TEXT);
  CREATE INDEX ai_usage_at ON ai_usage(at);
  CREATE TABLE email_log(id INTEGER PRIMARY KEY, at INT, user TEXT NULL, source TEXT, to_addr TEXT, subject TEXT,
    status TEXT, error TEXT);
  CREATE TABLE apps(name TEXT PRIMARY KEY, owner TEXT, title TEXT, description TEXT, visibility TEXT,
    public_ai INT DEFAULT 0, public_email INT DEFAULT 0, created INT, updated INT);
  CREATE TABLE app_env(app TEXT, key TEXT, value TEXT, PRIMARY KEY(app, key));
  CREATE TABLE app_grants(id TEXT PRIMARY KEY, user TEXT, app TEXT, owner TEXT, path TEXT, mode TEXT, created INT);
  CREATE INDEX app_grants_user_app ON app_grants(user, app);
  CREATE TABLE function_logs(id INTEGER PRIMARY KEY, at INT, app TEXT, fn TEXT, level TEXT, message TEXT);
  CREATE INDEX function_logs_app ON function_logs(app, id);
  CREATE TABLE config(key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE audit(id INTEGER PRIMARY KEY, at INT, actor TEXT, action TEXT, detail TEXT);
  CREATE INDEX audit_at ON audit(at);
  `,
  // 2: the hub — apps built from the HeyPuter/everything clone.
  `
  CREATE TABLE hub_apps(name TEXT PRIMARY KEY, title TEXT, sha TEXT, built_at INT, size INT, files INT,
    base TEXT, source TEXT, enabled INT DEFAULT 1, access TEXT DEFAULT 'all', users TEXT, meta TEXT);
  `,
  // 3: per-user, per-app key-value stores and Drive-path grants for hub apps.
  `
  CREATE TABLE hub_kv(user TEXT, app TEXT, key TEXT, value TEXT, expires_at INT,
    PRIMARY KEY(user, app, key));
  CREATE INDEX hub_kv_pattern ON hub_kv(user, app, key);
  CREATE TABLE hub_grants(id TEXT PRIMARY KEY, user TEXT, app TEXT, path TEXT,
    perms TEXT, source TEXT, granted_at INT, revoked_at INT NULL);
  CREATE INDEX hub_grants_active ON hub_grants(user, app, revoked_at);
  `,
  // 4: hub workers — the puter.workers registry (Phase 3) and its deploy log.
  // user NULL + app set = a packaged system worker copied from an app dist;
  // per-user name uniqueness keeps one person's deploy from taking another's
  // name (documented strictly-safer difference: upstream names are global).
  `
  CREATE TABLE hub_workers(id TEXT PRIMARY KEY, user TEXT NULL, app TEXT NULL, name TEXT,
    script_kind TEXT NOT NULL DEFAULT 'virtual', file_path TEXT NOT NULL, url_path TEXT NOT NULL,
    sha TEXT NULL, meta TEXT, created_at INT, updated_at INT);
  CREATE UNIQUE INDEX hub_workers_user_name ON hub_workers(user, name);
  CREATE UNIQUE INDEX hub_workers_app_name ON hub_workers(COALESCE(user, 'app'), name);
  CREATE INDEX hub_workers_owner ON hub_workers(user);
  CREATE TABLE hub_workers_log(id INTEGER PRIMARY KEY, at INT, user TEXT NULL, app TEXT NULL,
    action TEXT NOT NULL, name TEXT NOT NULL, sha TEXT NULL, detail TEXT);
  CREATE INDEX hub_workers_log_at ON hub_workers_log(at);
  `,
  // 5: shared static hosting, exposed on the public listener only.
  `
  CREATE TABLE hub_sites(subdomain TEXT PRIMARY KEY, user TEXT NOT NULL, app TEXT NOT NULL,
    root_dir TEXT NOT NULL, created_at INT NOT NULL, updated_at INT NOT NULL);
  CREATE INDEX hub_sites_user ON hub_sites(user);
  CREATE UNIQUE INDEX hub_sites_subdomain_ci ON hub_sites(LOWER(subdomain));
  `,
  // 6: canonical worker host labels used by the URL mapper. Worker names
  // remain owner-scoped; a colliding public host receives a stable suffix.
  `
  ALTER TABLE hub_workers ADD COLUMN host_label TEXT;
  CREATE UNIQUE INDEX hub_workers_host_label_ci ON hub_workers(LOWER(host_label)) WHERE host_label IS NOT NULL;
  `,
  // 7: account uuids. The upstream app workers (teamchat, legal, fleet, ...)
  // identify their caller through user.puter by uuid — puter's shape — not
  // by username, so every account carries one (backfilled on open).
  `
  ALTER TABLE users ADD COLUMN uuid TEXT;
  `,
];

let db = null;
const statements = new Map();

/** Byte-for-byte copy of cad.db (+wal/shm) into data\_dbrecover-<stamp>\.
 * Used by the startup integrity gate below: this is the backup that happens
 * BEFORE any decision on a suspicious database file. */
function dbRecoverCopy() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').replace(/\..*$/, '').slice(0, 14);
  const dir = path.join(DATA_DIR, `_dbrecover-${stamp}-${String(process.pid)}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
    try { fs.copyFileSync(f, path.join(dir, path.basename(f))); } catch { /* no such sidecar */ }
  }
  return dir;
}

export function open() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const fresh = !fs.existsSync(DB_FILE);
  if (!fresh) {
    // Startup integrity gate (a corrupted WAL once produced "database disk
    // image is malformed" — see the 2026-10-22 incident). Refuse to run on a
    // malformed file, but back up the EXACT bytes first, so nothing that
    // could be recovered is lost by the operator's next move.
    let ok = false;
    let probeErr = null;
    try {
      const probe = new DatabaseSync(DB_FILE, { readOnly: true });
      try { ok = probe.prepare('PRAGMA integrity_check').get().integrity_check === 'ok'; } finally { probe.close(); }
    } catch (e) {
      probeErr = e;
    }
    if (!ok) {
      const dir = dbRecoverCopy();
      const why = probeErr ? `cannot be opened (${probeErr.message})` : 'failed its integrity check';
      throw new Error(`cad-home: ${path.basename(DB_FILE)} ${why}. A byte-for-byte copy of the database was saved to "${dir}" before this message. Do not copy data\\ while the server is running (see README); fix or replace the file(s) in data\\ and start again.`);
    }
  }
  db = new DatabaseSync(DB_FILE);
  if (fresh) {
    try {
      fs.chmodSync(DB_FILE, 0o600);
    } catch {
      /* not supported on this file system */
    }
  }
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate();
  importJSON();
  backfillUuids();
  return db;
}

/** Every account has a stable uuid the workers identify callers by. */
function backfillUuids() {
  const missing = db.prepare("SELECT name FROM users WHERE uuid IS NULL OR uuid = ''").all();
  if (!missing.length) return;
  const up = db.prepare('UPDATE users SET uuid = ? WHERE name = ?');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of missing) up.run(crypto.randomUUID(), r.name);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function close() {
  if (!db) return;
  statements.clear();
  // Folding the WAL back into the main file on a CLEAN shutdown keeps every
  // later whole-file copy complete (see README: do not copy data\ while the
  // server runs). Best effort — a checkpoint failure must not block exit.
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    /* the db may already be wedged; exit proceeds */
  }
  try {
    db.close();
  } catch {
    /* already closed */
  }
  db = null;
}

/** A cached prepared statement. */
export function q(sql) {
  open();
  let s = statements.get(sql);
  if (!s) {
    s = db.prepare(sql);
    statements.set(sql, s);
  }
  return s;
}

const bindArgs = (args) => args.map((value) => value === undefined ? null : value);
export const get = (sql, ...args) => q(sql).get(...bindArgs(args));
export const all = (sql, ...args) => q(sql).all(...bindArgs(args));
export const run = (sql, ...args) => q(sql).run(...bindArgs(args));

let depth = 0;
/** Run fn inside one transaction (nested calls join the outer one). */
export function tx(fn) {
  open();
  if (depth) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth++;
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw err;
  } finally {
    depth--;
  }
}

/** Copy the database to a file while it is in use (for backups). */
export function backupTo(file) {
  open();
  db.prepare('VACUUM INTO ?').run(file);
}

function migrate() {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Could not update the database (step ${v + 1}): ${err.message}`);
    }
  }
}

function readJSON(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw new Error(`Could not read ${file} to import it: ${err.message}`);
  }
  // BOM-tolerant: state files may have been re-saved by PowerShell.
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

/** Bring in the JSON files from before the database existed. Safe to run any number of times. */
function importJSON() {
  const usersFile = path.join(DATA_DIR, 'users.json');
  const sessionsFile = path.join(DATA_DIR, 'sessions.json');
  const kvDir = path.join(DATA_DIR, 'kv');
  const users = readJSON(usersFile);
  const sessions = readJSON(sessionsFile);
  let kvFiles = [];
  try {
    kvFiles = fs.readdirSync(kvDir).filter((f) => f.endsWith('.json'));
  } catch {
    /* nothing to import */
  }
  if (users === undefined && sessions === undefined && !kvFiles.length) return;

  const done = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    if (users !== undefined) {
      const ins = db.prepare('INSERT OR IGNORE INTO users(name, hash, stamp, created) VALUES (?, ?, ?, ?)');
      for (const [name, u] of Object.entries(users?.users || {})) ins.run(name, u.hash ?? null, u.stamp ?? null, u.created ?? new Date().toISOString());
      done.push(usersFile);
    }
    if (sessions !== undefined) {
      const exists = db.prepare('SELECT 1 FROM users WHERE name = ?');
      const ins = db.prepare('INSERT OR IGNORE INTO sessions(token_hash, user, stamp, created, expires, last_seen) VALUES (?, ?, ?, NULL, ?, NULL)');
      for (const [hash, s] of Object.entries(sessions || {})) {
        if (!s || s.expires < Date.now() || !exists.get(s.user)) continue;
        ins.run(hash, s.user, s.stamp, s.expires);
      }
      done.push(sessionsFile);
    }
    const ins = db.prepare('INSERT OR IGNORE INTO kv(ns, key, value, updated) VALUES (?, ?, ?, ?)');
    for (const f of kvFiles) {
      const file = path.join(kvDir, f);
      const data = readJSON(file) || {};
      const user = f.slice(0, -5);
      for (const [key, value] of Object.entries(data)) if (value != null) ins.run(`user:${user}`, key, JSON.stringify(value), Date.now());
      done.push(file);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  for (const file of done) fs.renameSync(file, `${file}.migrated`);
  if (done.length) console.log(`Moved ${done.length} file(s) of earlier data into ${path.basename(DB_FILE)}.`);
}
