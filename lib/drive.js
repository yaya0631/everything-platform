/**
 * Each person's drive (data/files/<user>/) and who may reach what in it.
 *
 * Paths the browser uses:
 *   Drawings/a.cad, /Drawings/a.cad, /<me>/Drawings/a.cad   my own drive
 *   /@sam/Projects/a.cad                                     sam's file, through a share
 *   notes/a.txt, ~grant/<id>/a.txt                           inside a hosted app (resolveApp)
 *
 * resolve() returns { full, rel, owner, ownerRel, mode } where mode is
 * own | edit | view, or throws a 400/403/404 HttpError.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import * as db from './db.js';
import * as store from './store.js';
import { assertInsideRoot } from './hub-fsauth.js';
import { HttpError, send, readJSONBody } from './http.js';

export const MAX_FILE = (Number(process.env.CAD_MAX_FILE_MB) || 200) * 1024 * 1024;

// Also rejects names Windows cannot store, so a drive can move between systems.
export const BAD_SEGMENT = /[<>:"|?*\u0000-\u001f]|^\.\.?$|[. ]$/;
const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const badSegment = (s) => BAD_SEGMENT.test(s) || RESERVED_NAME.test(s) || s.length > 255;

const WIN = process.platform === 'win32';
const fold = (p) => (WIN ? p.toLowerCase() : p);

/** True when p is base or inside base (both owner-relative, starting with /). */
export function within(p, base) {
  const a = fold(p);
  const b = fold(base);
  return b === '/' || a === b || a.startsWith(`${b}/`);
}

/** Live editing and sharing register here, so the drive does not import them. */
export const hooks = {
  isLive: (_owner, _ownerRel) => false,
  onDelete: [],
  onRename: [],
};

