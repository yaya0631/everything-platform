/** Shared, static-only Puter hosting service. Public bytes leave only through /site/ on the public listener. */
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as db from './db.js';
import * as store from './store.js';
import * as config from './config.js';
import * as fsops from './hub-fsops.js';
import { HttpError, rateLimit, clientIp } from './http.js';

const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RATE = { max: 120, windowMs: 60_000 };
const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.htm', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'], ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.txt', 'text/plain; charset=utf-8'], ['.xml', 'application/xml; charset=utf-8'],
  ['.ics', 'text/calendar; charset=utf-8'], // contracts publishes subscribable deadline feeds (§27 census)
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.gif', 'image/gif'],
  ['.webp', 'image/webp'], ['.ico', 'image/x-icon'], ['.woff', 'font/woff'], ['.woff2', 'font/woff2'], ['.ttf', 'font/ttf'],
  ['.pdf', 'application/pdf'], ['.mp3', 'audio/mpeg'], ['.mp4', 'video/mp4'], ['.webm', 'video/webm'],
]);

export const enabled = () => config.get('hosting.enabled', false) === true;
const quota = () => Number(config.get('hosting.quota_bytes', 100 * 1024 * 1024)) || 100 * 1024 * 1024;
const cleanRoot = (v) => {
  const root = String(v || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!root || root.split('/').some((s) => !s || s === '.' || s === '..')) throw new HttpError(400, 'bad_root', 'Choose a folder inside this app or your Drive.');
  return root;
};
const cleanName = (v) => {
  const name = String(v || '').toLowerCase().trim();
  if (!SUBDOMAIN.test(name) || name.length < 2 || ['www', 'api', 'admin', 'site'].includes(name)) throw new HttpError(400, 'bad_subdomain', 'Use 2 to 63 lowercase letters, digits, and internal dashes.');
  return name;
};
function requireEnabled() {
  if (!enabled()) throw new HttpError(503, 'hosting_disabled', 'Public hosting is disabled by the server administrator.');
  if (!config.publicUrl()) throw new HttpError(503, 'public_url_unset', 'Set the public server address before publishing a site.');
}
function publicUrl(subdomain) { return `${config.publicUrl()}/site/${encodeURIComponent(subdomain)}`; }
function shape(row) {
  return { uid: row.subdomain, subdomain: row.subdomain, root_dir: row.root_dir, domain: `${row.subdomain}.puter.site`, url: publicUrl(row.subdomain), created_at: row.created_at, updated_at: row.updated_at };
}
function owned(user, subdomain) {
  const row = db.get('SELECT * FROM hub_sites WHERE subdomain = ? AND user = ?', cleanName(subdomain), user);
  if (!row) throw new HttpError(404, 'site_not_found', 'No hosted site with that name belongs to you.');
  return row;
}
async function treeBytes({ user, app, root }) {
  const stack = [root];
  let total = 0;
  let count = 0;
  while (stack.length) {
    const dir = stack.pop();
    const entries = await fsops.readdir({ user, app, input: dir });
    for (const e of entries) {
      if (++count > 20_000) throw new HttpError(413, 'site_too_large', 'A hosted site may contain at most 20,000 files and folders.');
      const child = dir ? `${dir}/${e.name}` : e.name;
      if (e.is_dir) stack.push(child);
      else total += Number(e.size || 0);
    }
  }
  return total;
}
async function userBytes(user, except = null) {
  const rows = db.all('SELECT * FROM hub_sites WHERE user = ?', user).filter((r) => r.subdomain !== except);
  let total = 0;
  for (const r of rows) total += await treeBytes({ user, app: r.app, root: r.root_dir });
  return total;
}

export async function create({ user, app, subdomain, root_dir }) {
  requireEnabled();
  const name = cleanName(subdomain);
  const root = cleanRoot(root_dir);
  const st = await fsops.stat({ user, app, input: root });
  if (!st.is_dir) throw new HttpError(400, 'bad_root', 'The published root must be a folder.');
  const bytes = await treeBytes({ user, app, root });
  if (bytes + await userBytes(user) > quota()) throw new HttpError(413, 'quota_exceeded', 'This site would exceed your total hosted-site quota.');
  const now = Date.now();
  try { db.run('INSERT INTO hub_sites(subdomain,user,app,root_dir,created_at,updated_at) VALUES (?,?,?,?,?,?)', name, user, app, root, now, now); }
  catch (err) { if (/UNIQUE/i.test(err.message)) throw new HttpError(409, 'subdomain_taken', 'That site name is already in use.'); throw err; }
  store.audit(user, 'hosting.created', { subdomain: name, app, root_dir: root, bytes });
  return shape(db.get('SELECT * FROM hub_sites WHERE subdomain = ?', name));
}
export function get({ user, subdomain }) { return shape(owned(user, subdomain)); }
export function list({ user, limit = 100, offset = 0 }) {
  const rows = db.all('SELECT * FROM hub_sites WHERE user = ? ORDER BY created_at DESC LIMIT ? OFFSET ?', user, Math.min(200, Math.max(1, Number(limit) || 100)), Math.max(0, Number(offset) || 0));
  return rows.map(shape);
}
export async function update({ user, subdomain, root_dir }) {
  requireEnabled();
  const row = owned(user, subdomain);
  const root = cleanRoot(root_dir);
  const st = await fsops.stat({ user, app: row.app, input: root });
  if (!st.is_dir) throw new HttpError(400, 'bad_root', 'The published root must be a folder.');
  const bytes = await treeBytes({ user, app: row.app, root });
  if (bytes + await userBytes(user, row.subdomain) > quota()) throw new HttpError(413, 'quota_exceeded', 'This site would exceed your total hosted-site quota.');
  db.run('UPDATE hub_sites SET root_dir = ?, updated_at = ? WHERE subdomain = ? AND user = ?', root, Date.now(), row.subdomain, user);
  store.audit(user, 'hosting.updated', { subdomain: row.subdomain, app: row.app, root_dir: root, bytes });
  return shape(owned(user, row.subdomain));
}
export function remove({ user, subdomain }) {
  const row = owned(user, subdomain);
  db.run('DELETE FROM hub_sites WHERE subdomain = ? AND user = ?', row.subdomain, user);
  store.audit(user, 'hosting.deleted', { subdomain: row.subdomain, app: row.app });
  return { success: true, uid: row.subdomain };
}

