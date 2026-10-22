/**
 * The Account page (everyone) and the Admin panel (admins), served from
 * panel/ on the private listener only, plus their APIs:
 *   /api/auth/forgot|reset|accept-invite|token-info   no session needed
 *   /api/account/*                                    the signed-in person
 *   /api/admin/*                                      admins (every change is audited)
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as db from './db.js';
import * as store from './store.js';
import * as config from './config.js';
import * as mail from './mail.js';
import * as live from './live.js';
import { DATA_DIR, PANEL_DIR, TOKENS_CSS } from './paths.js';
import { HttpError, send, readJSONBody, requestOrigin, clientIp, rateLimit, serveStatic, sendNotFound, recentErrors } from './http.js';

const started = Date.now();
const STYLES = path.dirname(TOKENS_CSS);
const APP_SHARED = {
  '/panel/tokens.css': TOKENS_CSS,
  '/panel/app/base.css': path.join(STYLES, 'base.css'),
  '/panel/app/dialogs.css': path.join(STYLES, 'dialogs.css'),
  '/panel/app/dom.js': path.join(STYLES, '..', 'ui', 'dom.js'),
};
const RESET_TTL = 3600_000;
const INVITE_TTL = 7 * 24 * 3600_000;

/** Where links in emails point: the configured private address, else the one in use. */
export function siteUrl(req) {
  return config.privateUrl() || requestOrigin(req);
}

export function requireAdmin(account) {
  if (!account?.is_admin) throw new HttpError(403, 'admins_only', 'Only admins can do that.');
}

const bad = (message) => new HttpError(400, 'bad_request', message);
const wrap = (fn) => {
  try {
    return fn();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw bad(err.message);
  }
};

async function sendInvite(req, actor, name) {
  const a = store.getAccount(name);
  if (!a?.email) throw bad('Add an email address for this person first.');
  if (!mail.configured()) throw new HttpError(503, 'email_not_set_up', 'Set up email in Admin → Email to send invites.');
  store.deleteTokensFor('invite', a.name);
  const token = store.createToken('invite', { user: a.name, ttlMs: INVITE_TTL });
  const t = mail.templates.invite({ inviter: store.displayName(actor), username: a.name, url: `${siteUrl(req)}/account/#/invite/${token}` });
  await mail.send({ to: a.email, ...t, user: actor, source: 'invite' });
}

async function sendReset(req, name, actor) {
  const a = store.getAccount(name);
  if (!a?.email || !mail.configured()) return false;
  store.deleteTokensFor('reset', a.name);
  const token = store.createToken('reset', { user: a.name, ttlMs: RESET_TTL });
  const t = mail.templates.reset({ username: a.name, url: `${siteUrl(req)}/account/#/reset/${token}` });
  await mail.send({ to: a.email, ...t, user: actor || a.name, source: 'reset' });
  return true;
}

