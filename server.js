#!/usr/bin/env node
/**
 * CAD Home: run the CAD app from your own computer, with the cloud features
 * Puter normally provides served from this machine.
 *
 * Two listeners, kept apart by socket:
 *   private  PORT (8080) on HOST     the app, accounts, drive, live editing, admin, private apps
 *                                    → tailscale serve --bg --https=443 http://127.0.0.1:8080
 *   public   CAD_PUBLIC_PORT (8081)  share links and public apps only, never reads cookies
 *            always on 127.0.0.1     → tailscale funnel --bg --https=8443 http://127.0.0.1:8081
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from './lib/db.js';
import * as store from './lib/store.js';
import * as config from './lib/config.js';
import * as drive from './lib/drive.js';
import * as admin from './lib/admin.js';
import * as shares from './lib/shares.js';
import * as live from './lib/live.js';
import * as ai from './lib/ai.js';
import * as apps from './lib/apps.js';
import * as hub from './lib/hub.js';
import * as hubWorkersHttp from './lib/hub-workers-http.js';
import * as hubHosting from './lib/hub-hosting.js';
import * as fn from './lib/functions.js';
import { APP_DIR, DATA_DIR } from './lib/paths.js';
import { checkWorkerNodeVersion } from './lib/hub-workers-run.js';
import { HttpError, Router, send, readJSONBody, cookies, isHttps, realClientKey, serveStatic, sendNotFound, recordError } from './lib/http.js';

const COOKIE = 'cad_session';
const MAX_KV = 256 * 1024;

export function sessionCookie(req, token, maxAge) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
}

export function sessionToken(req) {
  return cookies(req)[COOKIE];
}

// Sign-in limits ---------------------------------------------------------------------

const failures = new Map();
const FAIL_WINDOW = 15 * 60 * 1000;
const FAIL_LIMIT = 10;

function failureKey(req, username) {
  // Behind `tailscale serve` every socket is 127.0.0.1 — keying on the socket
  // address meant one client's wrong-password streak locked that (username,
  // 127.0.0.1) pair for everybody in the tailnet, 15 minutes at a time. The
  // key is the REAL client now: Tailscale-User-Login (a tailnet person,
  // trustworthy because serve strips client-supplied values and the
  // connection is loopback — see lib/http.js realClientKey), else the tailnet
  // address in X-Forwarded-For, else the socket.
  return `${realClientKey(req)}|${store.normalizeName(username)}`;
}

export function checkFailures(key) {
  const f = failures.get(key);
  if (f && Date.now() - f.first < FAIL_WINDOW && f.count >= FAIL_LIMIT) {
    throw new HttpError(429, 'too_many_attempts', 'Too many wrong passwords. Wait 15 minutes and try again.');
  }
}

export function addFailure(key) {
  if (failures.size > 5000) for (const [k, f] of failures) if (Date.now() - f.first >= FAIL_WINDOW) failures.delete(k);
  const f = failures.get(key);
  if (!f || Date.now() - f.first >= FAIL_WINDOW) failures.set(key, { first: Date.now(), count: 1 });
  else f.count++;
}

// Routes ------------------------------------------------------------------------------

/** Routes that work without a session. */
const open = new Router();
/** Routes for signed-in people: handlers get { req, res, url, params, user, account, session, token }. */
const api = new Router();

open.add('POST', 'auth/login', async ({ req, res }) => {
  const { username, password } = (await readJSONBody(req)) || {};
  const key = failureKey(req, username);
  checkFailures(key);
  const name = store.checkLogin(username, password);
  if (!name) {
    addFailure(key);
    throw new HttpError(401, 'wrong_credentials', 'That username and password do not match an account on this server.');
  }
  failures.delete(key);
  const session = store.createSession(name, { userAgent: req.headers['user-agent'] });
  return send(res, 200, store.publicUser(store.getAccount(name)), { 'Set-Cookie': sessionCookie(req, session, store.SESSION_MAX_AGE) });
});

open.add('POST', 'auth/logout', async ({ req, res }) => {
  store.endSession(sessionToken(req));
  return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
});

api.add('GET', 'auth/me', async ({ res, account }) => send(res, 200, store.publicUser(account)));

api.add('GET', 'kv/:key', async ({ res, params, user }) => {
  if (!/^[\w.-]{1,64}$/.test(params.key)) throw new HttpError(404, 'unknown_route', 'Unknown request.');
  return send(res, 200, { value: store.kvGet(`user:${user}`, params.key) ?? null });
});

