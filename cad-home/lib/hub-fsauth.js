/**
 * The hub fs path model, shared by the API and the shim.
 *
 * A hub app sees two scopes for the person using it:
 *   - its own data dir (`data/hub-users/<user>/<app>/`) — what relative paths
 *     resolve to, and `'/appdata:...'` style paths too. No grant needed.
 *   - the user's Drive (`data/files/<user>/`) — absolute paths, `~`, and the
 *     own-username prefix all land here. Only reachable while an active
 *     grant covers the path.
 *
 * Paths never touch the OS: everything is checked as a virtual path first
 * (this kills Windows trickery in one place) and then joined under a fixed
 * root with forward slashes only.
 */
import path from 'node:path';
import fs from 'node:fs';
import { HttpError } from './http.js';
import { DATA_DIR } from './paths.js';

/** One component of a virtual path; a rejected path is a 400 on the wire. */
export class BadPathError extends HttpError {
  constructor(code, message) {
    super(400, 'bad_path', message);
    this.code = code;
  }
}

// Windows reserved device names, any casing, with or without an extension.
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/** Validates one path segment against the Windows attack surface. */
export function assertSafeSegment(seg) {
  if (seg === '.' || seg === '..') throw new BadPathError('dot_segment', `"${seg}" is not allowed in a path.`);
  if (!seg) return; // empty components are normalised away
  // Reject control characters outright.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(seg)) throw new BadPathError('control_char', 'Control characters are not allowed in file names.');
  const lower = seg.toLowerCase();
  const stem = lower.split('.')[0];
  if (RESERVED.has(stem)) throw new BadPathError('reserved_name', `"${seg}" is a reserved Windows device name.`);
  if (/[:*?|<>]/.test(seg)) throw new BadPathError('invalid_char', `Characters : * ? | < > are not allowed ("${seg}").`);
  if (/^\\+/.test(seg)) throw new BadPathError('invalid_char', 'Backslashes are not allowed.');
  if (seg.endsWith('.') || /[\s.]+$/.test(seg)) throw new BadPathError('trailing_dot_space', `Names may not end with a dot or a space ("${seg}").`);
}

/**
 * Normalises and validates a virtual path the client sent. Accepts forward
 * slashes only (the SDK contract), rejects absolute-Windows shapes, encoded
 * dots, stream suffixes and UNC prefixes long before anything touches a file
 * system. Returns the component list.
 */
export function virtualSegments(input) {
  if (typeof input !== 'string') throw new BadPathError('invalid_path', 'Path must be a string.');
  if (input.includes('\x00')) throw new BadPathError('invalid_path', 'NUL bytes are not allowed.');
  if (/^(?:\\\\|\/\/\?|\\\.\\|[a-zA-Z]:)/.test(input)) {
    throw new BadPathError('windows_drive', 'Windows drive and UNC paths are not allowed.');
  }
  if (input.includes('\\')) {
    throw new BadPathError('backslash_path', 'Use forward slashes in paths.');
  }

  let dec = input;
  if (input.includes('%')) {
    try { dec = decodeURIComponent(input); } catch { throw new BadPathError('invalid_path', 'Malformed escape in path.'); }
    if (/\.\.|%2e|%25/i.test(input) === false && dec !== input) {
      // percent-decoded characters are fine (unicode names), traversal below catches '..'
    }
  }

  const segments = [];
  for (const raw of dec.split('/')) {
    if (!raw || raw === '.') continue;
    if (raw === '..') throw new BadPathError('parent_ref', '".." is not allowed in paths.');
    assertSafeSegment(raw);
    segments.push(raw);
  }
  return segments;
}

/**
 * How a client path resolves for this user+app.
 * kind 'sandbox': inside the app's own data dir (no grant needed).
 * kind 'drive':   the user's Drive root (grant required).
 * userName is the signed-in user's name; appName the hub app's name.
 * Returns { kind, target, virtualPath, grantPrefix } — target is the
 * OS-facing absolute path, grantPrefix dots-free virtual form for grants.
 */
