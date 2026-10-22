/**
 * The HTTP surface of hub workers (Phase 3):
 *
 *   /api/hub/workers            POST create, GET list            (session + X-CAD-Request)
 *   /api/hub/workers/<name>     GET get, DELETE delete
 *   /api/hub/workers/exec       POST exec (§2: any signed-in member may exec)
 *
 *   /wr/<user>/<name>/...       private listener serving — exec or the owner
 *   /wr/app/<app>/<name>/...    packaged system workers, same rules
 *   /w/<user>/<name>/...        PUBLIC listener guest serving (§9/§23):
 *                               public + approved only, no ctx.user, no fs,
 *                               no cookies anywhere (§16)
 *
 * Boundary discipline (§16): worker responses get
 * `Content-Security-Policy: sandbox allow-scripts allow-forms`, nosniff
 * (base header), an allow-listed content-type (enforced in the runtime), no
 * Set-Cookie (stripped), and the worker never sees the caller's Cookie header.
 */
import * as db from './db.js';
import * as store from './store.js';
import { createHash } from 'node:crypto';
import { HttpError, send, readJSONBody, rateLimit, clientIp, requestOrigin } from './http.js';
import * as config from './config.js';
import * as fsops from './hub-fsops.js';
import * as hubWorkers from './hub-workers.js';
import * as run from './hub-workers-run.js';
import { rewriteWorkerSource } from './hub-rewrite.js';

const NAME_RE = hubWorkers.NAME_RE;
const GUEST_RATE = { windowMs: 60_000, max: 120 };

const sessionOf = (registry, req) => {
  const token = registry.sessionToken(req);
  return token ? store.sessionInfo(token) : null;
};

/** The same page/fetch-path rule the other hub mutations use. */
function sameOrigin(ctx) {
  const { req } = ctx;
  if (req.headers.origin && req.headers.origin !== requestOrigin(req)) {
    throw new HttpError(403, 'bad_origin', 'Cross-origin requests are not allowed here.');
  }
  const site = req.headers['sec-fetch-site'];
  if (site && !['same-origin', 'none'].includes(site)) {
    throw new HttpError(403, 'bad_origin', 'Cross-site requests are not allowed here.');
  }
}

