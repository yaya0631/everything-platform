/**
 * The hub data API: every /api/hub call the shim makes — fs (behind grants),
 * kv, ai.chat, grants and the per-person data export — registered onto the
 * private api router that server.js guards.
 *
 * Layout note: hub.js keeps the serve-side mounts (pages, shim, icons, read
 * tokens); everything that mutates person data lives here so it is readable
 * and testable as one piece.
 *
 * Every call names its app (?app=<name> in the query, or body.app for JSON
 * routes): the app must be installed, switched on, and (when its access list
 * is set) allowed for this person. Mutating routes additionally pass the
 * same-origin Origin/Sec-Fetch-Site check; the session cookie plus the
 * X-CAD-Request header are checked for every /api call ahead of us.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as db from './db.js';
import { HttpError, send, readJSONBody, requestOrigin } from './http.js';
import * as fsops from './hub-fsops.js';
import * as hubKv from './hub-kv.js';
import * as store from './store.js';
import * as hubAi from './hub-ai.js';
import { availableModels } from './ai.js';
import { exportUserHubData } from './hub-export.js';
import * as hosting from './hub-hosting.js';
import * as mail from './mail.js';

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

const requireRow = (name) => {
  if (!NAME_RE.test(name)) throw new HttpError(404, 'not_found', 'No such app.');
  const row = db.get('SELECT * FROM hub_apps WHERE name = ?', name);
  if (!row) throw new HttpError(404, 'not_found', `The app "${name}" is not installed.`);
  return row;
};

const safeUsers = (v) => {
  try {
    const arr = JSON.parse(v || '[]');
    return Array.isArray(arr) ? arr.filter((u) => typeof u === 'string') : [];
  } catch {
    return [];
  }
};

const smallBody = async (req) => (await readJSONBody(req, 1024 * 1024)) || {};

function sameOriginCheck(ctx) {
  const { req } = ctx;
  if (req.headers.origin && req.headers.origin !== requestOrigin(req)) {
    throw new HttpError(403, 'bad_origin', 'Cross-origin requests are not allowed here.');
  }
  const site = req.headers['sec-fetch-site'];
  if (site && !['same-origin', 'none'].includes(site)) {
    throw new HttpError(403, 'bad_origin', 'Cross-site requests are not allowed here.');
  }
}

export function registerData(s) {
  const { api } = s;

  const hubApp = (ctx, explicit) => {
    const name = explicit !== undefined ? explicit : (ctx.url ? ctx.url.searchParams.get('app') : null);
    if (!name || !NAME_RE.test(name)) throw new HttpError(404, 'not_found', 'No such app.');
    const row = requireRow(name);
    const isAdmin = !!ctx.account?.is_admin;
    if (!row.enabled && !isAdmin) throw new HttpError(404, 'not_found', `The app "${name}" is off.`);
    if (row.access === 'users' && !isAdmin && !safeUsers(row.users).includes(ctx.user)) {
      throw new HttpError(403, 'not_for_you', `Your account cannot use "${name}".`);
    }
    return name;
  };

  const route = (method, routeName, fn, { guard = false } = {}) =>
    api.add(method, `hub/${routeName}`, async (ctx) => {
      if (guard) sameOriginCheck(ctx);
      return fn(ctx);
    });

  // -- fs -------------------------------------------------------------------

  route('GET', 'fs/read', ({ url, res, user, account }) =>
    fsops.read({
      user,
      app: hubApp({ url, user, account }),
      input: url.searchParams.get('path'),
      offset: Number(url.searchParams.get('offset') || 0),
      byteCount: url.searchParams.get('byte_count') ? Number(url.searchParams.get('byte_count')) : null,
      res,
    }));

  route('PUT', 'fs/write', async ({ url, req, res, user, account }) => {
    // The app name rides in the query; the body is the raw bytes.
    const app = hubApp({ url, user, account });
    const options = JSON.parse(url.searchParams.get('options') || '{}');
    const out = await fsops.write({ user, app, input: url.searchParams.get('path'), data: req, options });
    return send(res, 200, out);
  }, { guard: true });

  /** POST helpers: small JSON body first, then the op with the body's app. */
  const fsRoute = (name, fn, { guard = false } = {}) =>
    route('POST', `fs/${name}`, async ({ req, res, url, user, account }) => {
      const body = await smallBody(req);
      const app = appFor({ url, user, account }, body.app);
      return send(res, 200, await fn({ user, app, body }));
    }, { guard });

  const appFor = (ctx, explicit) => hubApp(ctx, explicit !== undefined ? explicit : (ctx.url ? ctx.url.searchParams.get('app') : null));

  // Puter hosting methods share one static service on the public listener.
  route('POST', 'hosting/create', async ({ req, res, url, user, account }) => {
    const body = await smallBody(req); const app = appFor({ url, user, account }, body.app);
    return send(res, 200, await hosting.create({ user, app, subdomain: body.subdomain, root_dir: body.root_dir ?? body.dirPath }));
  }, { guard: true });
  route('POST', 'hosting/get', async ({ req, res, user }) => send(res, 200, hosting.get({ user, subdomain: (await smallBody(req)).subdomain })));
  route('POST', 'hosting/list', async ({ res, user, url }) => send(res, 200, hosting.list({ user, limit: url.searchParams.get('limit'), offset: url.searchParams.get('offset') })));
  route('POST', 'hosting/update', async ({ req, res, user }) => { const body = await smallBody(req); return send(res, 200, await hosting.update({ user, subdomain: body.subdomain, root_dir: body.root_dir ?? body.dirPath })); }, { guard: true });
  route('POST', 'hosting/delete', async ({ req, res, user }) => send(res, 200, hosting.remove({ user, subdomain: (await smallBody(req)).subdomain })), { guard: true });

  fsRoute('mkdir', ({ user, app, body }) => fsops.mkdir({ user, app, input: body.path, options: body.options || {} }), { guard: true });
  fsRoute('readdir', ({ user, app, body }) => fsops.readdir({ user, app, input: body.path, options: body.options || {} }));
  fsRoute('stat', ({ user, app, body }) => fsops.stat({ user, app, input: body.path }));
  fsRoute('delete', ({ user, app, body }) => fsops.del({ user, app, input: body.path, options: body.options || {} }), { guard: true });
  fsRoute('rename', ({ user, app, body }) => fsops.rename({ user, app, from: body.path || body.from, newName: body.newName }), { guard: true });
  fsRoute('move', ({ user, app, body }) => fsops.move({ user, app, source: body.source, destination: body.destination, options: body.options || {} }), { guard: true });
  fsRoute('copy', ({ user, app, body }) => fsops.copy({ user, app, source: body.source, destination: body.destination, options: body.options || {} }), { guard: true });

  route('GET', 'fs/space', async ({ res, user }) => send(res, 200, await fsops.space({ user })));

  route('GET', 'fs/browse', async ({ url, res, user, account }) => {
    const app = appFor({ url, user, account }, url.searchParams.get('app'));
    return send(res, 200, await fsops.browse({
      user, app,
      root: url.searchParams.get('root') || 'drive',
      dir: url.searchParams.get('dir') || '/',
    }));
  });

  route('POST', 'fs/readurl', async ({ req, res, user, account, url }) => {
    const body = await smallBody(req);
    const app = appFor({ url, user, account }, body.app);
    const resv = fsops.access({ user, app, input: body.path, need: 'read' });
    if (resv.kind !== 'drive') {
      // App-local data belongs to one app page; a token URL would leak it
      // wherever the page embeds it.
      throw new HttpError(400, 'not_supported', 'Read URLs work for files on the Drive, not app-local files.');
    }
    const seconds = Math.min(Math.max(1, Number(body.expiresIn) || 3600), 86400);
    return send(res, 200, fsops.readUrlToken({ user, app, virtualPath: resv.virtualPath, expiresIn: seconds }));
  }, { guard: true });

  // -- grants ---------------------------------------------------------------

  api.add('GET', 'hub/grants', ({ res, user }) => {
    const grants = fsops.grantsForUser(user).map((g) => ({
      id: g.id,
      app: g.app,
      path: g.path,
      perms: g.perms,
      source: g.source,
      grantedAt: g.granted_at,
      title: (db.get('SELECT title FROM hub_apps WHERE name = ?', g.app) || {}).title || g.app,
    }));
    return send(res, 200, grants);
  });

  route('POST', 'grants', async ({ req, res, user, account, url }) => {
    const body = await smallBody(req);
    // The picker grants for exactly the app that asked.
    const app = appFor({ url, user, account }, body.app);
    const g = fsops.grantForPick({
      user, app,
      path: body.path,
      need: body.perms === 'read' ? 'read' : 'write',
      source: body.source || 'picker',
    });
    return send(res, 200, { ok: true, grant: g ? { id: g.id, path: g.path, perms: g.perms } : null });
  }, { guard: true });

  route('DELETE', 'grants/:id', ({ res, params, user }) =>
    send(res, 200, fsops.revokeGrant(params.id, user)), { guard: true });

  // -- data export ----------------------------------------------------------

  api.add('GET', 'hub/data/export', ({ res, user }) => {
    const dirs = [];
    const usersDir = path.join(fsops.HUB_USERS_DIR, user);
    if (fs.existsSync(usersDir)) {
      for (const e of fs.readdirSync(usersDir, { withFileTypes: true })) {
        if (e.isDirectory()) dirs.push({ path: path.join(usersDir, e.name), label: 'app-data', app: e.name });
      }
    }
    return exportUserHubData(user, dirs).then((zip) => {
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': zip.length,
        'Content-Disposition': `attachment; filename="hub-data-${user}-${new Date().toISOString().slice(0, 10)}.zip"`,
        'Cache-Control': 'no-store',
      });
      res.end(zip);
    });
  });

  // -- kv --------------------------------------------------------------------

  const kvRoute = (name, fn, { guard = false } = {}) =>
    route('POST', `kv/${name}`, async ({ req, res, user, account }) => {
      const body = await smallBody(req);
      const app = appFor({ url: new URL(req.url, 'http://x'), user, account }, body.app);
      const out = await fn({ user, app, body });
      // The value itself is the JSON answer (a string value is `"soon gone"`,
      // quotes included — exactly what puter's wire carries).
      return send(res, 200, JSON.stringify(out === undefined ? null : out));
    }, { guard });

  kvRoute('get', ({ user, app, body }) => hubKv.get({ user, app, key: body.key }));
  kvRoute('set', ({ user, app, body }) => hubKv.set({ user, app, key: body.key, value: body.value }), { guard: true });
  kvRoute('del', ({ user, app, body }) => hubKv.del({ user, app, key: body.key }), { guard: true });
  kvRoute('list', ({ user, app, body }) => hubKv.list({ user, app, options: body.options ?? body }));
  kvRoute('add', ({ user, app, body }) => hubKv.add({ user, app, key: body.key, value: body.value }), { guard: true });
  kvRoute('incr', ({ user, app, body }) => hubKv.incr({ user, app, key: body.key, value: body.value }), { guard: true });
  kvRoute('decr', ({ user, app, body }) => hubKv.decr({ user, app, key: body.key, value: body.value }), { guard: true });
  kvRoute('update', ({ user, app, body }) => hubKv.update({ user, app, key: body.key, pathMap: body.pathMap }), { guard: true });
  kvRoute('expire', ({ user, app, body }) => hubKv.expire({ user, app, key: body.key, ttlSeconds: body.ttlSeconds ?? body.ttl_seconds }), { guard: true });
  kvRoute('expire-at', ({ user, app, body }) => hubKv.expireAt({ user, app, key: body.key, timestamp: body.timestamp }), { guard: true });
  kvRoute('flush', ({ user, app }) => hubKv.flush({ user, app }), { guard: true });

  // Puter permissions are represented by the hub's account and app access
  // controls. Apps use this lightweight local decision API before opening
  // optional features; no cloud permission service is involved.
  route('POST', 'perms/check', async ({ req, res, user, account, url }) => {
    const body = await smallBody(req);
    const app = hubApp({ url, user, account }, body.app);
    const permission = typeof body.permission === 'string' ? body.permission : '';
    const details = body.options || {};
    const docs = `/${user}/Documents`;
    const granted = permission === 'folder'
      && fsops.grantsForUser(user).filter((g) => g.app === app)
        .some((g) => g.perms === 'write' && (g.path === '/' || g.path === docs || g.path.startsWith(`${docs}/`)));
    return send(res, 200, { granted, permission, app });
  });
  route('POST', 'perms/request', async ({ req, res, user, account, url }) => {
    const body = await smallBody(req);
    const app = hubApp({ url, user, account }, body.app);
    const permission = typeof body.permission === 'string' ? body.permission : '';
    if (permission !== 'folder') return send(res, 200, { granted: false, permission, app });
    const docs = `/${user}/Documents`;
    const grant = fsops.grant(user, app, docs, 'write', 'consent');
    // The shim asks first, with a trusted-user dialog (M8); this route is the
    // grant step after an Allow. The audit trail stays revocable in Account.
    store.audit(user, 'hub.perms_granted', { app, path: docs, perms: 'write', grant: grant.id });
    return send(res, 200, { granted: true, permission, app, path: docs, grant: grant.id });
  }, { guard: true });

  route('POST', 'email/send', async ({ req, res, user, account, url }) => {
    const body = await smallBody(req);
    const app = hubApp({ url, user, account }, body.app);
    const message = body.message && typeof body.message === 'object' ? body.message : {};
    return send(res, 200, await mail.send({ ...message, user, source: `app:${app}` }));
  }, { guard: true });
  route('POST', 'email/send-transactional', async ({ req, res, user, account, url }) => {
    const body = await smallBody(req);
    const app = hubApp({ url, user, account }, body.app);
    const message = body.message && typeof body.message === 'object' ? body.message : {};
    return send(res, 200, await mail.send({ ...message, user, source: `app:${app}:transactional` }));
  }, { guard: true });
  route('POST', 'email/list', async ({ req, res, user, account, url }) => {
    const body = await smallBody(req);
    const app = hubApp({ url, user, account }, body.app);
    const options = body.options && typeof body.options === 'object' ? body.options : {};
    return send(res, 200, { items: mail.recentLog(Math.min(Number(options.pageSize) || 50, 200)).filter((row) => row.user === user && row.source.startsWith(`app:${app}`)) });
  });

  // -- ai --------------------------------------------------------------------

  // The models the admin turned on, in the same shape CAD's assistant uses:
  // [{ id, label, provider, providerLabel, tools }]. Hub apps ask for these
  // instead of carrying their own hardcoded list.
  route('GET', 'ai/models', async ({ res, user, account, url }) => {
    hubApp({ url, user, account });
    return send(res, 200, await availableModels());
  });

  route('POST', 'ai/chat', async ({ req, res, user, account, url }) => {
    const body = await smallBody(req);
    const app = appFor({ url, user, account }, body.app);
    // Streaming writes its own NDJSON line protocol; a plain call returns the
    // puter ChatResponse here, and the route must actually send it.
    const out = await hubAi.chat({ req, res, body, user, app });
    if (out) return send(res, 200, out);
  });

  for (const kind of ['txt2img', 'img2txt', 'txt2speech', 'speech2txt', 'txt2vid']) {
    api.add('POST', `hub/ai/${kind}`, ({ res }) => hubAi.sendEngineError(res, kind));
  }
}