function inlineHashes(html, tag) {
  const hashes = [];
  const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi');
  for (const match of html.matchAll(re)) {
    if (tag === 'script' && /\bsrc\s*=|\btype\s*=\s*["']application\//i.test(match[1])) continue;
    const body = match[2].replace(/\r\n?/g, '\n');
    hashes.push(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  }
  return [...new Set(hashes)];
}
function htmlCsp(html, app) {
  const scripts = ["'self'", ...inlineHashes(html, 'script')];
  const styles = ["'self'", ...inlineHashes(html, 'style')];
  const styleAttrs = app === 'documents' ? "; style-src-attr 'unsafe-inline'" : '';
  return `sandbox allow-scripts allow-forms; default-src 'none'; script-src ${scripts.join(' ')}; style-src ${styles.join(' ')}${styleAttrs}; img-src 'self' data:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}
function response(res, status, body, headers = {}) {
  res.writeHead(status, { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'Content-Security-Policy': "sandbox allow-scripts allow-forms; default-src 'none'; script-src 'none'; style-src 'self'; img-src 'self' data:; font-src 'self'; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", ...headers });
  res.end(body);
}
export async function serve(req, res, url) {
  if (!enabled()) return response(res, 404, 'Not found');
  if (!['GET', 'HEAD'].includes(req.method)) return response(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
  const parts = url.pathname.slice('/site/'.length).split('/');
  let subdomain;
  try { subdomain = cleanName(decodeURIComponent(parts.shift() || '')); } catch { return response(res, 404, 'Not found'); }
  if (!rateLimit(`hosting:${subdomain}:${clientIp(req)}`, RATE.max, RATE.windowMs)) return response(res, 429, 'Too many requests');
  const row = db.get('SELECT * FROM hub_sites WHERE subdomain = ?', subdomain);
  if (!row) return response(res, 404, 'Not found');
  let rel;
  try {
    rel = parts.map((p) => decodeURIComponent(p)).join('/');
    if (rel.split('/').some((p) => p === '..' || p === '.' || p.includes('\\') || p.includes('\0'))) throw new Error('bad path');
    if (!rel || rel.endsWith('/')) rel += 'index.html';
    else if (!path.posix.basename(rel).includes('.')) rel += '/index.html';
  } catch { return response(res, 404, 'Not found'); }
  const file = `${row.root_dir}/${rel}`;
  const type = MIME.get(path.posix.extname(rel).toLowerCase());
  if (!type) return response(res, 415, 'Unsupported file type');
  try {
    const st = await fsops.stat({ user: row.user, app: row.app, input: file });
    if (st.is_dir || !st.isfile) return response(res, 404, 'Not found');
    if (req.method === 'HEAD') return response(res, 200, '', { 'Content-Type': type, 'Content-Length': String(st.size) });
    let bytes = await fsops.read({ user: row.user, app: row.app, input: file });
    let csp = null;
    if (type.startsWith('text/html')) {
      let html = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
      if (!html.includes('/hub/worker-url-map.js')) {
        const tag = '<script src="/hub/worker-url-map.js" defer></script>';
        html = /<\/head\s*>/i.test(html) ? html.replace(/<\/head\s*>/i, `${tag}</head>`) : `${tag}${html}`;
      }
      csp = htmlCsp(html, row.app);
      bytes = Buffer.from(html, 'utf8');
    }
    response(res, 200, bytes, { 'Content-Type': type, ...(csp ? { 'Content-Security-Policy': csp } : {}), 'Content-Length': String(bytes.length) });
  } catch {
    response(res, 404, 'Not found');
  }
}

export function register(s) {
  s.publicMounts.push(['/site/', serve]);
}
