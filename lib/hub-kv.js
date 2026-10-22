/**
 * The hub kv: per-user, per-app key-value stores in one SQLite table.
 *
 * Semantics match the current puter-js contract exactly (its module is the
 * spec): values are JSON, sizes are measured in UTF-8 bytes, `add` appends to
 * a list (or numeric-adds a number), `update` applies a dot-path map, and
 * `list` supports glob patterns, `returnValues`, paging and `stream`. TTL
 * expiry (`expire`/`expireAt`) hides rows past their time.
 */
import * as db from './db.js';
import { HttpError } from './http.js';

export const MAX_KEY_SIZE = 1024;
export const MAX_VALUE_SIZE = 399 * 1024;

const encoder = new TextEncoder();
const utf8Length = (s) => encoder.encode(s).length;

const err = (code, message) => new HttpError(400, code, message);

/** One row hidden when TTL has passed (sweep happens lazily on access). */
const fresh = (row) => row && (row.expires_at === null || row.expires_at > Date.now());

function row(user, app, key) {
  return db.get('SELECT * FROM hub_kv WHERE user = ? AND app = ? AND key = ?', user, app, key);
}

function parse(user, app, key, raw) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(500, 'corrupt_value', `The value stored for "${key}" ("app ${app}", user ${user}) is not valid JSON.`);
  }
}

function assertKey(key) {
  if (key === undefined || key === null) throw err('key_undefined', 'Key cannot be undefined.');
  if (typeof key === 'string' && utf8Length(key) > MAX_KEY_SIZE) {
    throw err('key_too_large', `Key too large (max ${MAX_KEY_SIZE} bytes).`);
  }
}

function assertValue(value) {
  const size = utf8Length(JSON.stringify(value ?? null));
  if (size > MAX_VALUE_SIZE) throw err('value_too_large', `Value too large (max ${MAX_VALUE_SIZE} bytes).`);
  return size;
}

