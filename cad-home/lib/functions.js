/**
 * Serverless functions. Each deployed app may carry functions/<name>.js modules
 * exporting `default async (request, ctx) => response`. They run in one child
 * process per app (lib/fn-runner.js) under Node's permission model: the code
 * cannot write files, spawn processes or open workers, and it only reads its
 * own app folder. Everything else (key-value, AI, email, env) is proxied over
 * IPC, and console.* is stored in function_logs.
 *
 * Endpoints: /fn/<app>/<name> on the private listener (a scoped bearer token,
 * or the CAD session cookie plus the X-CAD-Request header) and on the public
 * listener for public apps, where the bearer token is optional so machines can
 * call webhooks.
 *
 * Stated plainly in Admin → Apps, and worth repeating here: Node's permission
 * model restricts files and processes, NOT the network. A function can reach
 * the internet and your LAN. Only grant "can host apps" to people you trust.
 */
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as db from './db.js';
import * as store from './store.js';
import * as config from './config.js';
import * as apps from './apps.js';
import * as ai from './ai.js';
import * as mail from './mail.js';
import { APPS_DIR } from './paths.js';
import { HttpError, send, readBody, rateLimit, clientIp, sendNotFound } from './http.js';

const RUNNER = path.join(import.meta.dirname, 'fn-runner.js');
const FN_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BODY = 1024 * 1024; // 1 MB per call
const MAX_CONCURRENT = 4; // calls running at once per app
const MAX_QUEUE = 50; // queued calls, then 503
const IDLE_MS = 5 * 60_000; // idle runners are stopped after 5 minutes
const MAX_KV_TOTAL = store.MAX_KV_VALUE * 8; // 2 MB per key-value namespace

export const fnDir = (app) => path.join(APPS_DIR, app, 'functions');

export function fnFile(app, name) {
  if (!FN_NAME.test(String(name || ''))) return null;
  return path.join(fnDir(app), `${name}.js`);
}

