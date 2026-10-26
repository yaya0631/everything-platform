/**
 * Accounts, sessions, one-time tokens, key-value storage and the audit log,
 * all in data/cad.db. users.js uses the same functions, so accounts changed
 * from the command line apply immediately, even while the server runs.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as db from './db.js';
import { ROOT, DATA_DIR, APP_DIR, FILES_DIR } from './paths.js';

export { ROOT, DATA_DIR, APP_DIR };

const SESSION_DAYS = 30;
export const SESSION_MAX_AGE = SESSION_DAYS * 24 * 3600;

export const NAME_RULES = 'Usernames are 1 to 32 letters, digits, dots, dashes or underscores, starting with a letter or digit.';
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export function normalizeName(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase();
}

export function validName(name) {
  return NAME_RE.test(name) && !name.endsWith('.') && !RESERVED.test(name);
}

export function userRoot(name) {
  return path.join(FILES_DIR, name);
}

/** Write through a temporary file so a crash never leaves half a file. */
export function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Passwords -------------------------------------------------------------------------

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [kind, N, r, p, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const key = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(key, expected);
}

// A hash to check against when the username does not exist, so a wrong
// username takes as long as a wrong password.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

export const MIN_PASSWORD = 8;

export function checkPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw new Error(`Passwords need at least ${MIN_PASSWORD} characters.`);
  if (password.length > 1024) throw new Error('That password is too long.');
}

// Accounts --------------------------------------------------------------------------

const COLORS = ['#e5484d', '#f76b15', '#e2a336', '#46a758', '#12a594', '#0090ff', '#3e63dd', '#8e4ec6', '#d6409f', '#ab6400'];

export function defaultColor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

export const validEmail = (s) => typeof s === 'string' && s.length <= 254 && /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/.test(s);
export const validColor = (s) => typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s);

export function getAccount(name) {
  const row = db.get('SELECT * FROM users WHERE name = ?', normalizeName(name));
  return row ? { ...row } : null;
}

export function listUsers() {
  return db.all('SELECT * FROM users ORDER BY name').map((u) => ({ ...u }));
}

/** What the browser gets to know about an account. */
export function publicUser(a) {
  return {
    username: a.name,
    displayName: a.display_name || a.name,
    color: a.color || defaultColor(a.name),
    isAdmin: !!a.is_admin,
    canHostApps: !!(a.is_admin || a.can_host_apps),
    email: a.email || '',
  };
}

export const displayName = (name) => getAccount(name)?.display_name || name;

export function countAdmins() {
  return db.get('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND disabled = 0').n;
}

/**
 * Create an account. Without a password the account cannot sign in until an
 * invite is accepted. The first account becomes an admin when there is none.
 * Returns { admin } so callers can say so.
 */
export function addUser(name, password, { admin = false, email = '', displayName: dn = '' } = {}) {
  name = normalizeName(name);
  if (!validName(name)) throw new Error(`"${name}" is not a valid username. ${NAME_RULES}`);
  if (password != null) checkPassword(password);
  if (email && !validEmail(email)) throw new Error(`"${email}" is not a valid email address.`);
  return db.tx(() => {
    if (getAccount(name)) throw new Error(`"${name}" already has an account.`);
    const makeAdmin = admin || countAdmins() === 0;
    db.run(
      'INSERT INTO users(name, hash, stamp, created, display_name, email, color, is_admin, uuid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      name,
      password != null ? hashPassword(password) : null,
      crypto.randomUUID(),
      new Date().toISOString(),
      dn || null,
      email || null,
      defaultColor(name),
      makeAdmin ? 1 : 0,
      crypto.randomUUID(),
    );
    fs.mkdirSync(path.join(userRoot(name), 'Drawings'), { recursive: true, mode: 0o700 });
    return { admin: makeAdmin };
  });
}

const FIELDS = { displayName: 'display_name', email: 'email', color: 'color', isAdmin: 'is_admin', canHostApps: 'can_host_apps', disabled: 'disabled', notifyShares: 'notify_shares' };

/** Update profile fields and flags. Disabling an account signs it out everywhere. */
export function updateUser(name, fields) {
  const a = getAccount(name);
  if (!a) throw new Error(`There is no account called "${name}".`);
  const sets = [];
  const args = [];
  for (const [k, col] of Object.entries(FIELDS)) {
    if (!(k in fields)) continue;
    let v = fields[k];
    if (k === 'email') {
      v = String(v || '').trim();
      if (v && !validEmail(v)) throw new Error(`"${v}" is not a valid email address.`);
      v = v || null;
    } else if (k === 'displayName') {
      v = String(v || '').trim().slice(0, 64) || null;
    } else if (k === 'color') {
      if (v && !validColor(v)) throw new Error('Pick a colour like #3e63dd.');
      v = v || null;
    } else v = v ? 1 : 0;
    sets.push(`${col} = ?`);
    args.push(v);
  }
  if (!sets.length) return;
  db.tx(() => {
    if (fields.isAdmin === false || fields.disabled) {
      const others = db.get('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND disabled = 0 AND name <> ?', a.name).n;
      if (a.is_admin && !a.disabled && others === 0) throw new Error('This is the only admin. Make someone else an admin first.');
    }
    db.run(`UPDATE users SET ${sets.join(', ')} WHERE name = ?`, ...args, a.name);
    if (fields.disabled) signOutEverywhere(a.name);
  });
}