api.add('PUT', 'kv/:key', async ({ req, res, params, user }) => {
  if (!/^[\w.-]{1,64}$/.test(params.key)) throw new HttpError(404, 'unknown_route', 'Unknown request.');
  const body = await readJSONBody(req, MAX_KV);
  const ns = `user:${user}`;
  const value = body?.value ?? null;
  const before = store.kvGet(ns, params.key);
  const size = store.kvSize(ns) - (before == null ? 0 : params.key.length + JSON.stringify(before).length);
  if (value != null && size + params.key.length + JSON.stringify(value).length > MAX_KV) throw new HttpError(413, 'too_large', 'Too much settings data.');
  store.kvSet(ns, params.key, value);
  return send(res, 200, { ok: true });
});

drive.routes(api);

/** Feature modules add their routes here. */
export const routers = { open, api };

async function handleApi(req, res, url) {
  // Pages on other sites cannot add this header without a CORS preflight, which
  // this server never allows, so they cannot act on someone's session.
  if (req.headers['x-cad-request'] !== '1') throw new HttpError(403, 'forbidden', 'Requests must come from the CAD app.');
  const route = url.pathname.slice('/api/'.length);
  const ctx = { req, res, url, params: {} };
  const pre = open.match(req.method, route);
  if (pre) return pre.fn({ ...ctx, params: pre.params });
  const m = api.match(req.method, route);
  if (!m) throw new HttpError(404, 'unknown_route', 'Unknown request.');
  const token = sessionToken(req);
  const session = store.sessionInfo(token);
  if (!session) throw new HttpError(401, 'not_signed_in', 'Sign in to use your server drive.');
  return m.fn({ ...ctx, params: m.params, user: session.user, account: session.account, session, token });
}

/** Path prefixes handled by feature modules: [prefix, handler(req, res, url)] */
export const privateMounts = [];
export const publicMounts = [];

async function serveApp(req, res, url) {
  const ok = await serveStatic(req, res, APP_DIR, url.pathname, {
    // Build files carry a content hash in their names; everything else is checked on every load.
    cache: (p) => (p.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'),
  });
  if (!ok) sendNotFound(res);
}

function baseHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
}

async function guard(req, res, fn) {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return send(res, 400, { code: 'bad_request' });
  }
  try {
    await fn(url);
  } catch (err) {
    if (res.headersSent) return res.destroy();
    if (err instanceof HttpError) {
      // Consent flows need the structured grant request on the wire; every
      // other error stays { code, message } exactly as before.
      return send(res, err.status, err.grant_request
        ? { code: err.code, message: err.message, grant_request: err.grant_request }
        : { code: err.code, message: err.message });
    }
    console.error(`${req.method} ${url.pathname}:`, err);
    recordError(`${req.method} ${url.pathname}`, err);
    send(res, 500, { code: 'server_error', message: 'Something went wrong on the server.' });
  }
}

export function handlePrivate(req, res) {
  baseHeaders(res);
  return guard(req, res, async (url) => {
    for (const [prefix, fn] of privateMounts) if (url.pathname === prefix.replace(/\/$/, '') || url.pathname.startsWith(prefix)) return fn(req, res, url);
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    return serveApp(req, res, url);
  });
}

export function handlePublic(req, res) {
  req.isPublic = true;
  // Public routes never need account state. Do not let an ambient browser
  // cookie become visible to any public-listener handler.
  delete req.headers.cookie;
  baseHeaders(res);
  return guard(req, res, async (url) => {
    for (const [prefix, fn] of publicMounts) if (url.pathname === prefix.replace(/\/$/, '') || url.pathname.startsWith(prefix)) return fn(req, res, url);
    sendNotFound(res);
  });
}

/** WebSocket upgrade handlers: [prefix, fn(req, socket, head, url)] */
export const upgradeMounts = { private: [], public: [] };

function routeUpgrade(kind) {
  return (req, socket, head) => {
    if (kind === 'public') req.isPublic = true;
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return socket.destroy();
    }
    for (const [prefix, fn] of upgradeMounts[kind]) {
      if (prefix instanceof RegExp ? prefix.test(url.pathname) : url.pathname === prefix) {
        return Promise.resolve(fn(req, socket, head, url)).catch((err) => {
          console.error('WebSocket:', err);
          socket.destroy();
        });
      }
    }
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
  };
}

// Shutdown ---------------------------------------------------------------------------

const shutdownHooks = [];
/** Async cleanup run once on shutdown, in the order added (live rooms flush, runners stop). */
export function onShutdown(fn) {
  shutdownHooks.push(fn);
}

// Feature modules ----------------------------------------------------------------------

let boundPublicPort = null;
const registry = {
  open,
  api,
  privateMounts,
  publicMounts,
  upgradeMounts,
  onShutdown,
  sessionCookie,
  sessionToken,
  publicPort: () => boundPublicPort,
};
for (const m of [admin, shares, live, ai, apps, fn, hub, hubWorkersHttp, hubHosting]) m.register(registry);

// Startup ----------------------------------------------------------------------------

