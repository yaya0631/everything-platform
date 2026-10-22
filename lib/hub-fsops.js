/**
 * The hub fs: per-user Drive operations for hub apps, behind grants.
 *
 * Two scopes, from lib/hub-fsauth.js:
 *   - the app's own data dir (relative paths) — data/hub-users/<user>/<app>/
 *   - the person's Drive (absolute paths, ~, /<ownname>/...) — data/files/<user>/
 *     the same folders drive.js serves, so hub files and CAD drive files are
 *     one set. Drive writes and reads need an active grant.
 *
 * Every returned shape matches what puter-js hands its callers (the v1 entry:
 * name/path/is_dir/size/modified/created/writable/uid). The uid is derived
 * from the path so rename-by-uid round-trips without a registry.
 *
 * Read URLs (fs.getReadURL) are HMAC tokens bound to user+app+path+expiry and
 * served from /hub/f/<token> with no session; that is the point of the URL.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as db from './db.js';
import * as store from './store.js';
import * as config from './config.js';
import { HttpError } from './http.js';
import { DATA_DIR } from './paths.js';
import { resolvePath, grantCovers, virtualSegments, BadPathError, assertInsideRoot } from './hub-fsauth.js';

/** A user's hub-app data home. Lives under data/, so admin backups see it. */
export const HUB_USERS_DIR = path.join(DATA_DIR, 'hub-users');

/** Folders a fresh Puter account shows; created on first hub use. */
export const COMMON_ROOTS = ['Documents', 'Desktop', 'Videos', 'Pictures', 'Music'];

const rootsFor = (user, app) => ({
  sandbox: path.join(HUB_USERS_DIR, user, app),
  drive: store.userRoot(user),
  // Every OTHER name on this server, so `/<name>/…` for a different person
  // is rejected outright instead of acting as a harmless folder name.
  others: store.listUsers().map((u) => u.name).filter((n) => n !== user),
});

const uidFor = (virtualPath) =>
  crypto.createHash('sha1').update(`hubfs:${virtualPath}`).digest('hex').slice(0, 32);

// Grants ---------------------------------------------------------------------------

/** Active grants for (user, app), newest first. */
export function activeGrants(user, app) {
  return db.all(
    'SELECT * FROM hub_grants WHERE user = ? AND app = ? AND revoked_at IS NULL ORDER BY granted_at DESC',
    user, app,
  );
}

/** All of a user's active grants across apps (the Account page list). */
export function grantsForUser(user) {
  return db.all(
    'SELECT * FROM hub_grants WHERE user = ? AND revoked_at IS NULL ORDER BY granted_at DESC',
    user,
  );
}

/** Create (or refresh) one grant. source: 'picker-open' | 'picker-save' | 'picker-dir' | 'default'. */
export function grant(user, app, virtualPath, perms, source) {
  if (!['read', 'write'].includes(perms)) throw new HttpError(400, 'bad_input', 'Grant perms are "read" or "write".');
  const norm = virtualPath === '/' ? '/' : virtualPath;
  const existing = db.get(
    'SELECT * FROM hub_grants WHERE user = ? AND app = ? AND path = ? AND perms = ? AND revoked_at IS NULL',
    user, app, norm, perms);
  if (existing) return existing;
  db.run(
    'INSERT INTO hub_grants(id, user, app, path, perms, source, granted_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    crypto.randomUUID(), user, app, norm, perms,
    source || 'default', Date.now(),
  );
  return db.get(
    'SELECT * FROM hub_grants WHERE user = ? AND app = ? AND path = ? AND perms = ? AND revoked_at IS NULL ORDER BY granted_at DESC LIMIT 1',
    user, app, norm, perms,
  );
}

export function revokeGrant(id, user) {
  const g = db.get('SELECT * FROM hub_grants WHERE id = ?', id);
  if (!g || (user && g.user !== user)) throw new HttpError(404, 'not_found', 'No such grant.');
  db.run('UPDATE hub_grants SET revoked_at = ? WHERE id = ?', Date.now(), id);
  return { ok: true };
}