/** Changing the password also signs the person out everywhere (new stamp). */
export function setPassword(name, password) {
  checkPassword(password);
  const a = getAccount(name);
  if (!a) throw new Error(`There is no account called "${name}".`);
  db.tx(() => {
    db.run('UPDATE users SET hash = ?, stamp = ? WHERE name = ?', hashPassword(password), crypto.randomUUID(), a.name);
    db.run('DELETE FROM sessions WHERE user = ?', a.name);
  });
}

export function signOutEverywhere(name) {
  db.tx(() => {
    db.run('UPDATE users SET stamp = ? WHERE name = ?', crypto.randomUUID(), name);
    db.run('DELETE FROM sessions WHERE user = ?', name);
  });
}

const removeHooks = [];
/** Other modules clean up their own files here (for example history snapshots). */
export function onRemoveUser(fn) {
  removeHooks.push(fn);
}

export function removeUser(name, { deleteFiles = false } = {}) {
  const a = getAccount(name);
  if (!a) throw new Error(`There is no account called "${name}".`);
  let hist = [];
  db.tx(() => {
    const others = db.get('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND disabled = 0 AND name <> ?', a.name).n;
    if (a.is_admin && !a.disabled && others === 0 && db.get('SELECT COUNT(*) AS n FROM users').n > 1) {
      throw new Error('This is the only admin. Make someone else an admin first.');
    }
    db.run('DELETE FROM sessions WHERE user = ?', a.name);
    db.run('DELETE FROM users WHERE name = ?', a.name);
    db.run('DELETE FROM tokens WHERE user = ?', a.name);
    db.run('DELETE FROM file_shares WHERE owner = ? OR grantee = ?', a.name, a.name);
    db.run('DELETE FROM links WHERE owner = ?', a.name);
    db.run('DELETE FROM app_grants WHERE user = ? OR owner = ?', a.name, a.name);
    db.run("DELETE FROM kv WHERE ns = ? OR ns LIKE ? ESCAPE '\\'", `user:${a.name}`, `app:%:user:${a.name.replace(/[%_\\]/g, '\\$&')}`);
    hist = db.all('SELECT file FROM history WHERE owner = ?', a.name);
    db.run('DELETE FROM history WHERE owner = ?', a.name);
  });
  for (const fn of removeHooks) fn(a.name, { deleteFiles, history: hist });
  if (deleteFiles) fs.rmSync(userRoot(a.name), { recursive: true, force: true });
}

/** Returns the normalized username when the password matches, else null. */
export function checkLogin(username, password) {
  const name = normalizeName(username);
  const account = validName(name) ? getAccount(name) : null;
  const ok = verifyPassword(String(password ?? ''), account?.hash || DUMMY_HASH);
  return ok && account && account.hash && !account.disabled ? name : null;
}

// Sessions --------------------------------------------------------------------------

// Only a SHA-256 of each token is stored, so the database cannot be used to sign in.
export const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

export function createSession(name, { userAgent = '' } = {}) {
  const a = getAccount(name);
  if (!a) throw new Error(`There is no account called "${name}".`);
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.run(
    'INSERT INTO sessions(token_hash, user, stamp, created, expires, last_seen, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
    tokenHash(token),
    a.name,
    a.stamp,
    now,
    now + SESSION_MAX_AGE * 1000,
    now,
    String(userAgent || '').slice(0, 300),
  );
  return token;
}

/** { user, id, account } for a valid session token, else null. */
export function sessionInfo(token) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const h = tokenHash(token);
  const s = db.get('SELECT * FROM sessions WHERE token_hash = ?', h);
  if (!s || s.expires < Date.now()) return null;
  const account = getAccount(s.user);
  if (!account || account.disabled || account.stamp !== s.stamp) return null;
  if (!s.last_seen || Date.now() - s.last_seen > 60_000) db.run('UPDATE sessions SET last_seen = ? WHERE token_hash = ?', Date.now(), h);
  return { user: s.user, id: h.slice(0, 16), account };
}

/** The username for a session token, or null when it is unknown, expired, or the account changed. */
export function sessionUser(token) {
  return sessionInfo(token)?.user ?? null;
}