// Data folder size is slow to measure on a big drive, so it is cached.
let sizeCache = { at: 0, bytes: 0 };
async function folderSize(dir, budget = { n: 200000 }) {
  let total = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (--budget.n < 0) break;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += await folderSize(full, budget);
    else if (e.isFile()) total += (await fsp.stat(full).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

async function reachable(url) {
  if (!url) return null;
  try {
    const r = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch {
    return false;
  }
}

function userRow(u) {
  return {
    ...store.publicUser(u),
    created: u.created,
    disabled: !!u.disabled,
    invited: !u.hash,
    hostsApps: !!u.can_host_apps,
    sessions: db.get('SELECT COUNT(*) AS n FROM sessions WHERE user = ? AND expires > ?', u.name, Date.now()).n,
    lastSeen: db.get('SELECT MAX(last_seen) AS t FROM sessions WHERE user = ?', u.name).t,
  };
}

function smtpForBrowser() {
  const s = mail.smtpSettings() || {};
  return { host: s.host || '', port: s.port || '', secure: !!s.secure, user: s.user || '', pass: config.mask(s.pass), from: config.get('mail.from') || '', configured: mail.configured() };
}

export function register(s) {
  const { open, api, privateMounts } = s;

  // Password reset and invites (no session) ------------------------------------------------

  open.add('POST', 'auth/forgot', async ({ req, res }) => {
    const { username } = (await readJSONBody(req)) || {};
    // Always the same answer, so this cannot be used to find accounts.
    if (rateLimit(`forgot:${clientIp(req)}`, 5, 15 * 60_000)) {
      const name = store.normalizeName(username);
      if (store.validName(name)) {
        try {
          await sendReset(req, name);
        } catch (err) {
          console.warn('Password reset email:', err.message);
        }
      }
    }
    return send(res, 200, { ok: true, emailConfigured: mail.configured() });
  });

  open.add('GET', 'auth/token-info', async ({ res, url }) => {
    const kind = url.searchParams.get('kind');
    if (kind !== 'reset' && kind !== 'invite') throw bad('Unknown link.');
    const t = store.findToken(kind, url.searchParams.get('token'));
    if (!t) throw new HttpError(404, 'link_expired', 'This link has expired or was already used. Ask for a new one.');
    return send(res, 200, { username: t.user, displayName: store.displayName(t.user) });
  });

  const usePasswordToken = (kind) => async ({ req, res }) => {
    const { token, password } = (await readJSONBody(req)) || {};
    const t = store.findToken(kind, token);
    if (!t || !store.getAccount(t.user)) throw new HttpError(404, 'link_expired', 'This link has expired or was already used. Ask for a new one.');
    wrap(() => store.setPassword(t.user, password));
    store.deleteToken(token);
    store.audit(t.user, kind === 'invite' ? 'account.invite_accepted' : 'account.password_reset', {});
    const session = store.createSession(t.user, { userAgent: req.headers['user-agent'] });
    return send(res, 200, store.publicUser(store.getAccount(t.user)), { 'Set-Cookie': s.sessionCookie(req, session, store.SESSION_MAX_AGE) });
  };
  open.add('POST', 'auth/reset', usePasswordToken('reset'));
  open.add('POST', 'auth/accept-invite', usePasswordToken('invite'));

  // Account ----------------------------------------------------------------------------

  api.add('GET', 'account', async ({ res, account }) =>
    send(res, 200, { ...store.publicUser(account), notifyShares: !!account.notify_shares, emailConfigured: mail.configured(), publicUrl: config.publicUrl() }),
  );

  api.add('PUT', 'account', async ({ req, res, user }) => {
    const b = (await readJSONBody(req)) || {};
    const fields = {};
    for (const k of ['displayName', 'email', 'color', 'notifyShares']) if (k in b) fields[k] = b[k];
    wrap(() => store.updateUser(user, fields));
    return send(res, 200, { ...store.publicUser(store.getAccount(user)), notifyShares: !!store.getAccount(user).notify_shares });
  });

  api.add('POST', 'account/password', async ({ req, res, user }) => {
    const { current, next } = (await readJSONBody(req)) || {};
    const key = `pw:${user}`;
    if (!rateLimit(key, 10, 15 * 60_000)) throw new HttpError(429, 'too_many_attempts', 'Too many attempts. Wait 15 minutes and try again.');
    if (!store.checkLogin(user, current)) throw new HttpError(403, 'wrong_password', 'Your current password is not right.');
    wrap(() => store.setPassword(user, next));
    store.audit(user, 'account.password_changed', {});
    // Signed out everywhere else; this device gets a fresh session.
    const session = store.createSession(user, { userAgent: req.headers['user-agent'] });
    return send(res, 200, { ok: true }, { 'Set-Cookie': s.sessionCookie(req, session, store.SESSION_MAX_AGE) });
  });

  api.add('GET', 'account/sessions', async ({ res, user, session }) => send(res, 200, store.listSessions(user).map((x) => ({ ...x, current: x.id === session.id }))));

  api.add('DELETE', 'account/sessions/:id', async ({ res, user, params }) => {
    if (!store.endSessionById(user, params.id)) throw new HttpError(404, 'not_found', 'That device is already signed out.');
    return send(res, 200, { ok: true });
  });

  api.add('POST', 'account/sessions/others', async ({ res, user, session }) => {
    db.run('DELETE FROM sessions WHERE user = ? AND substr(token_hash, 1, 16) <> ?', user, session.id);
    return send(res, 200, { ok: true });
  });

  api.add('GET', 'account/apps', async ({ res, user }) => {
    const rows = db.all('SELECT g.*, a.title FROM app_grants g LEFT JOIN apps a ON a.name = g.app WHERE g.user = ? ORDER BY g.app, g.created', user);
    const apps = new Map();
    for (const r of rows) {
      if (!apps.has(r.app)) apps.set(r.app, { app: r.app, title: r.title || r.app, grants: [] });
      apps.get(r.app).grants.push({ id: r.id, mode: r.mode, path: r.mode === 'email' ? null : r.owner === user ? r.path : `/@${r.owner}${r.path}`, created: r.created });
    }
    return send(res, 200, [...apps.values()]);
  });

  api.add('DELETE', 'account/grants/:id', async ({ res, user, params }) => {
    if (!db.run('DELETE FROM app_grants WHERE id = ? AND user = ?', params.id, user).changes) throw new HttpError(404, 'not_found', 'That access was already removed.');
    return send(res, 200, { ok: true });
  });

  // Admin ------------------------------------------------------------------------------

  const admin = (method, route, fn) =>
    api.add(method, `admin/${route}`, async (ctx) => {
      requireAdmin(ctx.account);
      return fn(ctx);
    });
  const audit = (ctx, action, detail) => store.audit(ctx.user, action, detail);

  admin('GET', 'overview', async ({ res }) => {
    if (Date.now() - sizeCache.at > 60_000) sizeCache = { at: Date.now(), bytes: await folderSize(DATA_DIR) };
    let disk = null;
    try {
      const st = await fsp.statfs(DATA_DIR);
      disk = { free: st.bavail * st.bsize, total: st.blocks * st.bsize };
    } catch {
      /* not available */
    }
    const mem = process.memoryUsage();
    return send(res, 200, {
      uptime: Date.now() - started,
      node: process.version,
      platform: `${os.type()} ${os.release()}`,
      memory: { rss: mem.rss, heap: mem.heapUsed, systemFree: os.freemem(), systemTotal: os.totalmem() },
      dataDir: DATA_DIR,
      dataSize: sizeCache.bytes,
      disk,
      accounts: db.get('SELECT COUNT(*) AS n FROM users').n,
      online: store.countOnline(),
      rooms: live.listRooms(),
      errors: recentErrors().slice(0, 10),
      privateUrl: config.privateUrl(),
      publicUrl: config.publicUrl(),
      publicReachable: await reachable(config.publicUrl()),
      emailConfigured: mail.configured(),
    });
  });

  // People
  admin('GET', 'users', async ({ res }) => send(res, 200, store.listUsers().map(userRow)));

  admin('POST', 'users', async (ctx) => {
    const b = (await readJSONBody(ctx.req)) || {};
    const name = store.normalizeName(b.username);
    const invite = !!b.invite;
    if (invite && !b.email) throw bad('An email address is needed to send an invite.');
    if (invite && !mail.configured()) throw new HttpError(503, 'email_not_set_up', 'Set up email in Admin → Email to send invites.');
    wrap(() => store.addUser(name, invite ? null : b.password, { admin: !!b.isAdmin, email: b.email || '', displayName: b.displayName || '' }));
    if (b.canHostApps) store.updateUser(name, { canHostApps: true });
    audit(ctx, 'user.created', { user: name, invite });
    if (invite) {
      try {
        await sendInvite(ctx.req, ctx.user, name);
      } catch (err) {
        return send(ctx.res, 200, { ...userRow(store.getAccount(name)), warning: err.message });
      }
    }
    return send(ctx.res, 200, userRow(store.getAccount(name)));
  });

  admin('PUT', 'users/:name', async (ctx) => {
    const b = (await readJSONBody(ctx.req)) || {};
    const fields = {};
    for (const k of ['displayName', 'email', 'color', 'isAdmin', 'canHostApps', 'disabled']) if (k in b) fields[k] = b[k];
    if (ctx.params.name === ctx.user && (fields.isAdmin === false || fields.disabled)) throw bad('You cannot remove your own admin access or disable yourself here.');
    wrap(() => store.updateUser(ctx.params.name, fields));
    audit(ctx, 'user.updated', { user: ctx.params.name, fields: Object.keys(fields) });
    return send(ctx.res, 200, userRow(store.getAccount(ctx.params.name)));
  });

  admin('POST', 'users/:name/password', async (ctx) => {
    const b = (await readJSONBody(ctx.req)) || {};
    const a = store.getAccount(ctx.params.name);
    if (!a) throw new HttpError(404, 'not_found', 'There is no such account.');
    if (b.sendReset) {
      if (!a.email) throw bad('This person has no email address.');
      if (!mail.configured()) throw new HttpError(503, 'email_not_set_up', 'Set up email in Admin → Email first.');
      await sendReset(ctx.req, a.name, ctx.user);
      audit(ctx, 'user.reset_sent', { user: a.name });
      return send(ctx.res, 200, { ok: true, sent: true });
    }
    wrap(() => store.setPassword(a.name, b.password));
    audit(ctx, 'user.password_set', { user: a.name });
    return send(ctx.res, 200, { ok: true });
  });

  admin('POST', 'users/:name/invite', async (ctx) => {
    await sendInvite(ctx.req, ctx.user, ctx.params.name);
    audit(ctx, 'user.invite_sent', { user: ctx.params.name });
    return send(ctx.res, 200, { ok: true });
  });

  admin('POST', 'users/:name/signout', async (ctx) => {
    if (!store.getAccount(ctx.params.name)) throw new HttpError(404, 'not_found', 'There is no such account.');
    store.signOutEverywhere(ctx.params.name);
    live.revalidateAll();
    audit(ctx, 'user.signed_out', { user: ctx.params.name });
    return send(ctx.res, 200, { ok: true });
  });

  admin('DELETE', 'users/:name', async (ctx) => {
    const b = (await readJSONBody(ctx.req)) || {};
    if (ctx.params.name === ctx.user) throw bad('You cannot delete your own account here.');
    wrap(() => store.removeUser(ctx.params.name, { deleteFiles: !!b.deleteFiles }));
    live.revalidateAll();
    audit(ctx, 'user.deleted', { user: ctx.params.name, deleteFiles: !!b.deleteFiles });
    return send(ctx.res, 200, { ok: true });
  });

  // Server settings
  admin('GET', 'server', async ({ res, req }) =>
    send(res, 200, {
      privateUrl: config.get('private_url'),
      publicUrl: config.get('public_url'),
      envPrivateUrl: process.env.CAD_PRIVATE_URL || '',
      envPublicUrl: process.env.CAD_PUBLIC_URL || '',
      publicAiPerHour: config.get('limits.public_ai_per_hour'),
      publicEmailPerHour: config.get('limits.public_email_per_hour'),
      functionTimeoutMs: config.get('functions.timeout_ms'),
      workersPublicBaseUrl: config.get('workers.public_base_url', '') ?? '',
      hostingEnabled: config.get('hosting.enabled', false) === true,
      hostingQuotaBytes: config.get('hosting.quota_bytes', 104857600),
      privatePort: req.socket.localPort,
      publicPort: s.publicPort?.() ?? Number(process.env.CAD_PUBLIC_PORT || 8081),
      origin: requestOrigin(req),
    }),
  );

  admin('PUT', 'server', async (ctx) => {
    const b = (await readJSONBody(ctx.req)) || {};
    const url = (v, label) => {
      const t = String(v || '').trim().replace(/\/+$/, '');
      if (!t) return '';
      let u;
      try {
        u = new URL(t);
      } catch {
        throw bad(`${label} must be a full address like https://pc.tailnet.ts.net`);
      }
      if (!/^https?:$/.test(u.protocol) || u.pathname !== '/' || u.search || u.hash) throw bad(`${label} must be just the address, like https://pc.tailnet.ts.net`);
      return t;
    };
    const num = (v, min, max, label) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < min || n > max) throw bad(`${label} must be between ${min} and ${max}.`);
      return Math.round(n);
    };
    if ('privateUrl' in b) config.set('private_url', url(b.privateUrl, 'The private address') || null);
    if ('publicUrl' in b) config.set('public_url', url(b.publicUrl, 'The public address') || null);
    if ('publicAiPerHour' in b) config.set('limits.public_ai_per_hour', num(b.publicAiPerHour, 0, 100000, 'AI calls per hour'));
    if ('publicEmailPerHour' in b) config.set('limits.public_email_per_hour', num(b.publicEmailPerHour, 0, 10000, 'Emails per hour'));
    if ('functionTimeoutMs' in b) config.set('functions.timeout_ms', num(b.functionTimeoutMs, 1000, 600000, 'The function timeout'));
    if ('workersPublicBaseUrl' in b) {
      const t = String(b.workersPublicBaseUrl || '').trim().replace(/\/+$/, '');
      if (!t) config.set('workers.public_base_url', null);
      else config.set('workers.public_base_url', url(t, 'The guest (workers public routes) address'));
    }
    if ('hostingEnabled' in b) config.set('hosting.enabled', !!b.hostingEnabled);
    audit(ctx, 'server.updated', { fields: Object.keys(b) });
    return send(ctx.res, 200, { ok: true });
  });

  // Email
  admin('GET', 'email', async ({ res }) => send(res, 200, smtpForBrowser()));

  admin('PUT', 'email', async (ctx) => {
    const b = (await readJSONBody(ctx.req)) || {};
    const prev = mail.smtpSettings() || {};
    const host = String(b.host || '').trim();
    if (!host) config.set('smtp', null);
    else {
      const port = b.port === '' || b.port == null ? null : Number(b.port);
      if (port != null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw bad('The port must be a number like 587 or 465.');
      config.set('smtp', { host, port, secure: !!b.secure, user: String(b.user || '').trim(), pass: config.isMasked(b.pass) ? prev.pass || '' : String(b.pass || '') });
    }
    const from = String(b.from || '').trim();
    if (from && !/^[^<>]*<?[^\s@<>]+@[^\s@<>]+>?$/.test(from)) throw bad('"From" must be an address like CAD Home <cad@example.com>.');
    config.set('mail.from', from || null);
    audit(ctx, 'email.updated', {});
    return send(ctx.res, 200, smtpForBrowser());
  });

  admin('POST', 'email/test', async (ctx) => {
    const { to } = (await readJSONBody(ctx.req)) || {};
    const addr = String(to || ctx.account.email || '').trim();
    if (!store.validEmail(addr)) throw bad('Enter the address to send the test to.');
    await mail.send({ to: addr, ...mail.templates.test(), user: ctx.user, source: 'test' });
    audit(ctx, 'email.test', { to: addr });
    return send(ctx.res, 200, { ok: true });
  });

  admin('GET', 'email/log', async ({ res, url }) => send(res, 200, mail.recentLog(200, url.searchParams.get('before') ? Number(url.searchParams.get('before')) : null)));

  // Audit
  admin('GET', 'audit', async ({ res, url }) => {
    const before = url.searchParams.get('before') ? Number(url.searchParams.get('before')) : null;
    const rows = db.all('SELECT * FROM audit WHERE (? IS NULL OR id < ?) ORDER BY id DESC LIMIT 200', before, before);
    return send(res, 200, rows.map((r) => ({ ...r, detail: JSON.parse(r.detail || '{}') })));
  });

  // Backup: a consistent copy of the database while it runs.
  admin('GET', 'backup', async (ctx) => {
    const file = path.join(os.tmpdir(), `cad-backup-${process.pid}-${Date.now()}.db`);
    db.backupTo(file);
    audit(ctx, 'server.backup', {});
    const stat = fs.statSync(file);
    ctx.res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="cad-home-${new Date().toISOString().slice(0, 10)}.db"`,
      'Cache-Control': 'no-store',
    });
    const stream = fs.createReadStream(file);
    stream.pipe(ctx.res);
    const done = () => fs.rm(file, { force: true }, () => {});
    stream.on('close', done);
    stream.on('error', done);
  });

  // Panel pages --------------------------------------------------------------------------

  const PANEL_CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
  const page = async (req, res) => {
    const ok = await serveStatic(req, res, PANEL_DIR, '/index.html', { headers: { 'Content-Security-Policy': PANEL_CSP } });
    if (!ok) sendNotFound(res);
  };
  const redirect = (to) => async (req, res, url) => {
    if (url.pathname === to.slice(0, -1)) {
      res.writeHead(302, { Location: to });
      return res.end();
    }
    return page(req, res);
  };
  privateMounts.push(['/admin/', redirect('/admin/')]);
  privateMounts.push(['/account/', redirect('/account/')]);
  privateMounts.push([
    '/panel/',
    async (req, res, url) => {
      // The panel reuses the CAD app's own tokens, base styles, dialog styles and DOM helper.
      const shared = APP_SHARED[url.pathname];
      if (shared) {
        const ok = await serveStatic(req, res, path.dirname(shared), `/${path.basename(shared)}`, { headers: { 'Content-Security-Policy': PANEL_CSP } });
        return ok || sendNotFound(res);
      }
      const ok = await serveStatic(req, res, PANEL_DIR, url.pathname.slice('/panel'.length), { headers: { 'Content-Security-Policy': PANEL_CSP } });
      if (!ok) sendNotFound(res);
    },
  ]);
}