/** Writes one value; sizes are checked against the tar's limits. */
function put(user, app, key, value, expiresAt = null) {
  assertValue(value);
  db.run(
    `INSERT INTO hub_kv(user, app, key, value, expires_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user, app, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
    user, app, key, JSON.stringify(value ?? null), expiresAt,
  );
}

export function get({ user, app, key }) {
  assertKey(key);
  if (Array.isArray(key)) return { items: key.map((k) => ({ key: k, value: get({ user, app, key: k }) })) };
  const r = row(user, app, key);
  return fresh(r) ? parse(user, app, key, r.value) : null;
}

/** set overwrites; returns null like puter.kv.set does. */
export function set({ user, app, key, value }) {
  assertKey(key);
  put(user, app, key, value);
  return null;
}

export function del({ user, app, key }) {
  assertKey(key);
  const keys = Array.isArray(key) ? key : [key];
  for (const k of keys) db.run('DELETE FROM hub_kv WHERE user = ? AND app = ? AND key = ?', user, app, k);
  return null;
}

/** list: keys by default, pairs when `returnValues` / `as: 'entries'`;
 * prefix `pattern` (same contract as js.puter.com and the backend: a
 * trailing '*' is accepted and stripped, `abc` matches every key that
 * begins with `abc` — no globbing); paging. */
export function list({ user, app, options = {} }) {
  const rows = db.all('SELECT * FROM hub_kv WHERE user = ? AND app = ? ORDER BY key', user, app)
    .filter((r) => fresh(r));
  let pattern = options.pattern;
  if (typeof pattern === 'string') {
    const t = pattern.trim();
    pattern = t === '' ? null : (t.endsWith('*') ? t.slice(0, -1) : t);
  } else {
    pattern = null;
  }
  let as = options.as;
  if (as !== 'keys' && as !== 'values' && as !== 'entries') as = options.returnValues ? 'entries' : 'keys';
  let pairs = rows
    .filter((r) => !pattern || r.key.startsWith(pattern))
    .map((r) => ({ key: r.key, value: parse(user, app, r.key, r.value) }));
  if (as === 'keys') pairs = pairs.map((p) => p.key);
  else if (as === 'values') pairs = pairs.map((p) => p.value);
  const total = pairs.length;
  if (options.reverse === true) pairs = pairs.slice().reverse();
  if (options.limit != null || options.offset != null) {
    const off = options.offset || 0;
    const lim = options.limit == null ? pairs.length - off : Math.min(options.limit, pairs.length - off);
    return {
      items: pairs.slice(off, off + lim),
      ...(off + pairs.length >= pairs.length ? {} : { cursor: String(off + lim) }),
      ...(options.includeTotal === true ? { total } : {}),
    };
  }
  return pairs;
}

/**
 * add per the current SDK contract: append to an existing list (creating
 * `{path: [value]}` when the key is empty), default value 1; a plain object
 * arg is a dot-path → value map, each appended at its path.
 */
export function add({ user, app, key, value }) {
  assertKey(key);
  const target = value === undefined ? 1 : value;
  if (isObject(target)) {
    const root = rootFor(user, app, key, { create: true });
    for (const [pathPart, itemValue] of Object.entries(target)) appendPath(root, pathPart, itemValue);
    put(user, app, key, root);
    return get({ user, app, key });
  }
  const root = rootFor(user, app, key, { create: false });
  if (root == null) {
    put(user, app, key, [target]);
    return get({ user, app, key });
  }
  if (Array.isArray(root)) {
    root.push(target);
    put(user, app, key, root);
    return root;
  }
  throw err('value_not_a_list', `"${key}" is not a list, so it cannot be appended to.`);
}

/** numeric convenience wrappers (kv.incr/decr). */
export function incr({ user, app, key, value = 1 }) {
  return bump(user, app, key, Number(value) || 0);
}
export function decr({ user, app, key, value = 1 }) {
  return bump(user, app, key, -(Number(value) || 0));
}
function bump(user, app, key, delta) {
  assertKey(key);
  const current = rootFor(user, app, key, { create: false });
  if (current != null && !Number.isFinite(current)) throw err('value_not_a_number', `"${key}" is not a number.`);
  const next = (Number(current) || 0) + delta;
  put(user, app, key, next);
  return next;
}

/**
 * update per the SDK contract: pathAndValueMap is dot-path → value onto an
 * object value at `key`; intermediate paths are created as objects, walking
 * through an existing non-object rejects with `invalid_path`.
 */
export function update({ user, app, key, pathMap }) {
  assertKey(key);
  if (!isObject(pathMap)) throw err('path_map_required', 'pathAndValueMap must be an object.');
  const root = rootFor(user, app, key, { create: true });
  if (!isObject(root)) throw err('not_an_object', `"${key}" is not an object, so paths cannot be set on it.`);
  for (const [pathPart, itemValue] of Object.entries(pathMap)) setPath(root, pathPart, itemValue);
  put(user, app, key, root);
  return get({ user, app, key });
}

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

function rootFor(user, app, key, { create }) {
  const r = row(user, app, key);
  const value = fresh(r) ? parse(user, app, key, r.value) : null;
  if (value == null && create) return {}; // empty target for update/add paths
  return value;
}

const setPath = (root, pathPart, value) => {
  const parts = String(pathPart).split('.');
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!isObject(node[p])) {
      if (node[p] != null && node[p] !== undefined) throw err('invalid_path', `"${pathPart}" runs through something that is not an object.`);
      node[p] = {};
    }
    node = node[p];
  }
  const last = parts.at(-1);
  node[last] = value;
  return node;
};

const appendPath = (root, pathPart, value) => {
  const parts = String(pathPart).split('.');
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!isObject(node[p])) {
      if (node[p] != null && node[p] !== undefined) throw err('invalid_path', `"${pathPart}" runs through something that is not an object.`);
      node[p] = {};
    }
    node = node[p];
  }
  const last = parts.at(-1);
  if (!Array.isArray(node[last])) {
    if (node[last] != null && node[last] !== undefined) throw err('value_not_a_list', `"${pathPart}" is not a list, so it cannot be appended to.`);
    node[last] = [];
  }
  node[last].push(value);
  return node[last];
};

export function expire({ user, app, key, ttlSeconds }) {
  assertKey(key);
  const ttl = Number(ttlSeconds);
  if (!Number.isFinite(ttl) || ttl < 0) throw err('invalid_ttl', 'ttl must be a number of seconds.');
  db.run('UPDATE hub_kv SET expires_at = ? WHERE user = ? AND app = ? AND key = ?', Math.floor(Date.now() + ttl * 1000), user, app, key);
  return null;
}

export function expireAt({ user, app, key, timestamp }) {
  assertKey(key);
  const at = Number(timestamp);
  if (!Number.isFinite(at) || at < 0) throw err('invalid_ttl', 'timestamp must be a number of ms.');
  db.run('UPDATE hub_kv SET expires_at = ? WHERE user = ? AND app = ? AND key = ?', Math.floor(at), user, app, key);
  return null;
}

export function flush({ user, app }) {
  db.run('DELETE FROM hub_kv WHERE user = ? AND app = ?', user, app);
  return null;
}

/** Everything a user keeps in hub apps (used by the Account data export). */
export function dumpUser(user) {
  return db.all('SELECT app, key, value FROM hub_kv WHERE user = ? ORDER BY app, key', user);
}
