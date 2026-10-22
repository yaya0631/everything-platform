/**
 * Sharing between accounts and public share links.
 *
 *   file_shares(owner, path, grantee, mode)   view | edit, a file or a folder (covers its subtree)
 *   links(token, owner, path, mode, …)        a .cad drawing on the public listener at /s/<token>/
 *
 * The public listener never reads cookies: a link token is the only credential there.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import * as db from './db.js';
import * as store from './store.js';
import * as config from './config.js';
import * as mail from './mail.js';
import * as drive from './drive.js';
import * as live from './live.js';
import { APP_DIR } from './paths.js';
import { HttpError, send, sendHtml, readJSONBody, serveStatic, messagePage } from './http.js';
import { requireAdmin, siteUrl } from './admin.js';

const MODES = ['view', 'edit'];
const isCad = (p) => p.toLowerCase().endsWith('.cad');

export const linkUrl = (token) => `${config.publicUrl()}/s/${token}/`;

/** A link that can be used right now, else null. */
export function getLink(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token)) return null;
  const l = db.get('SELECT * FROM links WHERE token = ?', token);
  if (!l || l.revoked || (l.expires && l.expires < Date.now())) return null;
  if (!store.getAccount(l.owner)) return null;
  return { ...l };
}

export function touchLink(token) {
  db.run('UPDATE links SET last_used = ?, uses = uses + 1 WHERE token = ?', Date.now(), token);
}

function linkRow(l) {
  return {
    token: l.token,
    url: config.publicUrl() ? linkUrl(l.token) : null,
    mode: l.mode,
    created: l.created,
    createdBy: l.created_by,
    expires: l.expires,
    lastUsed: l.last_used,
    uses: l.uses,
    expired: !!(l.expires && l.expires < Date.now()),
  };
}

function peopleFor(owner, ownerRel) {
  return db.all('SELECT grantee, mode, created FROM file_shares WHERE owner = ? AND path = ? ORDER BY grantee', owner, ownerRel).map((r) => ({ user: r.grantee, displayName: store.displayName(r.grantee), mode: r.mode, created: r.created }));
}

async function exists(full) {
  return fs.promises.stat(full).catch(() => null);
}

function notify(req, owner, grantee, ownerRel, mode) {
  const a = store.getAccount(grantee);
  if (!a?.email || !a.notify_shares || !mail.configured()) return;
  const t = mail.templates.shared({ by: store.displayName(owner), name: path.posix.basename(ownerRel), mode, url: `${siteUrl(req)}/` });
  mail.send({ to: a.email, ...t, user: owner, source: 'share' }).catch((err) => console.warn('Share email:', err.message));
}