/** Every active grant an app named in package.json needs before first run. */
export function defaultGrants(app) {
  try {
    const raw = fs.readFileSync(path.join('D:/Stream/everything/upstream/src', app, 'package.json'), 'utf8');
    const meta = JSON.parse(raw);
    const out = [];
    for (const [p, perms] of Object.entries(meta.hubDefaultGrants || {})) out.push({ path: p, perms });
    return out;
  } catch {
    return [];
  }
}

/**
 * Resolve + authorize. need: 'read' | 'write'. Sandbox paths are free; Drive
 * paths need a covering grant (exact file for file-shaped grants, subtree or
 * everything-under for directory grants).
 */
export function access({ user, app, input, need = 'read' }) {
  const roots = rootsFor(user, app);
  const res = resolvePath({ user, app, input, roots });
  // Real-path containment: a junction/symlink planted under the user's root
  // must not turn a granted path into a door outside (verifier finding).
  assertInsideRoot(res.target, res.kind === 'sandbox' ? roots.sandbox : roots.drive);
  if (res.kind === 'sandbox') return { ...res, roots, grant: null };
  const found = grantAllowed(activeGrants(user, app), res, need);
  if (!found) {
    const err = new HttpError(403, 'no_permission_for_app',
      `This app has not been granted ${need} access to ${res.virtualPath === '/' ? 'your Drive' : `"${res.virtualPath}"`}. Pick the file inside the app to grant access.`);
    // The shim turns this into the one-time consent overlay ("X wants to save
    // into Documents/X", one explicit Allow or Deny — never silent, never
    // ambient). Sandbox writes never reach here; the grant is the same
    // revocable record the Account page lists.
    err.grant_request = { app, path: res.virtualPath, need, action: need === 'write' ? 'save' : 'open' };
    throw err;
  }
  return { ...res, roots, grant: found };
}

function grantAllowed(grants, res, need) {
  for (const g of grants) {
    if (!grantCovers(g.path === '/' ? '/' : g.path, res.grantPrefix)) continue;
    if (g.perms === 'write') return g; // write grants read too
    if (need === 'read' && g.perms === 'read') return g;
  }
  return null;
}

function pickGrantForPicker(user, app, res, need, source) {
  // A picker selection grants exactly what the person pointed at: the file
  // itself for open/save, the chosen folder for a directory pick.
  return grant(user, app, res.virtualPath === '/' ? '/' : res.virtualPath, need, source);
}

function fsErrorMap(err, res) {
  if (err instanceof BadPathError) return new HttpError(400, err.code, err.message);
  if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
    return new HttpError(404, 'not_found', `${res?.virtualPath ? `"${res.virtualPath}"` : 'That item'} was not found.`);
  }
  if (err?.code === 'EEXIST') return new HttpError(409, 'item_with_same_name_exists', 'An item with that name already exists.');
  if (err?.code === 'ENOTEMPTY') return new HttpError(409, 'directory_not_empty', 'That folder is not empty.');
  if (err?.code === 'EACCES' || err?.code === 'EPERM') return new HttpError(403, 'access_denied', 'The server could not touch that file.');
  if (err?.code === 'EINVAL' || err?.code === 'ENOENTNAME') return new HttpError(400, 'invalid_path', 'That file name is not allowed.');
  return err;
}

async function map(fn, res) {
  try {
    return await fn();
  } catch (err) {
    throw fsErrorMap(err, res);
  }
}

// Entry shapes (the v1 objects puter-js callers see) ----------------------------------

const entry = (res, st, extra = {}) => {
  const isDrive = res.kind === 'drive';
  const name = res.virtualPath === '/' ? '' : path.posix.basename(res.virtualPath);
  const dir = res.virtualPath === '/' ? null : path.posix.dirname(res.virtualPath);
  return {
    name,
    path: isDrive ? res.virtualPath : (res.virtualPath || '/'),
    uid: uidFor(res.virtualPath),
    is_dir: st.isDirectory(),
    isfile: st.isFile(),
    size: st.isFile() ? st.size : null,
    modified: Math.floor(st.mtimeMs),
    created: Math.floor(st.birthtimeMs || st.ctimeMs),
    writable: true,
    type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null,
    dirname: isDrive ? (dir || '/') : (dir || ''),
    is_shared: false,
    ...extra,
  };
};