function tlsOptions() {
  const cert = process.env.CAD_TLS_CERT;
  const key = process.env.CAD_TLS_KEY;
  if (!cert && !key) return null;
  if (!cert || !key) throw new Error('Set both CAD_TLS_CERT and CAD_TLS_KEY to use HTTPS.');
  return { cert: fs.readFileSync(cert), key: fs.readFileSync(key) };
}

function addresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  return out;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve(server.address().port);
    });
  });
}

/**
 * Start both listeners. Returns { privatePort, publicPort, close() }. Tests use
 * port 0 for both.
 */
export async function startServer({
  port = Number(process.env.PORT) || 8080,
  publicPort = process.env.CAD_PUBLIC_PORT === undefined ? 8081 : Number(process.env.CAD_PUBLIC_PORT),
  host = process.env.HOST || '0.0.0.0',
  tls = tlsOptions(),
} = {}) {
  db.open();
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  store.prune();
  const pruner = setInterval(() => {
    try {
      store.prune();
    } catch (err) {
      console.error('Cleanup:', err.message);
    }
  }, 3600_000);
  pruner.unref();

  const priv = tls ? https.createServer(tls, handlePrivate) : http.createServer(handlePrivate);
  const pub = http.createServer(handlePublic);
  priv.on('upgrade', routeUpgrade('private'));
  pub.on('upgrade', routeUpgrade('public'));
  for (const s of [priv, pub]) {
    s.headersTimeout = 60_000;
    s.requestTimeout = 0; // large uploads and streaming AI replies
  }
  const privatePort = await listen(priv, port, host);
  const publicPortBound = await listen(pub, publicPort, '127.0.0.1');
  boundPublicPort = publicPortBound;

  let closing = null;
  const close = () =>
    (closing ??= (async () => {
      clearInterval(pruner);
      priv.close();
      pub.close();
      for (const fn of shutdownHooks) {
        try {
          await fn();
        } catch (err) {
          console.error('Shutdown:', err.message);
        }
      }
      priv.closeAllConnections?.();
      pub.closeAllConnections?.();
      db.close();
    })());
  return { privatePort, publicPort: publicPortBound, tls: !!tls, close, servers: { private: priv, public: pub } };
}

function banner({ privatePort, publicPort, tls }) {
  // §19: if the pool forks a dedicated worker-binary copy, make sure it is
  // the SAME node version as this server — a stale copy would run worker
  // code on a different runtime than the server that shells it.
  checkWorkerNodeVersion();
  const scheme = tls ? 'https' : 'http';
  console.log(`\nCAD Home is running.\n`);
  console.log(`  On this computer:     ${scheme}://localhost:${privatePort}/`);
  for (const ip of addresses()) console.log(`  On your network:      ${scheme}://${ip}:${privatePort}/`);
  console.log(`  Public listener:      http://127.0.0.1:${publicPort}/  (share links and public apps only)`);
  console.log(`\n  Data folder:          ${DATA_DIR}`);
  const users = store.listUsers();
  if (!users.length) console.log('\n  No accounts yet. Add one with:  npm run user -- add <name>');
  else {
    console.log(`  Accounts:             ${users.length}`);
    if (!store.countAdmins()) console.log('\n  No one is an admin yet. Make yourself one with:  npm run user -- admin <name>');
  }
  console.log('\n  Tailscale (run once on this PC):');
  console.log(`    tailscale serve  --bg --https=443  http://127.0.0.1:${privatePort}     private: you and people you invite`);
  console.log(`    tailscale funnel --bg --https=8443 http://127.0.0.1:${publicPort}     public: share links and public apps`);
  const pu = config.publicUrl();
  console.log(pu ? `  Public address:       ${pu}` : '  Public address:       not set (Admin → Server), so share links are off');
  console.log('\nPress Ctrl+C to stop.\n');
}

async function main() {
  if (!fs.existsSync(path.join(APP_DIR, 'index.html'))) {
    console.error('The CAD app has not been built yet. Run "npm run setup" in the cad-home folder first.');
    process.exit(1);
  }
  let running;
  try {
    running = await startServer();
  } catch (err) {
    if (err.code === 'EADDRINUSE') console.error(`Port ${err.port} is already in use. Start with another port, for example PORT=9000 npm start (or CAD_PUBLIC_PORT=9001 for the public listener).`);
    else console.error(err.message || err);
    process.exit(1);
  }
  banner(running);
  let stopping = false;
  const stop = (signal) => {
    if (stopping) {
      console.log('Stopping now.');
      process.exit(1);
    }
    stopping = true;
    console.log(`\n${signal}: saving open drawings and stopping…`);
    running.close().then(
      () => process.exit(0),
      (err) => {
        console.error(err);
        process.exit(1);
      },
    );
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
    try {
      process.on(sig, () => stop(sig));
    } catch {
      /* signal not available on this system */
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