function split(raw) {
  const parts = String(raw ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.' && s !== '~');
  if (parts.some(badSegment)) throw new HttpError(400, 'bad_path', 'That file name is not allowed.');
  if (parts.join('/').length > 1024) throw new HttpError(400, 'bad_path', 'That path is too long.');
  return parts;
}

/** The full path on disk for an owner-relative path, kept inside that owner's folder. */
export function ownerFull(owner, ownerRel) {
  const root = store.userRoot(owner);
  const parts = split(ownerRel);
  const full = parts.length ? path.join(root, ...parts) : root;
  if (full !== root && !full.startsWith(root + path.sep)) throw new HttpError(400, 'bad_path', 'That path is outside the drive.');
  // A reparse point planted under the owner's root would make the lexical
  // check above pass while the operation walks through the link — the real
  // path is what counts (same helper the hub fs uses).
  assertInsideRoot(full, root);
  return full;
}

/** Compatibility helper: a path in the person's own drive. */
export function drivePath(user, raw) {
  const parts = split(raw);
  if (parts[0] === user && parts.length > 1) parts.shift();
  if (!parts.length) throw new HttpError(400, 'bad_path', 'A file path is required.');
  const rel = `/${parts.join('/')}`;
  return { full: ownerFull(user, rel), rel };
}

/** The most permissive share from owner to grantee covering ownerRel, or null. */
export function shareFor(owner, ownerRel, grantee) {
  let best = null;
  for (const s of db.all('SELECT path, mode FROM file_shares WHERE owner = ? AND grantee = ?', owner, grantee)) {
    if (!within(ownerRel, s.path)) continue;
    if (!best || (s.mode === 'edit' && best.mode !== 'edit') || (s.mode === best.mode && s.path.length > best.path.length)) best = { path: s.path, mode: s.mode };
  }
  return best;
}

const notShared = () => new HttpError(404, 'not_found', 'That file was not found on the server.');

/**
 * need: view (read or list) | edit (write or create) | delete (edit, and not the
 * shared item itself).
 */
export function resolve(user, raw, need = 'view') {
  const parts = split(raw);
  if (parts[0]?.startsWith('@')) {
    const owner = store.normalizeName(parts[0].slice(1));
    const rest = parts.slice(1);
    if (owner !== user) {
      if (!store.validName(owner) || !store.getAccount(owner)) throw notShared();
      const ownerRel = `/${rest.join('/')}`;
      const share = rest.length ? shareFor(owner, ownerRel, user) : null;
      if (!share) throw notShared();
      if ((need === 'edit' || need === 'delete') && share.mode !== 'edit') throw new HttpError(403, 'view_only', 'You can view this item but not change it.');
      if (need === 'delete' && fold(ownerRel) === fold(share.path)) throw new HttpError(403, 'share_root', 'Only the owner can delete a shared item.');
      return { full: ownerFull(owner, ownerRel), rel: `/@${owner}${ownerRel}`, owner, ownerRel, mode: share.mode, shareRoot: share.path };
    }
    parts.shift();
  } else if (parts[0] === user && parts.length > 1) parts.shift();
  const ownerRel = `/${parts.join('/')}`;
  if (ownerRel === '/' && need !== 'view') throw new HttpError(400, 'bad_path', 'A file path is required.');
  return { full: ownerFull(user, ownerRel), rel: ownerRel, owner: user, ownerRel, mode: 'own' };
}

/** Can user still reach owner's ownerRel, and how? own | edit | view | null */
export function accessMode(user, owner, ownerRel) {
  if (user === owner) return 'own';
  return shareFor(owner, ownerRel, user)?.mode ?? null;
}

// Hosted apps ---------------------------------------------------------------------------

export const appFolder = (app) => `/AppData/${app}`;

/**
 * A path as a hosted app sees it. Relative paths stay inside the person's
 * AppData/<app>/ folder; ~grant/<id>/… reaches files the person picked.
 */
export function resolveApp(user, app, raw, need = 'view') {
  const text = String(raw ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (text === '~grant' || text.startsWith('~grant/')) {
    const [, id, ...sub] = text.split('/').filter(Boolean);
    const grant = db.get("SELECT * FROM app_grants WHERE id = ? AND user = ? AND app = ? AND mode <> 'email'", String(id || ''), user, app);
    if (!grant) throw new HttpError(404, 'not_found', 'The app no longer has access to that file.');
    const subParts = split(sub.join('/'));
    if ((need === 'edit' || need === 'delete') && grant.mode !== 'edit') throw new HttpError(403, 'view_only', 'The app may read this file but not change it.');
    if (need === 'delete' && !subParts.length) throw new HttpError(403, 'grant_root', 'The app cannot delete a file you picked.');
    const ownerRel = path.posix.join(grant.path, ...subParts);
    const viaShare = grant.owner === user ? `${ownerRel}` : `/@${grant.owner}${ownerRel}`;
    const t = resolve(user, viaShare, need === 'delete' ? 'edit' : need);
    return { ...t, rel: `~grant/${grant.id}${subParts.length ? `/${subParts.join('/')}` : ''}`, grant: grant.id };
  }
  const parts = split(raw);
  if (parts[0]?.startsWith('@')) throw new HttpError(400, 'bad_path', 'Apps can only use their own folder and files you pick.');
  const ownerRel = path.posix.join(appFolder(app), ...parts);
  if (!parts.length && need !== 'view') throw new HttpError(400, 'bad_path', 'A file path is required.');
  return { full: ownerFull(user, ownerRel), rel: parts.join('/'), owner: user, ownerRel, mode: 'own', appRoot: !parts.length };
}

// File operations -------------------------------------------------------------------------

export function notFound(err) {
  if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return new HttpError(404, 'not_found', 'That file was not found on the server.');
  return err;
}

export function itemFor(rel, stat, extra) {
  const name = rel === '/' || rel === '' ? '' : path.posix.basename(rel);
  return { name, path: rel, is_dir: stat.isDirectory(), size: stat.size, modified: stat.mtimeMs, created: stat.birthtimeMs || stat.ctimeMs, ...extra };
}

const childRel = (rel, name) => (rel === '' ? name : rel === '/' ? `/${name}` : `${rel}/${name}`);

export async function listDir(t, { sortBy, sortOrder, cursor, limit } = {}) {
  let names;
  try {
    names = await fsp.readdir(t.full);
  } catch (err) {
    if (t.appRoot && err.code === 'ENOENT') names = [];
    else throw notFound(err);
  }
  const items = [];
  for (const n of names) {
    if (badSegment(n) || n.endsWith('.tmp')) continue;
    try {
      items.push(itemFor(childRel(t.rel, n), await fsp.stat(path.join(t.full, n))));
    } catch {
      /* removed while listing */
    }
  }
  const key = { name: (i) => i.name.toLowerCase(), size: (i) => i.size, modified: (i) => i.modified }[sortBy] || ((i) => i.name.toLowerCase());
  const dir = sortOrder === 'desc' ? -1 : 1;
  items.sort((a, b) => (key(a) < key(b) ? -dir : key(a) > key(b) ? dir : 0));
  const start = Math.max(0, parseInt(cursor || '0', 10) || 0);
  const n = Math.min(1000, Math.max(1, parseInt(limit || '100', 10) || 100));
  return { items: items.slice(start, start + n), cursor: start + n < items.length ? String(start + n) : null };
}

export async function statItem(t) {
  try {
    return itemFor(t.rel, await fsp.stat(t.full), t.mode !== 'own' ? { mode: t.mode } : undefined);
  } catch (err) {
    throw notFound(err);
  }
}

export async function fileStat(t) {
  let stat;
  try {
    stat = await fsp.stat(t.full);
  } catch (err) {
    throw notFound(err);
  }
  if (!stat.isFile()) throw new HttpError(404, 'not_found', 'That file was not found on the server.');
  return stat;
}

export async function sendFile(res, t) {
  const stat = await fileStat(t);
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'no-store' });
  await pipeline(fs.createReadStream(t.full), res);
}