const joinChild = (res, name) => ({
  ...res,
  target: path.join(res.target, name),
  // The sandbox's virtual path is relative (no leading slash), so the sandbox
  // root is '' — children of it must not grow a slash.
  virtualPath: res.virtualPath ? `${res.virtualPath}/${name}` : name,
  grantPrefix: res.grantPrefix === '/' ? `/${name}` : res.grantPrefix ? `${res.grantPrefix}/${name}` : `/${name}`,
});

async function hostedBytesForUser(user) {
  const sites = db.all('SELECT app, root_dir FROM hub_sites WHERE user = ?', user);
  let total = 0;
  const walk = async (dir, budget) => {
    if (--budget.n < 0) throw new HttpError(413, 'site_too_large', 'Hosted sites have too many files and folders.');
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return 0; }
    let bytes = 0;
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) bytes += await walk(full, budget);
      else if (e.isFile()) bytes += (await fsp.stat(full)).size;
    }
    return bytes;
  };
  for (const site of sites) {
    try {
      const root = access({ user, app: site.app, input: site.root_dir, need: 'read' });
      total += await walk(root.target, { n: 20_000 });
    } catch (err) {
      if (err instanceof HttpError) throw err;
    }
  }
  return total;
}

function siteOwnsPath(site, app, virtualPath) {
  if (site.app !== app) return false;
  const root = String(site.root_dir).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
  const target = String(virtualPath).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
  return !!root && (target === root || target.startsWith(`${root}/`));
}

async function entryAt(res, name) {
  const child = joinChild(res, name);
  const st = await fsp.stat(child.target);
  return entry(child, st);
}

function dedupeList(baseDir, wanted) {
  let have;
  try {
    have = fs.readdirSync(baseDir);
  } catch {
    return wanted;
  }
  const taken = (n) => have.some((x) => x.toLowerCase() === n.toLowerCase());
  if (!taken(wanted)) return wanted;
  const dot = wanted.lastIndexOf('.');
  const stem = dot > 0 ? wanted.slice(0, dot) : wanted;
  const ext = dot > 0 ? wanted.slice(dot) : '';
  for (let i = 1; i < 1000; i++) {
    const alt = `${stem} (${i})${ext}`;
    if (!taken(alt)) return alt;
  }
  throw new HttpError(409, 'name_taken', 'Too many items share that name.');
}

/** Documents/Desktop/Videos etc. exist before the first hub write. */
export function ensureCommonRoots(user) {
  const root = store.userRoot(user);
  for (const d of COMMON_ROOTS) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
}

// Operations ------------------------------------------------------------------------

export async function mkdir({ user, app, input, options = {} }) {
  const orig = resolvePath({ user, app, input, roots: rootsFor(user, app) });
  assertInsideRoot(orig.target, orig.kind === 'sandbox' ? rootsFor(user, app).sandbox : rootsFor(user, app).drive);
  if (orig.kind === 'drive') access({ user, app, input, need: 'write' });
  // App-private parents are made freely; Drive mkdir calls keep the strict
  // puter default (createMissingParents opt-in).
  const autoParents = orig.kind === 'sandbox' ? (options.createMissingParents ?? true) : options.createMissingParents === true;
  let res = orig;
  const parent = path.dirname(res.target);
  if (options.dedupeName) {
    fs.mkdirSync(parent, { recursive: true });
    const alt = dedupeList(parent, path.posix.basename(res.virtualPath));
    if (alt !== path.posix.basename(res.virtualPath)) {
      const dir = path.posix.dirname(res.virtualPath);
      res = { ...res, target: path.join(parent, alt), virtualPath: dir === '/' ? `/${alt}` : `${dir}/${alt}` };
    }
  }
  const exists = fs.existsSync(res.target);
  if (exists && options.exclusive && !options.dedupeName) {
    throw new HttpError(409, 'item_with_same_name_exists', 'A folder with that name already exists.');
  }
  if (!exists) {
    await map(() => fsp.mkdir(res.target, { recursive: Boolean(autoParents) }), res);
  }
  return entry(res, fs.statSync(res.target));
}