export function hasFn(app, name) {
  const file = fnFile(app, name);
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

/** The runner flags: Node's permission model, with the older 22.x name as a fallback. */
export const permissionFlag = () =>
  process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : process.allowedNodeEnvironmentFlags.has('--experimental-permission') ? '--experimental-permission' : '--permission';

function logRow(app, fn, level, message) {
  try {
    db.run('INSERT INTO function_logs(at, app, fn, level, message) VALUES (?, ?, ?, ?, ?)', Date.now(), app, fn || '', level || 'log', String(message ?? '').slice(0, 512));
  } catch {
    /* logging must never break the server */
  }
}

// The runner pool --------------------------------------------------------------------------------

const pools = new Map(); // app name → { app, child, active, waiting, idle }
const jobs = new Map(); // job id → { app, name, timeout timer, ... }
let nextJobId = 1;

function spawn(p) {
  fs.mkdirSync(fnDir(p.app), { recursive: true, mode: 0o700 });
  const execArgv = [permissionFlag(), `--allow-fs-read=${fnDir(p.app)}`, `--allow-fs-read=${RUNNER}`, '--max-old-space-size=128'];
  const child = fork(RUNNER, [], { cwd: fnDir(p.app), execArgv, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  p.child = child;
  child.on('message', (msg) => handleChildMessage(p, child, msg));
  child.on('error', () => {
    /* spawn failures surface through 'exit'; nothing else to do */
  });
  child.on('exit', () => {
    if (p.child !== child) return;
    p.child = null;
    // Calls that were running are gone; queued calls continue with a fresh runner.
    for (const job of [...jobs.values()].filter((j) => j.pool === p && !j.done)) {
      finish(job, { status: 500, body: { code: 'runner_stopped', message: 'The function runner stopped. Try again.' } });
    }
    if (p.waiting.length) spawn(p);
    dispatch(p);
  });
}

function handleChildMessage(p, child, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'result') {
    const job = jobs.get(msg.id);
    if (job) finish(job, msg.error ? { status: 500, body: { code: 'function_error', message: msg.error } } : msg.result);
    return;
  }
  if (msg.type === 'log') {
    logRow(p.app, msg.fn, msg.level, msg.text);
    return;
  }
  if (msg.type === 'ctx') {
    handleCtx(p, msg)
      .then((result) => child.send({ type: 'ctx-reply', id: msg.id, result }))
      .catch((err) => {
        try {
          child.send({ type: 'ctx-reply', id: msg.id, error: String(err?.message || err).slice(0, 300) });
        } catch {
          /* the runner is gone */
        }
      });
  }
}

function finish(job, result) {
  if (job.done) return;
  job.done = true;
  clearTimeout(job.timer);
  jobs.delete(job.id);
  job.pool.active--;
  job.resolve(result);
  dispatch(job.pool);
}

/** Start queued calls while there is capacity (4 running, others wait). */
function dispatch(p) {
  while (p.child && p.active < MAX_CONCURRENT && p.waiting.length) {
    const job = p.waiting.shift();
    start(p, job);
  }
}

function start(p, job) {
  p.active++;
  clearTimeout(p.idle);
  p.idle = setTimeout(() => stop(p), IDLE_MS);
  p.idle.unref?.();
  const timeout = Math.max(1000, Number(config.get('functions.timeout_ms')) || 30000); // 30 s by default
  job.timer = setTimeout(() => {
    // A hung module holds the runner's event loop open, and Node cannot cancel
    // one function: kill the whole process. The next call starts a fresh one.
    if (!p.child) return;
    p.child.removeAllListeners('exit');
    try {
      p.child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    p.child = null;
    for (const other of [...jobs.values()].filter((j) => j.pool === p && !j.done)) {
      finish(other, { status: 500, body: { code: 'timed_out', message: `The function did not finish in ${timeout / 1000} s, so the server stopped it.` } });
    }
    if (p.waiting.length) spawn(p);
    dispatch(p);
  }, timeout);
  job.timer.unref?.();
  try {
    p.child.send({ type: 'call', id: job.id, app: p.app, name: job.name, file: job.file, user: job.user, env: job.env, ip: job.ip, request: job.request });
  } catch {
    finish(job, { status: 500, body: { code: 'runner_stopped', message: 'The function runner stopped.' } });
  }
}

function stop(p) {
  if (!p) return;
  clearTimeout(p.idle);
  if (p.child) {
    p.child.removeAllListeners('exit');
    try {
      p.child.kill();
    } catch {
      /* already gone */
    }
    p.child = null;
  }
}

/** Free the runner when an app is removed. */
export function dispose(appName) {
  const p = pools.get(appName);
  if (!p) return;
  stop(p);
  for (const job of [...jobs.values()].filter((j) => j.pool === p && !j.done)) {
    finish(job, { status: 500, body: { code: 'runner_stopped', message: 'The app was removed.' } });
  }
  pools.delete(appName);
}

export function stopAll() {
  for (const app of pools.keys()) dispose(app);
}

/**
 * One call: enqueue, wait for the runner's answer over IPC. Throw (503) once
 * the queue is full. user is null for anonymous webhook calls.
 */
export async function call(appName, name, { user = null, kind = 'anon', ip = '', request = {} }) {
  const file = hasFn(appName, name);
  if (!file) throw new HttpError(404, 'not_found', `There is no function "${name}" in ${appName}.`);

  let p = pools.get(appName);
  if (!p) {
    p = { app: appName, child: null, active: 0, waiting: [], idle: null };
    pools.set(appName, p);
  }
  if (!p.child) spawn(p);
  if (p.waiting.length >= MAX_QUEUE) {
    throw new HttpError(503, 'queue_full', `${appName} already has ${MAX_QUEUE} calls waiting. Try again in a moment.`);
  }
  const job = {
    id: `j${nextJobId++}`,
    pool: p,
    app: appName,
    name,
    file,
    user,
    kind,
    ip,
    request,
    env: envFor(appName),
    done: false,
    timer: null,
    resolve: null,
  };
  jobs.set(job.id, job);
  p.waiting.push(job);
  dispatch(p);
  return new Promise((resolve) => (job.resolve = resolve));
}

export function envFor(appName) {
  return Object.fromEntries(db.all('SELECT key, value FROM app_env WHERE app = ?', appName).map((r) => [r.key, r.value]));
}

// ctx (runs in the server; the runner only ever sees the answer) ----------------------------------

function kvNamespace(op, appName, user) {
  return op === 'ukv' ? `app:${appName}:user:${user}` : `app:${appName}:shared`;
}

function checkKvKey(key) {
  if (typeof key !== 'string' || !key.length || key.length > store.MAX_KV_KEY) throw new HttpError(400, 'bad_key', 'KV keys are 1 to 256 characters.');
  return key;
}

async function handleCtx(p, msg) {
  const app = apps.get(p.app);
  if (!app) throw new Error('The app no longer exists.');
  const { op, args = {} } = msg;

  if (op === 'kv' || op === 'ukv') {
    if (op === 'ukv' && !msg.user) throw new Error('Public visitors have no key-value storage. Sign in to use your own space.');
    const ns = kvNamespace(op, p.app, msg.user);
    const [one, two] = args.args || [];
    switch (args.fn) {
      case 'get':
        return store.kvGet(ns, checkKvKey(one)) ?? null;
      case 'set': {
        const key = checkKvKey(one);
        const before = store.kvGet(ns, key);
        const freed = before == null ? 0 : key.length + JSON.stringify(before).length;
        const added = two == null ? 0 : key.length + JSON.stringify(two).length;
        if (store.kvSize(ns) - freed + added > MAX_KV_TOTAL) throw new Error('This app has used up its key-value space (2 MB). Delete some keys first.');
        store.kvSet(ns, key, two ?? null);
        return true;
      }
      case 'del':
        return store.kvDel(ns, checkKvKey(one));
      case 'remove':
        return store.kvDel(ns, checkKvKey(one));
      case 'list':
        return store.kvList(ns, '*');
      case 'incr': {
        const key = checkKvKey(one);
        if (store.kvGet(ns, key) == null && store.kvSize(ns) + key.length + 4 > MAX_KV_TOTAL) throw new Error('This app has used up its key-value space (2 MB). Delete some keys first.');
        return store.kvIncr(ns, key, Number.isFinite(Number(two)) ? Number(two) : 1);
      }
      default:
        throw new Error(`Unknown key-value operation "${args.fn}".`);
    }
  }

  if (op === 'ai') {
    return aiChat(app, p, msg);
  }

  if (op === 'email') {
    return handleEmail(app, p, msg);
  }

  throw new Error(`Unsupported ctx operation "${op}".`);
}

/**
 * ctx.ai.chat({model, messages, tools?, temperature?, maxTokens?}) →
 * { text, toolCalls, usage }, logged like any other AI call with source
 * fn:<app>/<name>. Anonymous callers (webhooks on public apps) follow the same
 * public rules as the SDK: only when the admin turned public AI on, and rate
 * limited per IP.
 */
async function aiChat(app, p, msg) {
  const { options = {}, user = null, ip = '' } = msg.args || {};
  if (!user) {
    if (app.publicAi) {
      const limit = Number(config.get('limits.public_ai_per_hour'));
      if (!rateLimit(`appai:${app.name}:${ip}`, limit, 3600_000)) {
        throw new Error(`This app allows ${limit} AI calls per hour per person, and it is busy. Try again later.`);
      }
    } else {
      throw new Error('This app cannot use AI. The server admin can allow it in Admin → Apps.');
    }
  }
  const source = `fn:${app.name}/${msg.fnName}`;
  return await ai.chat({
    user,
    source,
    model: options.model,
    messages: options.messages,
    tools: options.tools,
    temperature: options.temperature,
    maxTokens: options.maxTokens ?? options.max_tokens,
  });
}

/** ctx.email.send — the same rules as the SDK's email.send, with source fn:<app>/<name>. */
async function handleEmail(app, p, msg) {
  const { to, subject, text, html, user = null, ip = '' } = msg.args || {};
  if (user) {
    const grant = db.get("SELECT id FROM app_grants WHERE app = ? AND user = ? AND mode = 'email'", app.name, user);
    if (!grant) throw new Error(`${app.title || app.name} may not send email for ${user} yet; allow it in the launcher dialog first.`);
    await mail.send({ to, subject, text, html, user, source: `fn:${app.name}/${msg.fnName}` });
    return true;
  }
  if (!app.publicEmail) throw new Error('This app cannot send email. The server admin can allow it in Admin → Apps.');
  const owner = store.getAccount(app.owner);
  const ownerAddr = String(owner?.email || '').trim();
  if (!ownerAddr || !store.validEmail(ownerAddr)) throw new Error('The app owner has no email address, so this app cannot send email.');
  const targets = (Array.isArray(to) ? to.map(String) : [String(to ?? '')]).map((a) => a.trim()).filter(Boolean);
  if (targets.length !== 1 || targets[0].toLowerCase() !== ownerAddr.toLowerCase()) {
    throw new Error('Public apps can only send email to the app owner.');
  }
  const limit = Number(config.get('limits.public_email_per_hour'));
  if (!rateLimit(`appmail:${app.name}:${ip}`, limit, 3600_000)) throw new Error(`This app allows ${limit} emails per hour per person. Try again later.`);
  await mail.send({ to: ownerAddr, subject, text, html, user: owner?.name ?? null, source: `fn:${app.name}/${msg.fnName}` });
  return true;
}

// /fn/<app>/<name> on both listeners -------------------------------------------------------------

function bearer(req) {
  return /^Bearer (\S{10,200})$/.exec(String(req.headers.authorization || ''))?.[1] ?? null;
}

function resolveUser(s, req, kind, app) {
  if (bearer(req)) {
    const session = apps.appToken(req, app.name); // 401 when the token is invalid or for another app
    return { user: session.kind === 'app' ? session.user : null, kind: session.kind === 'app' ? 'user' : 'visitor' };
  }
  if (kind === 'public') return { user: null, kind: 'anon' }; // webhooks on the public listener: no token needed
  const user = store.sessionUser(s.sessionToken(req));
  if (!user || req.headers['x-cad-request'] !== '1') {
    throw new HttpError(401, 'not_signed_in', 'Function calls need a token from the launcher, or your CAD session with the X-CAD-Request header.');
  }
  return { user, kind: 'user' };
}

function fnMount(kind, s) {
  return async (req, res, url) => {
    // The answers belong to the sandboxed app page, an opaque cross-origin
    // caller, so every response carries CORS headers.
    const writeHead = res.writeHead.bind(res);
    res.writeHead = (code, headers) => writeHead(code, { 'Access-Control-Allow-Origin': '*', ...headers });
    if (req.method === 'OPTIONS') {
      return send(res, 204, '', {
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '86400',
      });
    }

    const parts = url.pathname.slice('/fn/'.length).split('/');
    const [appName, fnName, ...extra] = parts;
    const valid = !extra.length && FN_NAME.test(fnName) && FN_NAME.test(appName);
    let app = null;
    if (valid) {
      app = apps.get(appName);
      if (app && (kind === 'private' || app.visibility === 'public')) {
        // Auth first: an invalid token is a 401 even if the function exists.
        const { user, kind: sessionKind } = resolveUser(s, req, kind, app);
        const file = hasFn(appName, fnName);
        if (!file) return sendNotFound(res, 'No such function.');
        let body = '';
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          body = (await readBody(req, MAX_BODY)).toString('utf8');
        }
        const headers = { ...req.headers };
        delete headers.cookie;
        delete headers.authorization;
        const query = Object.fromEntries(url.searchParams);
        const out = await call(appName, fnName, {
          user,
          kind: sessionKind,
          ip: clientIp(req),
          request: { method: req.method, path: url.pathname, query, headers, body },
        });
        return send(res, out.status ?? 200, out.body ?? '', out.headers || {});
      }
    }
    sendNotFound(res, 'No such function.');
  };
}

// register ---------------------------------------------------------------------------------------
/** s is the server registry: { privateMounts, publicMounts, sessionToken, onShutdown }. */
export function register(s) {
  s.privateMounts.push(['/fn/', fnMount('private', s)]);
  s.publicMounts.push(['/fn/', fnMount('public', s)]);
  s.onShutdown(stopAll);
}