export function register(s) {
  const { api, publicMounts, upgradeMounts } = s;

  api.add('GET', 'users/directory', async ({ res, user }) =>
    send(
      res,
      200,
      db.all('SELECT name, display_name FROM users WHERE disabled = 0 AND hash IS NOT NULL AND name <> ? ORDER BY name', user).map((u) => ({ username: u.name, displayName: u.display_name || u.name })),
    ),
  );

  api.add('GET', 'share/list', async ({ res, url, user }) => {
    const t = drive.resolve(user, url.searchParams.get('path'), 'edit');
    const stat = await exists(t.full);
    if (!stat) throw drive.notFound({ code: 'ENOENT' });
    const links = db.all('SELECT * FROM links WHERE owner = ? AND path = ? AND revoked IS NULL ORDER BY created DESC', t.owner, t.ownerRel).map(linkRow);
    return send(res, 200, {
      owner: t.owner,
      ownerName: store.displayName(t.owner),
      path: t.rel,
      name: path.posix.basename(t.ownerRel),
      isDir: stat.isDirectory(),
      isCad: !stat.isDirectory() && isCad(t.ownerRel),
      canManagePeople: t.mode === 'own',
      people: peopleFor(t.owner, t.ownerRel),
      links,
      publicUrl: config.publicUrl(),
      emailConfigured: mail.configured(),
    });
  });

  api.add('POST', 'share/people', async ({ req, res, user }) => {
    const b = (await readJSONBody(req)) || {};
    const t = drive.resolve(user, b.path, 'edit');
    if (t.mode !== 'own') throw new HttpError(403, 'owner_only', 'Only the owner can share with people.');
    if (!(await exists(t.full))) throw drive.notFound({ code: 'ENOENT' });
    const grantee = store.normalizeName(b.user);
    const mode = MODES.includes(b.mode) ? b.mode : 'view';
    const g = store.getAccount(grantee);
    if (!g || g.disabled) throw new HttpError(404, 'no_such_user', 'There is no account with that name.');
    if (grantee === user) throw new HttpError(400, 'bad_request', 'You already own this.');
    const prev = db.get('SELECT mode FROM file_shares WHERE owner = ? AND path = ? AND grantee = ?', t.owner, t.ownerRel, grantee);
    db.run('INSERT INTO file_shares(owner, path, grantee, mode, created) VALUES (?, ?, ?, ?, ?) ON CONFLICT(owner, path, grantee) DO UPDATE SET mode = excluded.mode', t.owner, t.ownerRel, grantee, mode, Date.now());
    store.audit(user, 'share.people', { path: t.ownerRel, grantee, mode });
    if (!prev || prev.mode !== mode) notify(req, t.owner, grantee, t.ownerRel, mode);
    live.revalidate(t.owner, t.ownerRel);
    return send(res, 200, { people: peopleFor(t.owner, t.ownerRel) });
  });

  api.add('DELETE', 'share/people', async ({ req, res, user }) => {
    const b = (await readJSONBody(req)) || {};
    const t = drive.resolve(user, b.path, 'edit');
    const grantee = store.normalizeName(b.user);
    // The owner removes anyone; a person can also remove a share made with them.
    if (t.mode !== 'own' && grantee !== user) throw new HttpError(403, 'owner_only', 'Only the owner can change who has access.');
    db.run('DELETE FROM file_shares WHERE owner = ? AND path = ? AND grantee = ?', t.owner, t.ownerRel, grantee);
    store.audit(user, 'share.people_removed', { path: t.ownerRel, grantee });
    live.revalidate(t.owner, t.ownerRel);
    return send(res, 200, { people: peopleFor(t.owner, t.ownerRel) });
  });

  api.add('GET', 'share/incoming', async ({ res, user }) => {
    const out = [];
    for (const r of db.all('SELECT owner, path, mode, created FROM file_shares WHERE grantee = ? ORDER BY created DESC', user)) {
      const owner = store.getAccount(r.owner);
      if (!owner) continue;
      let stat;
      try {
        stat = fs.statSync(drive.ownerFull(r.owner, r.path));
      } catch {
        continue;
      }
      out.push({ owner: r.owner, ownerName: owner.display_name || owner.name, path: `/@${r.owner}${r.path}`, name: path.posix.basename(r.path), is_dir: stat.isDirectory(), mode: r.mode, modified: stat.mtimeMs, size: stat.size, shared: r.created });
    }
    return send(res, 200, out);
  });

  /** Everything I share, for the Account page. */
  api.add('GET', 'share/mine', async ({ res, user }) => {
    const people = db.all('SELECT id, path, grantee, mode, created FROM file_shares WHERE owner = ? ORDER BY path, grantee', user).map((r) => ({ ...r, path: r.path, displayName: store.displayName(r.grantee) }));
    const links = db.all('SELECT * FROM links WHERE owner = ? AND revoked IS NULL ORDER BY created DESC', user).map((l) => ({ ...linkRow(l), path: l.path }));
    return send(res, 200, { people, links });
  });

  // Links ---------------------------------------------------------------------------------

  api.add('POST', 'share/links', async ({ req, res, user }) => {
    const b = (await readJSONBody(req)) || {};
    const t = drive.resolve(user, b.path, 'edit');
    const stat = await exists(t.full);
    if (!stat?.isFile()) throw drive.notFound({ code: 'ENOENT' });
    if (!isCad(t.ownerRel)) throw new HttpError(400, 'not_cad', 'Only .cad drawings can have a link. Save a copy as .cad first.');
    const mode = MODES.includes(b.mode) ? b.mode : 'view';
    const days = Number(b.expiresDays) || 0;
    if (![0, 1, 7, 30].includes(days)) throw new HttpError(400, 'bad_request', 'Links expire after 1, 7 or 30 days, or never.');
    const token = crypto.randomBytes(24).toString('base64url');
    db.run('INSERT INTO links(token, owner, path, mode, created, created_by, expires) VALUES (?, ?, ?, ?, ?, ?, ?)', token, t.owner, t.ownerRel, mode, Date.now(), user, days ? Date.now() + days * 86400_000 : null);
    store.audit(user, 'link.created', { path: t.ownerRel, owner: t.owner, mode, days });
    return send(res, 200, linkRow(db.get('SELECT * FROM links WHERE token = ?', token)));
  });

  const linkForEditor = (user, token) => {
    const l = db.get('SELECT * FROM links WHERE token = ?', String(token));
    if (!l || l.revoked) throw new HttpError(404, 'not_found', 'That link was already removed.');
    if (l.owner !== user && l.created_by !== user && drive.accessMode(user, l.owner, l.path) !== 'edit') throw new HttpError(403, 'forbidden', 'Only the owner and editors can manage this link.');
    return l;
  };

  api.add('DELETE', 'share/links/:token', async ({ res, user, params }) => {
    const l = linkForEditor(user, params.token);
    db.run('UPDATE links SET revoked = ? WHERE token = ?', Date.now(), l.token);
    store.audit(user, 'link.revoked', { path: l.path, owner: l.owner });
    live.closeLink(l.token, 'revoked');
    return send(res, 200, { ok: true });
  });

  api.add('POST', 'share/links/:token/email', async ({ req, res, user, params }) => {
    const l = linkForEditor(user, params.token);
    if (!getLink(l.token)) throw new HttpError(410, 'link_expired', 'That link has expired.');
    if (!config.publicUrl()) throw new HttpError(503, 'no_public_url', 'Set the public address in Admin → Server first.');
    const { to } = (await readJSONBody(req)) || {};
    const list = String(to || '')
      .split(/[\s,;]+/)
      .filter(Boolean);
    if (!list.length || list.some((a) => !store.validEmail(a))) throw new HttpError(400, 'bad_recipient', 'Enter one or more email addresses.');
    const t = mail.templates.link({ by: store.displayName(user), name: path.posix.basename(l.path), mode: l.mode, url: linkUrl(l.token) });
    await mail.send({ to: list, ...t, user, source: 'link' });
    return send(res, 200, { ok: true });
  });

  // Admin → Sharing -------------------------------------------------------------------------

  api.add('GET', 'admin/sharing', async ({ res, account }) => {
    requireAdmin(account);
    const people = db.all('SELECT * FROM file_shares ORDER BY owner, path').map((r) => ({ ...r }));
    const links = db.all('SELECT * FROM links WHERE revoked IS NULL ORDER BY created DESC').map((l) => ({ ...linkRow(l), owner: l.owner, path: l.path }));
    return send(res, 200, { people, links });
  });

  api.add('DELETE', 'admin/shares/:id', async ({ res, user, account, params }) => {
    requireAdmin(account);
    const r = db.get('SELECT * FROM file_shares WHERE id = ?', Number(params.id));
    if (!r) throw new HttpError(404, 'not_found', 'That share was already removed.');
    db.run('DELETE FROM file_shares WHERE id = ?', r.id);
    store.audit(user, 'admin.share_removed', { owner: r.owner, path: r.path, grantee: r.grantee });
    live.revalidate(r.owner, r.path);
    return send(res, 200, { ok: true });
  });

  api.add('DELETE', 'admin/links/:token', async ({ res, user, account, params }) => {
    requireAdmin(account);
    const l = db.get('SELECT * FROM links WHERE token = ?', params.token);
    if (!l) throw new HttpError(404, 'not_found', 'That link was already removed.');
    db.run('UPDATE links SET revoked = ? WHERE token = ?', Date.now(), l.token);
    store.audit(user, 'admin.link_revoked', { owner: l.owner, path: l.path });
    live.closeLink(l.token, 'revoked');
    return send(res, 200, { ok: true });
  });

  // Public: /s/<token>/… -------------------------------------------------------------------

  const unavailable = (res) => sendHtml(res, 404, messagePage('This link is no longer available', 'Ask the person who shared it for a new link.'));

  publicMounts.push(['/healthz', async (_req, res) => send(res, 200, 'ok', { 'Content-Type': 'text/plain; charset=utf-8' })]);
  publicMounts.push([
    '/s/',
    async (req, res, url) => {
      const m = /^\/s\/([^/]+)(\/.*)?$/.exec(url.pathname);
      const link = m && getLink(m[1]);
      if (!link) return unavailable(res);
      if (!m[2]) {
        res.writeHead(302, { Location: `/s/${m[1]}/` });
        return res.end();
      }
      const rest = m[2];
      if (rest === '/api/share') {
        touchLink(link.token);
        return send(res, 200, { name: path.posix.basename(link.path), mode: link.mode, ownerName: store.displayName(link.owner) });
      }
      if (rest.startsWith('/api/')) return send(res, 404, { code: 'unknown_route', message: 'Unknown request.' });
      // The service worker would cache this path; guests never install it.
      if (rest === '/sw.js') return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
      const ok = await serveStatic(req, res, APP_DIR, rest, { cache: (p) => (p.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache') });
      if (!ok) send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    },
  ]);

  upgradeMounts.public.push([
    /^\/s\/[A-Za-z0-9_-]{32}\/api\/live$/,
    (req, socket, head, url) => {
      const token = url.pathname.split('/')[2];
      const link = getLink(token);
      if (!link) return live.rejectUpgrade(socket, 404, 'This link is no longer available.');
      return live.upgradeLink(req, socket, head, link);
    },
  ]);
}