export async function write({ user, app, input, data, options = {} }) {
  const res = access({ user, app, input, need: 'write' });
  // puter semantics: overwrite defaults to true; dedupeName wins when asked.
  // createMissingParents defaults to false on the Drive (puter docs) but to
  // true inside the app's own folder — app-private subdirs are made freely.
  // This divergence, and why, is in the README's honest-diffs table.
  const autoParents = res.kind === 'sandbox' ? (options.createMissingParents ?? true) : options.createMissingParents === true;
  const st0 = fs.existsSync(res.target);
  if (st0 && options.dedupeName) {
    const alt = dedupeList(path.dirname(res.target), path.posix.basename(res.virtualPath));
    if (alt !== path.posix.basename(res.virtualPath)) {
      const dir = path.posix.dirname(res.virtualPath);
      res = { ...res, target: path.join(path.dirname(res.target), alt), virtualPath: dir === '/' ? `/${alt}` : `${dir}/${alt}` };
    }
  } else if (!st0 && autoParents) {
    fs.mkdirSync(path.dirname(res.target), { recursive: true });
  } else if (!st0 && !fs.existsSync(path.dirname(res.target))) {
    throw new HttpError(404, 'missing_parent', 'The destination folder does not exist. Use option createMissingParents.');
  }
  // Writes stream to a temp file first (matches the drive): a failed upload
  // never damages the saved file. Buffers take the short path.
  const tmp = `${res.target}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    if (data === undefined || typeof data === 'string' || Buffer.isBuffer(data) || data instanceof Uint8Array) {
      const buf = Buffer.from(typeof data === 'string' ? data : data ?? Buffer.alloc(0));
      await fsp.writeFile(tmp, buf, { mode: 0o600 });
    } else if (data instanceof Blob) {
      await pipeline(data.stream(), fs.createWriteStream(tmp, { mode: 0o600 }));
    } else {
      await pipeline(data, fs.createWriteStream(tmp, { mode: 0o600 }));
    }
    const sites = db.all('SELECT app, root_dir FROM hub_sites WHERE user = ?', user);
    if (sites.some((site) => siteOwnsPath(site, app, res.virtualPath))) {
      const oldSize = st0 ? (await fsp.stat(res.target)).size : 0;
      const newSize = (await fsp.stat(tmp)).size;
      const hostedQuota = Number(config.get('hosting.quota_bytes', 104857600)) || 104857600;
      if (await hostedBytesForUser(user) - oldSize + newSize > hostedQuota) {
        throw new HttpError(413, 'quota_exceeded', 'This write would exceed your total hosted-site quota.');
      }
    }
    await fsp.rename(tmp, res.target);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  return entry(res, fs.statSync(res.target));
}

export async function read({ user, app, input, offset = 0, byteCount = null, res: httpRes = null }) {
  const res = access({ user, app, input, need: 'read' });
  const st = await map(() => fsp.stat(res.target), res);
  if (!st.isFile()) throw new HttpError(400, 'not_a_file', 'That path is a folder, not a file.');
  if (httpRes) {
    const end = byteCount ? Math.min(st.size, offset + byteCount) : st.size;
    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': Math.max(0, end - offset),
      'Accept-Ranges': 'none',
      'Cache-Control': 'no-store',
    };
    httpRes.writeHead(200, headers);
    if (httpRes.req?.method === 'HEAD') return httpRes.end();
    const stream = fs.createReadStream(res.target, { start: offset, end: end ? end - 1 : undefined });
    await new Promise((ok, bad) => {
      stream.on('error', bad);
      stream.on('end', ok);
      stream.pipe(httpRes);
    }).catch((err) => {
      if (!httpRes.headersSent) throw err;
      httpRes.destroy();
    });
    return null;
  }
  const fh = await map(() => fsp.open(res.target, 'r'), res);
  try {
    return fh.read(Buffer.alloc(byteCount ?? st.size - offset), 0, byteCount ?? st.size - offset, offset).then((r) => r.buffer.subarray(0, r.bytesRead));
  } finally {
    await fh.close();
  }
}

const SORTS = {
  name: (a, b) => a.name.localeCompare(b.name),
  modified: (a, b) => b.modified - a.modified,
  size: (a, b) => (b.size ?? 0) - (a.size ?? 0),
  type: (a, b) => (a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : a.is_dir ? -1 : 1),
};

export async function readdir({ user, app, input, options = {} }) {
  ensureCommonRoots(user);
  const res = access({ user, app, input, need: 'read' });
  // The app's own root always exists (a fresh Puter app dir this sizes to).
  if (res.kind === 'sandbox') {
    fs.mkdirSync(res.target, { recursive: true });
  }
  let names = await map(() => fsp.readdir(res.target, { withFileTypes: true }), res);
  const out = [];
  for (const d of names) {
    try {
      out.push(await entryAt(res, d.name));
    } catch {
      /* entry vanished between readdir and stat: harmless */
    }
  }
  const sort = SORTS[options.sortBy] || SORTS.name;
  out.sort(sort);
  if (options.sortOrder === 'desc') out.reverse();
  const offset = options.offset || 0;
  const paged = paginator(options);
  const page = paged ? out.slice(offset, offset + (options.limit || 500)) : out.slice(offset);
  if (!paged) return page;
  return {
    items: page,
    ...(options.includeTotal ? { total: out.length } : {}),
    ...(offset + page.length < out.length ? { cursor: `o${offset + page.length}` } : {}),
  };
}

const paginator = (options) => options.cursor !== undefined || options.includeTotal || (options.recursive !== undefined);

export async function stat({ user, app, input }) {
  const res = access({ user, app, input, need: 'read' });
  const st = await map(() => fsp.stat(res.target), res);
  return entry(res, st);
}

export async function del({ user, app, input, options = {} }) {
  const list = Array.isArray(input) ? input : [input];
  for (const one of list) {
    const res = access({ user, app, input: one, need: 'write' });
    const st = await map(() => fsp.stat(res.target), res);
    if (st.isDirectory() && !options.recursive && !options.descendantsOnly) {
      const names = await fsp.readdir(res.target);
      if (names.length) throw new HttpError(409, 'directory_not_empty', 'That folder is not empty.');
      await map(() => fsp.rmdir(res.target), res);
      continue;
    }
    await map(() => fsp.rm(res.target, { recursive: true, force: true }), res);
  }
  return { ok: true };
}

export async function rename({ user, app, from, newName }) {
  const norm = String(newName ?? '');
  const parts = virtualSegments(norm);
  if (!parts.length || parts.length !== 1 || String(parts[0]) !== norm) {
    throw new HttpError(400, 'bad_input', 'The new name is a single file or folder name, not a path.');
  }
  const res = access({ user, app, input: from, need: 'write' });
  const target = path.join(path.dirname(res.target), norm);
  const exists = fs.existsSync(target);
  if (exists && target.toLowerCase() !== res.target.toLowerCase()) {
    throw new HttpError(409, 'item_with_same_name_exists', 'An item with that name already exists.');
  }
  const name = norm;
  const dir = res.virtualPath.split('/').slice(0, -1).filter(Boolean).join('/');
  await map(() => fsp.rename(res.target, target), res);
  return entry({ ...res, target, virtualPath: `/${dir ? `${dir}/` : ''}${name}` }, fs.statSync(target));
}

/** Destination as puter fs.move/copy see it: a folder to land inside (with an
 * optional newName), or a full path. Cross-scope moves need grants on both
 * sides; the destination parent must exist. */
function targetFor({ user, app, source, destination }) {
  const src = access({ user, app, input: source, need: 'write' });
  const srcName = src.virtualPath.split('/').filter(Boolean).pop();
  let dst = resolvePath({ user, app, input: destination, roots: rootsFor(user, app) });
  let dstIsDir = (() => {
    try { return fs.statSync(dst.target).isDirectory(); } catch { return false; }
  })();
  const land = (dirRes, name) => ({
    name,
    target: path.join(dirRes.target, name),
    virtualPath: dirRes.virtualPath === '/' ? `/${name}` : `${dirRes.virtualPath}/${name}`,
    kind: dirRes.kind,
    grantPrefix: dirRes.grantPrefix === '/' ? `/${name}` : `${dirRes.grantPrefix}/${name}`,
  });
  if (dstIsDir) return { src, dst: land(dst, srcName), kind: dst.kind };
  // Destination is a file path (overwrite without options.recursive): resolve
  // its parent folder first.
  const parentInput = destination.split('/').filter(Boolean).slice(0, -1).join('/');
  const name = destination.split('/').filter(Boolean).pop();
  if (!parentInput) {
    const root = { target: dst.kind === 'sandbox' ? rootsFor(user, app).sandbox : rootsFor(user, app).drive, virtualPath: '/', grantPrefix: '/', kind: dst.kind };
    return { src, dst: land(root, name), kind: dst.kind };
  }
  const parent = resolvePath({ user, app, input: `/${parentInput}`.slice(dst.kind === 'sandbox' ? 1 : 0), roots: rootsFor(user, app) });
  return { src, dst: land({ ...parent, virtualPath: parent.virtualPath === '/' ? '/' : parent.virtualPath }, name), kind: dst.kind };
}

export async function move({ user, app, source, destination, options = {} }) {
  const t = targetFor({ user, app, source, destination });
  access({ user, app, input: destination, need: 'write' });
  const dst = t.dst;
  if (fs.existsSync(dst.target)) {
    if (options.dedupeName) {
      const alt = dedupeList(path.dirname(dst.target), dst.name);
      dst.target = path.join(path.dirname(dst.target), alt);
      dst.virtualPath = dst.virtualPath.slice(0, dst.virtualPath.length - dst.name.length) + alt;
      dst.name = alt;
    } else if (!options.overwrite) {
      throw new HttpError(409, 'item_with_same_name_exists', 'An item with that name already exists.');
    } else {
      await map(() => fsp.rm(dst.target, { recursive: true, force: true }), { virtualPath: dst.virtualPath });
    }
  }
  await map(() => fsp.rename(t.src.target, dst.target), t.src);
  return entry({ ...t.src, target: dst.target, virtualPath: dst.virtualPath, kind: t.kind }, fs.statSync(dst.target));
}

export async function copy({ user, app, source, destination, options = {} }) {
  const t = targetFor({ user, app, source, destination });
  access({ user, app, input: destination, need: 'write' });
  const dst = t.dst;
  if (fs.existsSync(dst.target)) {
    if (options.dedupeName) {
      const alt = dedupeList(path.dirname(dst.target), dst.name);
      dst.target = path.join(path.dirname(dst.target), alt);
      dst.virtualPath = dst.virtualPath.slice(0, dst.virtualPath.length - dst.name.length) + alt;
      dst.name = alt;
    } else if (!options.overwrite) {
      throw new HttpError(409, 'item_with_same_name_exists', 'An item with that name already exists.');
    } else {
      await map(() => fsp.rm(dst.target, { recursive: true, force: true }), { virtualPath: dst.virtualPath });
    }
  }
  await map(() => fsp.cp(t.src.target, dst.target, { recursive: true }), t.src);
  const st = fs.statSync(dst.target);
  return entry({ ...t.src, target: dst.target, virtualPath: dst.virtualPath, kind: t.kind }, st);
}

/** Picker backing store: a folder listing for the Drive or the app's own
 * data. Entry paths round-trip: Drive children are root-absolute
 * (/Documents/a.txt), app-data children are app-sandbox-relative (a.txt). */
export async function browse({ user, app, root = 'drive', dir = '/' }) {
  if (root !== 'drive' && root !== 'sandbox') {
    throw new HttpError(400, 'bad_input', 'root is "drive" or "sandbox".');
  }
  ensureCommonRoots(user);
  const roots = rootsFor(user, app);
  const segments = virtualSegments(String(dir ?? '/')); // rejects '..' and friends

  let target;
  let prefix; // the virtual path the child paths build on
  if (root === 'sandbox') {
    target = segments.length ? path.join(roots.sandbox, ...segments) : roots.sandbox;
    assertInsideRoot(target, roots.sandbox);
    prefix = segments.join('/');
  } else {
    const res = resolvePath({ user, app, input: String(dir ?? '/'), roots });
    if (res.kind !== 'drive') throw new HttpError(400, 'bad_input', 'That folder is inside the app data.');
    assertInsideRoot(res.target, roots.drive);
    target = res.target;
    prefix = res.virtualPath;
  }

  const names = await map(() => fsp.readdir(target, { withFileTypes: true }), { virtualPath: dir });
  const out = [];
  for (const d of names.slice(0, 2000)) {
    try {
      const childPath = prefix === '/' || !prefix
        ? (root === 'drive' ? `/${d.name}` : d.name)
        : `${prefix}/${d.name}`;
      const st = d.isDirectory() ? null : await fsp.stat(path.join(target, d.name));
      out.push({ name: d.name, path: childPath, is_dir: d.isDirectory(), size: st ? st.size : null });
    } catch {
      /* raced delete; skip it */
    }
  }
  out.sort((a, b) => (a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : a.is_dir ? -1 : 1));
  return { entries: out, root, dir: prefix || '/' };
}

export async function space({ user }) {
  const addUp = (dir) => {
    let used = 0;
    const walk = (d) => {
      let es;
      try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of es) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else {
          try { used += fs.statSync(full).size; } catch { /* racing writes */ }
        }
      }
    };
    walk(dir);
    return used;
  };
  const used = addUp(store.userRoot(user)) + addUp(path.join(HUB_USERS_DIR, user));
  const capacity = Number(config.get('hubQuotaBytes')) || 10 * 1024 * 1024 * 1024;
  return { used, capacity, percentage: Math.round((used / capacity) * 1000) / 10 };
}

// Picker-side grants (called by the shim's pickers, server endpoints) ------------------

export function grantForPick({ user, app, path, need, source }) {
  const res = resolvePath({ user, app, input: path, roots: rootsFor(user, app) });
  if (res.kind !== 'drive') return null; // sandbox picks need no grant
  return grant(user, app, res.virtualPath, need, source);
}

// Read tokens ------------------------------------------------------------------------

let tokenSecret = null;
function getTokenSecret() {
  if (tokenSecret) return tokenSecret;
  const stored = config.get('hubReadSecret');
  if (stored && /^[0-9a-f]{64}$/.test(stored)) {
    tokenSecret = Buffer.from(stored, 'hex');
  } else {
    tokenSecret = crypto.randomBytes(32);
    config.set('hubReadSecret', tokenSecret.toString('hex'));
  }
  return tokenSecret;
}

/** getReadURL → a same-origin URL string valid for expiresIn seconds. */
export function readUrlToken({ user, app, virtualPath, expiresIn }) {
  const payload = JSON.stringify({ u: user, a: app, p: virtualPath, e: Date.now() + expiresIn * 1000 });
  const body = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', getTokenSecret()).update(body).digest('base64url');
  return { token: `${body}.${sig}`, url: `/hub/f/${body}.${sig}` };
}

export function verifyReadToken(token) {
  const [body, sig] = String(token ?? '').split('.');
  if (!body || !sig) return null;
  const expect = crypto.createHmac('sha256', getTokenSecret()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || payload.e < Date.now()) return null;
  return payload;
}

/** Stream the file a token names. 404s (never 403s, to keep tokens opaque). */
export async function serveReadToken(req, res, token) {
  const payload = verifyReadToken(token);
  if (!payload || !/^[\w-]{1,64}$/.test(payload.a)) {
    return send404(res);
  }
  const user = store.validName(payload.u) && store.getAccount(payload.u) ? payload.u : null;
  if (!user) return send404(res);
  const res2 = resolvePath({ user, app: payload.a, input: payload.p, roots: rootsFor(user, payload.a) });
  // A token is bound to a virtual path, but the real file behind it is
  // re-checked here too: a link planted at drive level must not turn a
  // previously-issued read URL into a door outside the root. The token
  // surface 404s instead of 403s either way — tokens stay opaque (§ read
  // tokens: "404s (never 403s)").
  try {
    assertInsideRoot(res2.target, rootsFor(user, payload.a).drive);
  } catch {
    return send404(res);
  }
  const st = fs.existsSync(res2.target) ? fs.statSync(res2.target) : null;
  if (!st || !st.isFile()) return send404(res);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': 'private, max-age=60',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(res2.target).pipe(res);
}

const send404 = (res) => {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
};