/** Flatten a node request into { method, path, headers, body } for the runtime. */
function describe(req, url, body, baseLen, { publicRoute = false, row = null } = {}) {
  const headers = {};
  const privateHostHeaders = new Set(['host', 'forwarded', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-original-host']);
  for (const [k, v] of Object.entries(req.headers)) {
    if (k === 'cookie' || k === 'set-cookie' || k === 'x-cad-request' || (publicRoute && privateHostHeaders.has(k))) continue;
    headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  // The worker sees its OWN path, not the /wr/... or /w/... wrapper (its
  // routes register relative, matching upstream).
  let wpath = url.pathname.length > baseLen ? url.pathname.slice(baseLen) : '/';
  if (!wpath.startsWith('/')) wpath = `/${wpath}`;
  // The child may build absolute URLs (redirect targets like the RSVP
  // one-click links use the WORKER's own origin) — give it the real one;
  // the child falls back to its fake host when this is absent.
  const configuredPublicBase = String(config.get('workers.public_base_url', '') ?? '').trim().replace(/\/+$/, '');
  // Request.url is always the worker's canonical origin. Public listener
  // addresses stay in workerBase, sourced only from workers.public_base_url.
  const origin = row ? `https://${hubWorkers.canonicalHostLabel(row)}.puter.work` : (publicRoute ? 'https://worker.invalid' : originOf(req));
  const routePrefix = url.pathname.slice(0, baseLen);
  const workerBase = row && publicRoute
    ? (configuredPublicBase ? `${configuredPublicBase}${routePrefix}` : '')
    : (row ? origin : (publicRoute
      ? (configuredPublicBase ? `${configuredPublicBase}${routePrefix}` : '')
      : `${origin}${routePrefix}`));
  return {
    method: req.method,
    path: `${wpath}${url.search}`,
    // Keep the app-facing URL path relative to the worker (as upstream
    // expects), while retaining the real listener origin for redirects.
    absoluteUrl: `${origin}${wpath}${url.search}`,
    // A guest-link worker such as signatures must publish its wrapper base
    // (/w/<user>/<name>) separately from the route-local Request URL.
    workerBase,
    headers,
    body,
    origin,
  };
}

/** http(s)://<host header> of the incoming request ('' when absent). */
function originOf(req) {
  const host = req.headers && req.headers.host;
  return host ? `${req.socket?.encrypted || (req.connection && req.connection.encrypted) ? 'https' : 'http'}://${host}` : '';
}

/** The §16 response headers every worker route serves through. */
function workerResHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    const key = String(k).toLowerCase();
    if (key === 'set-cookie' || key === 'content-security-policy' || key === 'x-content-type-options') continue;
    out[k] = v;
  }
  out['Content-Security-Policy'] = 'sandbox allow-scripts allow-forms';
  out['X-Content-Type-Options'] = 'nosniff';
  out['Cache-Control'] = 'no-store';
  return out;
}

async function respondWorker(res, out, { cors = false, row = null, routePath = '' } = {}) {
  const publicFile = out.headers?.['x-cad-public-file'] || out.headers?.['X-CAD-Public-File'];
  if (publicFile !== undefined) {
    const match = /^\/api\/sign\/([0-9a-f]{40})\/pdf$/.exec(String(routePath));
    const safePath = String(publicFile);
    if (!cors || row?.app !== 'signatures' || !row.user || !match
      || !/^signatures-data\/[A-Za-z0-9._-]{1,200}\/original\.pdf$/.test(safePath)) {
      throw new HttpError(404, 'not_found', 'Unknown public file.');
    }
    const tokenHash = createHash('sha256').update(match[1]).digest('hex');
    const kvApp = `worker:${row.name}`;
    const tokenRow = db.get('SELECT value FROM hub_kv WHERE user = ? AND app = ? AND key = ?',
      row.user, kvApp, `sigw:tok:${tokenHash}`);
    let tokenRef;
    try { tokenRef = JSON.parse(tokenRow?.value || 'null'); } catch { tokenRef = null; }
    if (!tokenRef?.docId || safePath !== `signatures-data/${tokenRef.docId}/original.pdf`) {
      throw new HttpError(404, 'not_found', 'Unknown public file.');
    }
    const recordRow = db.get('SELECT value FROM hub_kv WHERE user = ? AND app = ? AND key = ?',
      row.user, kvApp, `sigw:doc:${tokenRef.docId}`);
    let record;
    try { record = JSON.parse(recordRow?.value || 'null'); } catch { record = null; }
    if (!record?.signers?.[tokenRef.signerId] || record.doc?.pdfPath !== safePath) {
      throw new HttpError(404, 'not_found', 'Unknown public file.');
    }
    const bytes = await fsops.read({ user: row.user, app: row.app, input: safePath });
    const headers = workerResHeaders(out.headers);
    delete headers['x-cad-public-file'];
    headers['Content-Type'] = 'application/pdf';
    headers['Content-Length'] = bytes.length;
    if (cors) {
      headers['Access-Control-Allow-Origin'] = '*';
      headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
    }
    res.writeHead(out.status ?? 200, headers);
    res.end(bytes);
    return;
  }
  const headers = workerResHeaders(out.headers);
  // Public listener only (§9): the guest sign/RSVP pages talk to the worker
  // cross-origin exactly the way upstream's *.puter.work platform allows.
  if (cors) {
    headers['Access-Control-Allow-Origin'] = '*';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
  }
  let responseBody = out.body ?? '';
  const contentType = Object.entries(headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] || '';
  if (cors && /(?:text\/html|application\/xhtml\+xml)/i.test(String(contentType))) {
    responseBody = injectWorkerMapTag(String(responseBody));
    headers['Content-Length'] = Buffer.byteLength(responseBody);
    headers['Content-Security-Policy'] = "sandbox allow-scripts allow-forms; connect-src 'self' ws: wss:";
  }
  res.writeHead(out.status ?? 200, headers);
  res.end(responseBody);
}

function injectWorkerMapTag(html) {
  if (html.includes('/hub/worker-url-map.js')) return html;
  const tag = '<script src="/hub/worker-url-map.js" defer></script>';
  return /<\/head\s*>/i.test(html) ? html.replace(/<\/head\s*>/i, `${tag}</head>`) : `${tag}${html}`;
}

/** Resolve /wr/<user>/<name>/... or /wr/app/<app>/<name>/... → row + /wr/-prefix length. */
function parseWr(url) {
  const parts = url.pathname.replace(/^\/wr\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'app') {
    const [app, name] = parts.slice(1);
    if (!app || !name) return null;
    return { row: hubWorkers.resolveRoute({ user: null, name }), baseLen: `/wr/app/${app}/${name}`.length };
  }
  const [user, name] = parts;
  if (!user || !name) return null;
  return { row: hubWorkers.resolveRoute({ user, name }), baseLen: `/wr/${user}/${name}`.length };
}

/** Parse /w/<user>/<name>/... (guest). Bare /w/cal-<user>/ means the calendar's cal-<user>. */
function parseW(url) {
  if (url.pathname.startsWith('/w/host/')) {
    const parts = url.pathname.slice('/w/host/'.length).split('/');
    const hostLabel = decodeURIComponent(parts.shift() || '');
    if (!hostLabel) return null;
    return { row: hubWorkers.resolveHostLabel(hostLabel), hostLabel, baseLen: `/w/host/${hostLabel}`.length };
  }
  const parts = url.pathname.replace(/^\/w\/?/, '').split('/').filter(Boolean);
  // calendar's cal-<user> worker leads BOTH forms — the whole rest of the
  // path is the worker route (the calendar calls ${w}/api/...): the app-built
  // label wins over the generic <user>/<name> split, whose user arm would
  // otherwise read the label as username + wrong name.
  if (parts[0] && /^cal-/i.test(parts[0])) {
    return { user: parts[0].slice(4), name: parts[0], baseLen: `/w/${parts[0]}`.length };
  }
  if (parts.length >= 2) {
    return { user: parts[0], name: parts[1], baseLen: `/w/${parts[0]}/${parts[1]}`.length };
  }
  return null;
}

function registerRoutes(api) {
  const readScriptForCreate = async ({ user, app, filePath }) => {
    const buf = await fsops.read({ user, app, input: filePath });
    const source = Buffer.isBuffer(buf) ? buf.toString('utf8') : '';
    const text = rewriteWorkerSource(source, { app, filePath }).text;
    const bytes = hubWorkers.assertScript(text);
    return { text, bytes };
  };

  // §23: where GUEST links should point (share pages, invite links, worker
  // public routes). Unset → the honest note explains reachability, and
  // builders fall back to the request origin (works only on the same network
  // the link names).
  api.add('GET', 'hub/workers/guest-base', async ({ res, req }) => {
    const raw = String(config.get('workers.public_base_url', '') ?? '').trim().replace(/\/+$/, '');
    return send(res, 200, JSON.stringify({
      base: raw,
      origin: req.headers.host ? `http://${req.headers.host}` : null,
      note: raw
        ? 'Guest links use this address; they work for anyone whose network can reach it.'
        : 'No guest address is configured: guest links name THIS server\'s address as you see it, and are reachable only from networks that can reach that listener. A loopback-only hub is LAN-only; guests cannot reach it from the internet unless an address reachable from outside is configured here (or 443 is proxied to this server).',
    }));
  });

  api.add('POST', 'hub/workers', async (ctx) => {
    sameOrigin(ctx);
    const { req, res, user } = ctx;
    const body = await readJSONBody(req, 1024 * 1024);
    const { app, name, filePath } = body;
    if (!NAME_RE.test(String(name ?? ''))) throw new HttpError(400, 'bad_name', 'Worker names are 2–64 characters: letters, digits and dashes.');
    // A virtual deploy reads the script through the CALLING app's access
    // rules right now — the file must be readable to this app this moment;
    // that is the consent moment (§13).
    const { text, bytes } = await readScriptForCreate({ user, app, filePath });
    const out = await hubWorkers.create({ user, app, name, filePath, initialSha: hubWorkers.hashOf(text) });
    return send(res, 200, JSON.stringify({ success: true, ...out, bytes }));
  });

  api.add('POST', 'hub/workers/list', async ({ req, res, user, account }) => {
    void account;
    const items = hubWorkers.listFor({ user, app: null });
    return send(res, 200, JSON.stringify(items));
  });

  // §20 audit surface: admins see every workers-log row, a member sees only
  // their own (pool evictions, stalls, rate-limit hits, deployments).
  api.add('GET', 'hub/workers/logs', async ({ res, user, account }) => {
    const scoped = account?.is_admin
      ? hubWorkers.recentLogsAll(100)
      : hubWorkers.recentLogsFor(user, 100);
    return send(res, 200, JSON.stringify(scoped));
  });

  api.add('POST', 'hub/workers/get', async ({ req, res, user, params }) => {
    void params;
    const { name } = await readJSONBody(req, 1024 * 1024);
    const row = hubWorkers.resolveRoute({ user, name: String(name ?? '') });
    if (!row) throw new HttpError(404, 'worker_not_found', `No worker named "${name}" for you.`);
    return send(res, 200, JSON.stringify(hubWorkers.shapeOf(row)));
  });

  api.add('POST', 'hub/workers/delete', async (ctx) => {
    sameOrigin(ctx);
    const { req, res, user } = ctx;
    const { name } = await readJSONBody(req, 1024 * 1024);
    await hubWorkers.deployDelete({ user, app: null }, String(name ?? ''));
    return send(res, 200, JSON.stringify({ success: true }));
  });

  // exec (§2/§17): any signed-in member through their app; ctx.user is the
  // CALLER. The raw worker Response is returned (apps call res.json()), and
  // named errors pass structured codes (calendar wants name_taken).
  api.add('POST', 'hub/workers/exec', async (ctx) => {
    sameOrigin(ctx);
    const { req, res, user } = ctx;
    const body = await readJSONBody(req, 1024 * 1024);
    const { target, name: nameIn, method = 'GET', path: wpath = '/', headers = {}, body: wbody = '' } = body;
    const row = resolveExecTarget(user, target, nameIn);
    if (!row) {
      // design §10: an unknown *.puter.work host is a NAMED error, never a
      // silent pass-through — the app wrote an address this server is not
      // (yet) hosting.
      if (/^(?:https?:)?\/\/[^/]*\.puter\.work(?:[/?#]|$)/i.test(String(target ?? ''))) {
        throw new HttpError(403, 'external_not_allowed', `"${target}" is a puter.work address this server does not host. Use the packaged worker's name or your own deploy.`);
      }
      throw new HttpError(404, 'worker_not_found', 'There is no such worker to exec.');
    }
    const out = await run.invoke(row, { method, path: wpath, headers, body: typeof wbody === 'string' ? wbody : JSON.stringify(wbody ?? ''), origin: originOf(req) }, { user, viaExec: true, ip: clientIp(req) });
    respondWorker(res, out);
  });
}

/** Resolve an exec target: '<owner>/<name>' | 'https://<name>.puter.work[/x]' | name. */
function resolveExecTarget(user, target, nameIn) {
  const owners = [
    typeof target === 'string' && target.includes('/') ? target.replace(/^\/+/, '').split('/') : null,
  ];
  const parts = owners[0];
  if (parts && parts.length >= 2) {
    const row = parts[0] === 'app'
      ? hubWorkers.resolveRoute({ user: null, name: parts[1] })
      : hubWorkers.resolveRoute({ user: parts[0], name: parts[1] });
    if (row) return row;
  }
  // A bare name resolves PACKAGED FIRST (design §10: nobody's personal deploy
  // can shadow a fixed system name), then the caller's own row, then the
  // cal-<user> pattern (calendar's per-user booking worker).
  const bare = (nameIn ?? (typeof target === 'string' && !target.includes('/')
    ? String(target).replace(/^(?:https?:)?\/\//, '').split('/')[0].replace(/\.puter\.work$/, '')
    : '')).trim();
  if (!bare) return null;
  try {
    return hubWorkers.resolveHostLabel(bare)
      ?? db.get('SELECT * FROM hub_workers WHERE user IS NULL AND name = ?', bare)
      ?? hubWorkers.resolveRoute({ user, name: bare })
      ?? (/^cal-/.test(bare) ? hubWorkers.resolveRoute({ user: bare.slice(4), name: bare }) : null);
  } catch {
    return null;
  }
}

/** Private listener /wr/ mount. */
async function serveWrPrivate(req, res, url, registry) {
  const parsed = parseWr(url);
  const row = parsed?.row;
  if (!row) throw new HttpError(404, 'no_such_worker', 'Unknown worker address.');
  const session = sessionOf(registry, req);
  const isExec = req.headers['x-cad-request'] === '1';
  const isAdmin = !!session?.account?.is_admin;

  if (!session) {
    throw new HttpError(401, 'login_required', 'Sign in to call this worker. Guests use its public address.');
  }
  // exec: any signed-in member (§17). Without the exec header, a direct
  // browse is owner/admin only — a stranger's session cannot drive it.
  const viaExec = isExec || session.user === row.user || isAdmin;
  if (!viaExec) {
    throw new HttpError(401, 'not_for_you', 'This worker belongs to someone else.');
  }

  const body = await readBodyRaw(req, 1024 * 1024); // §12 cap here too
  const out = await run.invoke(row, describe(req, url, body, parsed.baseLen, { row }), { user: session.user, viaExec: true, ip: clientIp(req) });
  await respondWorker(res, out, { row, routePath: url.pathname.slice(parseWr(url)?.baseLen || 0) });
}

async function serveHostPrivate(req, res, url, registry) {
  const parsed = parseW(url);
  // §10/§26: an alias-shaped address this server does not host is a NAMED
  // external refusal (the same rule exec uses) — never a silent 404, so an
  // app can tell "not our worker" from "not a worker at all".
  if (parsed && !parsed.row && parsed.hostLabel) {
    throw new HttpError(403, 'external_not_allowed', `"${parsed.hostLabel}.puter.work" is a puter.work address this server does not host. Use the packaged worker's name or your own deploy.`);
  }
  const row = parsed?.row;
  if (!row) throw new HttpError(404, 'not_found', 'Unknown worker address.');
  const session = sessionOf(registry, req);
  if (!session) throw new HttpError(401, 'login_required', 'Sign in to use this worker URL.');
  const owner = row.user === session.user || (!row.user && row.app === session.app);
  const admin = !!session.account?.is_admin;
  const publicShared = hubWorkers.isPublicServing(row);
  if (!owner && !admin && !publicShared) throw new HttpError(404, 'not_found', 'Unknown worker address.');
  const body = await readBodyRaw(req, 1024 * 1024);
  const guest = !owner && !admin;
  const out = await run.invoke(row, describe(req, url, body, parsed.baseLen, { publicRoute: guest, row }), {
    user: guest ? null : session.user,
    publicGuest: guest,
    viaExec: !guest,
    ip: clientIp(req),
  });
  await respondWorker(res, out, { row, routePath: url.pathname.slice(parsed.baseLen) });
}

/** Public listener /w/ + /wr/ mounts (§9): public+approved only, guest context. */
async function serveWrPublic(req, res, url, registry) {
  void registry;
  // The sign/RSVP guest pages live on one origin (the public listener) and
  // call the worker from there; owner-side flows (verify/sync with a Bearer
  // secret) arrive cross-origin from the app's private page. That is the
  // commodity behavior upstream's *.puter.work platform provides — answer
  // the preflight and let cross-origin callers through. Authorization on
  // every route is unchanged: tokens/secrets, never cookies.
  const origin = req.headers.origin;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'authorization, content-type, x-sign-session',
      'Access-Control-Max-Age': '600',
    });
    res.end();
    return;
  }
  try {
    let row;
    let baseLen = 0;
    if (url.pathname.startsWith('/w/')) {
      const parsed = parseW(url);
      if (!parsed) throw new HttpError(404, 'not_found', 'Unknown worker address.');
      if (!parsed.row && parsed.hostLabel) {
        // Same named external refusal as the private mount (§10/§26).
        throw new HttpError(403, 'external_not_allowed', `"${parsed.hostLabel}.puter.work" is a puter.work address this server does not host. Use the packaged worker's name or your own deploy.`);
      }
      row = parsed.row || hubWorkers.resolveRoute({ user: parsed.user, name: parsed.name });
      baseLen = parsed.baseLen;
    } else {
      const parsed = parseWr(url);
      if (!parsed) throw new HttpError(404, 'not_found', 'Unknown worker address.');
      row = parsed.row;
      baseLen = parsed.baseLen;
    }
    if (!row || !hubWorkers.isPublicServing(row)) {
      // 404 both for absent AND private workers on the public listener (§17).
      throw new HttpError(404, 'not_found', 'Unknown public worker address.');
    }
    // GUEST_RATE is a {windowMs, max} shape; the shared limiter takes the
    // numbers directly (the object was silently accepted and the cap never
    // fired — the guest-link flow test caught it).
    if (!rateLimit(`gw:${clientIp(req)}`, GUEST_RATE.max, GUEST_RATE.windowMs)) {
      throw new HttpError(429, 'rate_limited', 'Too many requests from this address; try again shortly.');
    }
    const raw = await readBodyRaw(req, 1024 * 1024);
    const out = await run.invoke(row, describe(req, url, raw, baseLen, { publicRoute: true, row }), { user: null, publicGuest: true, ip: clientIp(req) });
    await respondWorker(res, out, { cors: true, row, routePath: url.pathname.slice(baseLen) });
  } catch (err) {
    // Even the error shapes carry CORS — an owner page cross-origin verify
    // must be able to READ the status (a bare TypeError hides 429/503).
    if (err instanceof HttpError && origin) {
      res.writeHead(err.status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ code: err.code, message: err.message }));
      return;
    }
    throw err;
  }
}

function readBodyRaw(req, cap) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) {
        req.destroy();
        resolve('');
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

export function register(registry) {
  const { api, privateMounts, publicMounts } = registry;
  registerRoutes(api);

  privateMounts.push(['/wr/', (req, res, url) => serveWrPrivate(req, res, url, registry)]);
  privateMounts.push(['/w/host/', (req, res, url) => serveHostPrivate(req, res, url, registry)]);
  publicMounts.push(['/w/', (req, res, url) => serveWrPublic(req, res, url, registry)]);
  publicMounts.push(['/wr/', (req, res, url) => serveWrPublic(req, res, url, registry)]);
  registry.onShutdown?.(() => run.closeAllPools());
}

/* tests reach these too */
/** Seed packaged rows for system workers (§10) — install step calls this per app. */
export async function ensurePackagedWorker(app, name, filePath) {
  return hubWorkers.create({ user: null, app, name, filePath });
}

/** Composition-time bookkeeping rows for the admin ledger. */
export function recentLogs(limit = 50) {
  return db.all('SELECT * FROM hub_workers_log ORDER BY at DESC, id DESC LIMIT ?', Math.min(500, Math.max(1, limit)));
}

void NAME_RE;