function checkLive(t) {
  if (hooks.isLive(t.owner, t.ownerRel)) throw new HttpError(409, 'live_session', 'This drawing is open for live editing.');
}

/** Write a stream (or buffer) to a temporary file first, so a failed upload never damages the saved file. */
export async function writeFile(t, source, { overwrite = true, maxBytes = MAX_FILE } = {}) {
  if (t.ownerRel === '/') throw new HttpError(400, 'bad_path', 'A file path is required.');
  checkLive(t);
  const exists = await fsp.stat(t.full).catch(() => null);
  if (exists?.isDirectory()) throw new HttpError(409, 'is_a_folder', 'A folder with that name already exists.');
  if (exists && !overwrite) throw new HttpError(409, 'already_exists', 'A file with that name already exists.');
  await fsp.mkdir(path.dirname(t.full), { recursive: true, mode: 0o700 });
  const tmp = `${t.full}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let size = 0;
  const limit = new Transform({
    transform(chunk, _enc, done) {
      size += chunk.length;
      done(size > maxBytes ? new HttpError(413, 'too_large', `Files larger than ${Math.round(maxBytes / 1024 / 1024)} MB cannot be saved to the server.`) : null, chunk);
    },
  });
  try {
    if (Buffer.isBuffer(source) || typeof source === 'string') {
      const buf = Buffer.from(source);
      if (buf.length > maxBytes) throw new HttpError(413, 'too_large', 'That file is too large.');
      await fsp.writeFile(tmp, buf, { mode: 0o600 });
    } else await pipeline(source, limit, fs.createWriteStream(tmp, { mode: 0o600 }));
    await fsp.rename(tmp, t.full);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  return itemFor(t.rel, await fsp.stat(t.full));
}

/** Forget shares, links and grants under a path once it is gone. */
function forgetPath(owner, ownerRel) {
  const like = `${ownerRel.replace(/[%_\\]/g, '\\$&')}/%`;
  db.tx(() => {
    db.run("DELETE FROM file_shares WHERE owner = ? AND (path = ? OR path LIKE ? ESCAPE '\\')", owner, ownerRel, like);
    db.run("DELETE FROM links WHERE owner = ? AND (path = ? OR path LIKE ? ESCAPE '\\')", owner, ownerRel, like);
    db.run("DELETE FROM app_grants WHERE owner = ? AND (path = ? OR path LIKE ? ESCAPE '\\')", owner, ownerRel, like);
  });
}

export async function remove(t, { recursive = false } = {}) {
  if (t.ownerRel === '/' || t.appRoot) throw new HttpError(400, 'bad_path', 'A file path is required.');
  let stat;
  try {
    stat = await fsp.stat(t.full);
  } catch (err) {
    throw notFound(err);
  }
  for (const fn of hooks.onDelete) await fn(t.owner, t.ownerRel);
  try {
    if (stat.isDirectory()) await fsp.rm(t.full, { recursive: !!recursive });
    else await fsp.rm(t.full);
  } catch (err) {
    if (err.code === 'ENOTEMPTY' || err.code === 'ERR_FS_EISDIR' || err.code === 'EEXIST') throw new HttpError(409, 'not_empty', 'That folder is not empty.');
    throw notFound(err);
  }
  forgetPath(t.owner, t.ownerRel);
}

export async function mkdir(t) {
  if (t.ownerRel === '/') throw new HttpError(400, 'bad_path', 'A folder name is required.');
  const exists = await fsp.stat(t.full).catch(() => null);
  if (exists && !exists.isDirectory()) throw new HttpError(409, 'already_exists', 'A file with that name already exists.');
  await fsp.mkdir(t.full, { recursive: true, mode: 0o700 });
  return itemFor(t.rel, await fsp.stat(t.full));
}

/** Rename or move within one owner's drive. Shares and links follow the item. */
export async function rename(src, dst, { overwrite = false } = {}) {
  if (src.owner !== dst.owner) throw new HttpError(400, 'cross_drive', 'Items can only be moved within the same drive.');
  if (src.ownerRel === '/' || dst.ownerRel === '/' || src.appRoot || dst.appRoot) throw new HttpError(400, 'bad_path', 'A file path is required.');
  if (within(dst.ownerRel, src.ownerRel)) throw new HttpError(400, 'bad_path', 'A folder cannot be moved into itself.');
  if (hooks.isLive(src.owner, src.ownerRel, true)) throw new HttpError(409, 'live_session', 'This drawing is open for live editing.');
  try {
    await fsp.stat(src.full);
  } catch (err) {
    throw notFound(err);
  }
  const exists = await fsp.stat(dst.full).catch(() => null);
  if (exists && !overwrite) throw new HttpError(409, 'already_exists', 'An item with that name already exists.');
  await fsp.mkdir(path.dirname(dst.full), { recursive: true, mode: 0o700 });
  await fsp.rename(src.full, dst.full);
  const like = `${src.ownerRel.replace(/[%_\\]/g, '\\$&')}/%`;
  const move = (p) => dst.ownerRel + p.slice(src.ownerRel.length);
  db.tx(() => {
    for (const table of ['file_shares', 'links', 'app_grants', 'history']) {
      const key = table === 'links' ? 'token' : 'id';
      for (const row of db.all(`SELECT ${key} AS k, path FROM ${table} WHERE owner = ? AND (path = ? OR path LIKE ? ESCAPE '\\')`, src.owner, src.ownerRel, like)) {
        db.run(`UPDATE OR REPLACE ${table} SET path = ? WHERE ${key} = ?`, move(row.path), row.k);
      }
    }
  });
  for (const fn of hooks.onRename) fn(src.owner, src.ownerRel, dst.ownerRel);
  return itemFor(dst.rel, await fsp.stat(dst.full));
}

// /api/fs routes -----------------------------------------------------------------------

function incomingFrom(user, owner) {
  const out = [];
  for (const s of db.all('SELECT path, mode FROM file_shares WHERE owner = ? AND grantee = ? ORDER BY path', owner, user)) {
    try {
      const stat = fs.statSync(ownerFull(owner, s.path));
      out.push(itemFor(`/@${owner}${s.path}`, stat, { mode: s.mode }));
    } catch {
      /* gone */
    }
  }
  return out;
}

export function routes(router) {
  router.add('GET', 'fs/readdir', async ({ res, url, user }) => {
    const raw = url.searchParams.get('path');
    const parts = split(raw);
    if (parts.length === 1 && parts[0].startsWith('@') && store.normalizeName(parts[0].slice(1)) !== user) {
      return send(res, 200, { items: incomingFrom(user, store.normalizeName(parts[0].slice(1))), cursor: null });
    }
    if (!parts.length) throw new HttpError(400, 'bad_path', 'A file path is required.');
    const t = resolve(user, raw, 'view');
    const out = await listDir(t, Object.fromEntries(url.searchParams));
    if (t.mode !== 'own') for (const i of out.items) i.mode = t.mode;
    return send(res, 200, out);
  });
  router.add('GET', 'fs/stat', async ({ res, url, user }) => send(res, 200, await statItem(resolve(user, url.searchParams.get('path'), 'view'))));
  router.add('GET', 'fs/read', async ({ res, url, user }) => sendFile(res, resolve(user, url.searchParams.get('path'), 'view')));
  router.add('PUT', 'fs/write', async ({ req, res, url, user }) => {
    const t = resolve(user, url.searchParams.get('path'), 'edit');
    return send(res, 200, await writeFile(t, req, { overwrite: url.searchParams.get('overwrite') !== '0' }));
  });
  router.add('DELETE', 'fs/delete', async ({ res, url, user }) => {
    await remove(resolve(user, url.searchParams.get('path'), 'delete'), { recursive: url.searchParams.get('recursive') === '1' });
    return send(res, 200, { ok: true });
  });
  router.add('POST', 'fs/mkdir', async ({ res, url, user }) => send(res, 200, await mkdir(resolve(user, url.searchParams.get('path'), 'edit'))));
  router.add('POST', 'fs/rename', async ({ req, res, user }) => {
    const { from, to, overwrite } = (await readJSONBody(req)) || {};
    return send(res, 200, await rename(resolve(user, from, 'delete'), resolve(user, to, 'edit'), { overwrite: !!overwrite }));
  });
}