export function endSession(token) {
  if (token) db.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash(token));
}

export function listSessions(name) {
  return db
    .all('SELECT token_hash, created, last_seen, expires, user_agent FROM sessions WHERE user = ? AND expires > ? ORDER BY last_seen DESC', name, Date.now())
    .map((s) => ({ id: s.token_hash.slice(0, 16), created: s.created, lastSeen: s.last_seen, expires: s.expires, userAgent: s.user_agent || '' }));
}

export function endSessionById(name, id) {
  if (!/^[0-9a-f]{16}$/.test(String(id))) return false;
  return db.run('DELETE FROM sessions WHERE user = ? AND substr(token_hash, 1, 16) = ?', name, id).changes > 0;
}

export function countOnline(withinMs = 5 * 60_000) {
  return db.get('SELECT COUNT(DISTINCT user) AS n FROM sessions WHERE last_seen > ?', Date.now() - withinMs).n;
}

// One-time and bearer tokens -----------------------------------------------------------

/** kind: reset | invite | app | visitor. Returns the raw token; only its hash is stored. */
export function createToken(kind, { user = null, app = null, ttlMs, data = null }) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.run('INSERT INTO tokens(token_hash, kind, user, app, expires, data) VALUES (?, ?, ?, ?, ?, ?)', tokenHash(token), kind, user, app, Date.now() + ttlMs, data == null ? null : JSON.stringify(data));
  return token;
}

export function findToken(kind, token) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const row = db.get('SELECT * FROM tokens WHERE token_hash = ? AND kind = ?', tokenHash(token), kind);
  if (!row || row.expires < Date.now()) return null;
  return { ...row, data: row.data ? JSON.parse(row.data) : null };
}

export function deleteToken(token) {
  if (token) db.run('DELETE FROM tokens WHERE token_hash = ?', tokenHash(token));
}

export function deleteTokensFor(kind, user) {
  db.run('DELETE FROM tokens WHERE kind = ? AND user = ?', kind, user);
}

// Key-value storage ----------------------------------------------------------------------

export const MAX_KV_VALUE = 256 * 1024;
export const MAX_KV_KEY = 256;

export function kvGet(ns, key) {
  const row = db.get('SELECT value FROM kv WHERE ns = ? AND key = ?', ns, key);
  return row ? JSON.parse(row.value) : null;
}

export function kvSet(ns, key, value) {
  if (value === null || value === undefined) return kvDel(ns, key);
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > MAX_KV_VALUE) throw Object.assign(new Error('That value is larger than 256 KB.'), { code: 'too_large' });
  db.run('INSERT INTO kv(ns, key, value, updated) VALUES (?, ?, ?, ?) ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value, updated = excluded.updated', ns, key, text, Date.now());
}

export function kvDel(ns, key) {
  return db.run('DELETE FROM kv WHERE ns = ? AND key = ?', ns, key).changes > 0;
}

export function kvSize(ns) {
  return db.get('SELECT COALESCE(SUM(length(key) + length(value)), 0) AS n FROM kv WHERE ns = ?', ns).n;
}

/** Keys (optionally matching a prefix ending in *), with values when asked. */
export function kvList(ns, pattern = '*', withValues = false) {
  const prefix = String(pattern || '*').replace(/\*$/, '');
  const rows = db.all("SELECT key, value FROM kv WHERE ns = ? AND key LIKE ? ESCAPE '\\' ORDER BY key LIMIT 10000", ns, `${prefix.replace(/[%_\\]/g, '\\$&')}%`);
  return withValues ? rows.map((r) => ({ key: r.key, value: JSON.parse(r.value) })) : rows.map((r) => r.key);
}

export function kvIncr(ns, key, by = 1) {
  return db.tx(() => {
    const cur = Number(kvGet(ns, key)) || 0;
    const next = cur + (Number(by) || 0);
    kvSet(ns, key, next);
    return next;
  });
}

export function kvFlush(ns) {
  db.run('DELETE FROM kv WHERE ns = ?', ns);
}

// Audit and housekeeping ------------------------------------------------------------------

export function audit(actor, action, detail = {}) {
  db.run('INSERT INTO audit(at, actor, action, detail) VALUES (?, ?, ?, ?)', Date.now(), actor || null, action, JSON.stringify(detail));
}

/** Hourly: expired sessions and tokens, old function logs and audit entries. */
export function prune() {
  const now = Date.now();
  db.run('DELETE FROM sessions WHERE expires < ?', now);
  db.run('DELETE FROM tokens WHERE expires < ?', now);
  db.run('DELETE FROM audit WHERE at < ?', now - 365 * 24 * 3600 * 1000);
  db.run('DELETE FROM function_logs WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY app ORDER BY id DESC) AS rn FROM function_logs) WHERE rn > 1000)');
}
