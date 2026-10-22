/**
 * Small HTTP helpers shared by every route: errors, JSON replies, bodies,
 * cookies, a path router, rate limits and static files.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as config from './config.js';

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

export function sendHtml(res, status, html, headers = {}) {
  send(res, status, html, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
}

export async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'too_large', 'That request is too large.');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export async function readJSONBody(req, limit = 64 * 1024) {
  try {
    return JSON.parse((await readBody(req, limit)).toString('utf8') || 'null');
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'bad_request', 'The request body is not valid JSON.');
  }
}

export function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        /* ignore a malformed cookie */
      }
    }
  }
  return out;
}

/**
 * Tailscale serve terminates HTTPS but may not send X-Forwarded-Proto, so a
 * request whose Host is the configured https private address counts too.
 */
export function isHttps(req) {
  if (req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https') return true;
  const host = String(req.headers.host || '').toLowerCase();
  for (const u of [config.privateUrl(), config.publicUrl()]) {
    try {
      const url = new URL(u);
      if (url.protocol === 'https:' && url.host.toLowerCase() === host) return true;
    } catch {
      /* not configured */
    }
  }
  return false;
}

/** The scheme and host this request was made to, for example https://pc.tailnet.ts.net */
export function requestOrigin(req) {
  return `${isHttps(req) ? 'https' : 'http'}://${req.headers.host || 'localhost'}`;
}

/**
 * Funnel sets X-Forwarded-For and the public listener only binds localhost, so
 * that header is trustworthy there. The private listener uses the socket.
 */
export function clientIp(req) {
  if (req.isPublic) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'unknown';
}

const isLoopbackAddr = (addr) => {
  const a = String(addr ?? '').trim();
  if (a === '::1' || a === '[::1]') return true;
  return /^127\./.test(a.replace(/^::ffff:/i, ''));
};

/**
 * The real client behind a LOCAL reverse proxy (tailscale serve). Serve
 * terminates the tailnet's HTTPS and proxies to this server over loopback,
 * so every remote address collapses to 127.0.0.1 — and with it, any
 * per-address isolation. Serve injects identity headers (the docs: it
 * REMOVES client-supplied `Tailscale-User-Login` / `Tailscale-User-Name`
 * values before filling them) and sets `X-Forwarded-For` to the requesting
 * node's tailnet address. Both are trusted ONLY when the connection itself
 * is loopback: a LAN client could send its own headers, and they would be
 * plain lies. Keyed identity, in order: `Tailscale-User-Login` (a real
 * person, strongest), then the first non-loopback `X-Forwarded-For` hop,
 * else the socket address. Sign-in failure limiting keys on this — without
 * it, everyone behind serve shares 127.0.0.1 and any person could lock out
 * any username for 15 minutes by hammering that name.
 */
export function realClientKey(req) {
  const remote = req.socket?.remoteAddress ?? '';
  if (isLoopbackAddr(remote)) {
    const login = String(req.headers?.['tailscale-user-login'] ?? '').trim();
    if (login && /^[\w.@+.-]{1,120}$/.test(login)) return `ts:${login.toLowerCase()}`;
    const chain = String(req.headers?.['x-forwarded-for'] ?? '');
    for (const hop of chain.split(',')) {
      const c = hop.trim();
      if (c && !isLoopbackAddr(c)) return c;
    }
  }
  return remote || 'unknown';
}

// Rate limits ---------------------------------------------------------------------------

const windows = new Map();

/** Sliding window in memory. Returns true and counts the call when under the limit. */
export function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  let list = windows.get(key);
  if (!list) {
    if (windows.size > 20000) for (const [k, l] of windows) if (!l.length || now - l[l.length - 1] > windowMs) windows.delete(k);
    list = [];
    windows.set(key, list);
  }
  while (list.length && now - list[0] >= windowMs) list.shift();
  if (list.length >= limit) return false;
  list.push(now);
  return true;
}

export function resetRateLimits() {
  windows.clear();
}

// Router ---------------------------------------------------------------------------------

/** Routes like "share/links/:token/email" matched against "METHOD path". */
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, fn) {
    const keys = [];
    const re = new RegExp(
      `^${pattern
        .split('/')
        .map((seg) => {
          if (seg.startsWith(':')) {
            keys.push(seg.slice(1));
            return '([^/]+)';
          }
          if (seg === '*') {
            keys.push('rest');
            return '(.*)';
          }
          return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('/')}$`,
    );
    this.routes.push({ method, re, keys, fn });
    return this;
  }

  match(method, route) {
    for (const r of this.routes) {
      if (r.method !== method && !(r.method === 'GET' && method === 'HEAD')) continue;
      const m = r.re.exec(route);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => {
        try {
          params[k] = decodeURIComponent(m[i + 1]);
        } catch {
          params[k] = m[i + 1];
        }
      });
      return { fn: r.fn, params };
    }
    return null;
  }
}

// Static files ---------------------------------------------------------------------------

export const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
};

export const typeFor = (file) => TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';

/**
 * Serve a file under root. rel is a URL path (still percent-encoded). Folders
 * serve their index.html. Returns false when there is no such file.
 */
export async function serveStatic(req, res, root, rel, { cache, headers = {} } = {}) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, { code: 'method_not_allowed' });
    return true;
  }
  let p;
  try {
    p = decodeURIComponent(rel || '/');
  } catch {
    return false;
  }
  if (p.includes('\0')) return false;
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.endsWith('/')) p += 'index.html';
  const full = path.join(root, path.normalize(p));
  if (full !== root && !full.startsWith(root + path.sep)) return false;
  let stat;
  try {
    stat = await fsp.stat(full);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  res.writeHead(200, {
    'Content-Type': typeFor(full),
    'Content-Length': stat.size,
    'Cache-Control': typeof cache === 'function' ? cache(p) : cache || 'no-cache',
    ...headers,
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  await pipeline(fs.createReadStream(full), res);
  return true;
}

const errors = [];
/** The last 50 server errors, for Admin → Overview (messages only). */
export function recordError(where, err) {
  errors.push({ at: Date.now(), where, message: String(err?.message || err).slice(0, 300) });
  if (errors.length > 50) errors.shift();
}
export const recentErrors = () => errors.slice().reverse();

export function sendNotFound(res, message = 'Not found') {
  send(res, 404, message, { 'Content-Type': 'text/plain; charset=utf-8' });
}

export const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** A small, self-contained page for messages like "This link is no longer available". */
export function messagePage(title, text) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>:root{color-scheme:light dark;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText}main{max-width:26rem;padding:24px}h1{font-size:18px;margin:0 0 8px}p{margin:0;opacity:.75}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></main></body></html>`;
}