export function resolvePath({ user, app, input, roots }) {
  const segments = virtualSegments(input);
  const abs = input.startsWith('/') || input.startsWith('~');

  if (!abs) {
    // Relative — app sandbox.
    const target = path.join(roots.sandbox, ...segments);
    return { kind: 'sandbox', target, virtualPath: segments.join('/'), grantPrefix: segments.join('/') };
  }

  // Absolute or tilde: both land in the Drive, with the own-username prefix
  // as an alias of the root (video-studio style `/<user>/Documents/...`).
  let rest = segments;
  if (rest[0] === '~') rest = rest.slice(1);
  if (rest[0] && rest[0].toLowerCase() === String(user).toLowerCase()) {
    rest = rest.slice(1);
  }

  // Another person's name is never in this app's namespace: better a clear
  // 400 than "a folder that looks like their drive" (the path-model table
  // row in the README promises exactly this).
  const first = rest[0] && String(rest[0]).toLowerCase();
  if (first && (roots.others || []).some((n) => String(n).toLowerCase() === first)) {
    throw new BadPathError('other_person', `"${rest[0]}" is another person on this server — their space is not reachable.`);
  }

  if (rest.length === 0) {
    return { kind: 'drive', target: roots.drive, virtualPath: '/', grantPrefix: '/' };
  }
  const target = path.join(roots.drive, ...rest);
  return {
    kind: 'drive',
    target,
    virtualPath: '/' + rest.join('/'),
    grantPrefix: '/' + rest.join('/'),
  };
}

/** A stored grant covers `prefix` (one segment = exact or its subtree).
 * On Windows the file layer is case-insensitive, so the VIRTUAL comparison
 * is too — a grant the person picked as /Documents must also cover
 * /documents; on other platforms the case must match exactly. */
export function grantCovers(grantPath, virtualPath) {
  if (grantPath === '/') return true;
  const ci = process.platform === 'win32';
  const norm = (p) => {
    const n = p.replace(/\/+$/, '') || '/';
    return ci ? n.toLowerCase() : n;
  };
  const g = norm(grantPath);
  const v = norm(virtualPath);
  return v === g || v.startsWith(g + '/');
}

/** Dot-prefixed sandbox dir names so no app collides with the user's Drive. */
export function sandboxDirName(app) {
  assertSafeSegment(app);
  return app;
}

// Real-path containment (junctions / symlinks) ---------------------------------------
//
// A reparse point — NTFS junction or symlink, creatable by anyone with shell
// access to this PC — planted anywhere under the user's roots silently
// redirects every fs operation that walks through it. The virtual path model
// above cannot see that: the lexical checks all pass and the operation then
// follows the link OUTSIDE the Drive. So before every operation the REAL
// path of the target is resolved (for a not-yet-existing leaf, the nearest
// EXISTING ancestor — which is where any planted link in its chain must
// live) and must stay inside the operation's scope root AND inside the
// server's data dir; the second arm catches a link planted AT the root
// itself. Comparison is case-insensitive on win32 (known error arms: see
// test/hub-fs-containment.test.js — read, write, mkdir, delete, rename,
// copy, plus a same-root link that stays allowed).

/** realpath with walk-up: for a missing leaf, the nearest existing ancestor
 * (a planted link must exist somewhere in the chain, so this is where the
 * escape would be). Returns null when nothing up to the drive root exists. */
function realOf(p) {
  let cur = p;
  for (let i = 0; i < 96; i++) {
    try {
      return fs.realpathSync(cur);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
  }
  return null;
}

const realCache = new Map(); // exact realpaths of stable roots, cached
function cachedReal(p) {
  // Only exact hits are cached: the nearest-existing ancestor of a missing
  // path changes as the tree grows, so those are resolved fresh each time.
  if (realCache.has(p)) return realCache.get(p);
  let cur = p;
  for (let i = 0; i < 96; i++) {
    try {
      const real = fs.realpathSync(cur);
      realCache.set(p, real);
      return real;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
  }
  return null;
}

const fold = (x) => (process.platform === 'win32' ? x.toLowerCase() : x);

function insideRoot(rootReal, real) {
  if (!rootReal || !real) return false;
  if (fold(rootReal) === fold(real)) return true;
  const sep = path.sep;
  const r = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  return fold(real).startsWith(fold(r));
}

/** The operation's target must resolve (through any junction/symlink in its
 * chain) to a path inside `rootPath`, which itself must sit inside this
 * server's data dir. 403 `escapes_root` otherwise. */
export function assertInsideRoot(target, rootPath) {
  const rootReal = cachedReal(rootPath) ?? realOf(rootPath) ?? rootPath;
  const targetReal = realOf(target);
  const anchorReal = cachedReal(DATA_DIR) ?? realOf(DATA_DIR) ?? DATA_DIR;
  if (insideRoot(rootReal, targetReal) && insideRoot(anchorReal, rootReal)) return;
  throw new HttpError(403, 'escapes_root',
    'That path resolves outside your own space — a link pointing elsewhere cannot be used here.');
}
