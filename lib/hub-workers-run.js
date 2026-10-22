/**
 * The parent side of the workers runtime: one child process per worker
 * (keyed <user>:<name> or app:<app>:<name>), forked like the Functions runner
 * under Node's permission model. Everything beyond script execution happens
 * here: script reading through the owning app's access rules, limits (§12),
 * email caps (§21), the heartbeat/RSS watchdog (§20), and the /wr/ dispatch
 * (§4/§9) including content-type allow-list + cookie rules (§16).
 */
import { fork, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as db from './db.js';
import * as hubKv from './hub-kv.js';
import * as hubWorkers from './hub-workers.js';
import { rewriteWorkerSource } from './hub-rewrite.js';
import * as fsops from './hub-fsops.js';
import * as mail from './mail.js';
import { DATA_DIR } from './paths.js';
import { HttpError } from './http.js';
import { permissionFlag } from './functions.js';

const RUNNER = path.join(import.meta.dirname, 'worker-runner.js');

// §19: a worker child gets an EXPLICIT allow-listed environment — never the
// parent's whole process.env. Anything secret (SMTP credentials, configured
// API keys, CAD_* knobs) cannot even exist in the child's eyes.
const CHILD_ENV_KEYS = ['PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'ComSpec', 'windir'];

function childEnv() {
  const env = {};
  for (const k of CHILD_ENV_KEYS) {
    if (process.env[k]) env[k] = process.env[k];
  }
  // NODE_OPTIONS could smuggle flags or a preload into the child; an explicit
  // empty value also stops any parent-shell value from applying.
  env.NODE_OPTIONS = '';
  // The allocation cap (layer 2d in the runner) — a bare number is the ONE
  // extra variable the child environment ever carries: the allow-list above
  // blocks everything else, including anything secret-shaped. The runner
  // falls back to its 64 MB default when absent, and ignores non-numeric
  // values, so even a malformed value here cannot widen anything.
  env.CAD_WORKER_ALLOC_CAP = String(Math.round(hubWorkers.cfg('workers.alloc_cap_mb') * 1024 * 1024));
  return env;
}

// §19 hardening: the setup guide has admins copy node.exe to a dedicated
// data\bin\node-worker.exe under an OS outbound-firewall block. When
// CAD_WORKER_NODE names that copy, the pool forks IT — so the firewall rule
// binds exactly the binary that runs worker code.
const WORKER_NODE = (() => {
  const p = process.env.CAD_WORKER_NODE;
  return p && fs.existsSync(p) ? path.resolve(p) : process.execPath;
})();

/**
 * Node version drift: the worker binary is a COPY of the server's node.exe;
 * after a Node upgrade it is silently older, and the worker child then runs
 * a different runtime (different flags, different stdlib) than the server
 * that shells it. Ask the binary which node it is, and warn loudly when the
 * copy drifted — the fix is to recopy (README §1 step 5).
 */
export function workerNodeVersion(bin = WORKER_NODE) {
  if (!bin || bin === process.execPath) return process.version;
  const winScript = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
  const r = winScript
    ? spawnSync(bin, [], { shell: true, timeout: 15_000, encoding: 'utf8' })
    : spawnSync(bin, ['-p', 'process.version'], { timeout: 15_000, encoding: 'utf8' });
  return (r.stdout || '').trim() || null;
}

export function checkWorkerNodeVersion(log = console) {
  const envPath = process.env.CAD_WORKER_NODE;
  if (!envPath) return { drift: false, checked: false };
  // Read the env live (not the module-load const) so the setup check always
  // inspects what is configured NOW, and a test can point it somewhere.
  const bin = fs.existsSync(envPath) ? path.resolve(envPath) : envPath;
  const v = workerNodeVersion(bin);
  if (!v) {
    log.warn(`[cad-workers] CAD_WORKER_NODE is set but "${envPath}" did not answer "node -p process.version" — copy node.exe there (README §1 step 5).`);
    return { drift: true, checked: true, workerVersion: v };
  }
  if (v !== process.version) {
    log.warn(`[cad-workers] CAD_WORKER_NODE is node ${v}, but this server runs node ${process.version} — the worker copy is stale; recopy node.exe to it (README §1 step 5).`);
    return { drift: true, checked: true, workerVersion: v };
  }
  return { drift: false, checked: true, workerVersion: v };
}

const MAX_BODY = 1024 * 1024; // 1 MiB request body (§12)
const IDLE_MS = 5 * 60_000; // §11 warm pool: five quiet minutes → evicted
const QUEUE_MAX = 50; // per worker; beyond → worker_busy (503)
const HEARTBEAT_MS = 2_000; // child heartbeat period (§20)
const HEARTBEAT_GRACE_MS = 8_000; // quiet longer than this with work in flight → kill

const CONTENT_TYPES = new Set([
  'text/html', 'text/plain', 'application/json', 'text/css',
  'text/javascript', 'application/javascript',
  'image/png', 'image/jpeg', 'image/svg+xml', 'image/webp',
  'application/octet-stream', 'application/x-ndjson', 'application/pdf',
]);

const cfg = (k, fallback) => hubWorkers.cfg(k, fallback);
const maxRssBytes = () => (cfg('workers.rss_mb') || 256) * 1048576;
const tempDir = () => path.join(DATA_DIR, 'hub', 'worker-tmp');

/** The KV namespace one worker owns: a hub_kv "app" nobody else shares (§17). */
const workerKvApp = (row) => `worker:${row.name}`;

/* -- script acquisition --------------------------------------------------- */

/**
 * Current script text for one registry row. Virtual scripts are read through
 * the owning app's read rules — never a bypass of access(); a revoked grant
 * makes the worker fail closed (tested).
 */
async function scriptOf(row) {
  if (row.script_kind === 'packaged') {
    const text = await fsp.readFile(hubWorkers.packagedScriptPath(row.app, row.name), 'utf8')
      .catch(() => { throw new HttpError(404, 'script_missing', 'The packaged worker script is gone. Reinstall the app.'); });
    return { text, source: 'packaged' };
  }
  const buf = await fsops.read({ user: row.user, app: row.app, input: row.file_path });
  const source = Buffer.isBuffer(buf) ? buf.toString('utf8') : '';
  const text = rewriteWorkerSource(source, { app: row.app, filePath: row.file_path }).text;
  if (!text.trim()) throw new HttpError(404, 'script_gone', 'The worker script file is unreadable or empty.');
  return { text, source: 'virtual' };
}

/* -- the pool -------------------------------------------------------------- */

const pools = new Map(); // key -> pool record

const poolKey = (row) => (row.user ? `${row.user}:${row.name}` : `app:${row.app}:${row.name}`);

/** Each deploy (distinct sha) stages a NEW module: the runner reloads it. */
function stageFile(row, sha) {
  const stamp = sha.slice(0, 16);
  const safe = `${(row.user ?? `app-${row.app}`).replace(/[^A-Za-z0-9_-]/g, '_')}-${row.name}-${stamp}`.slice(0, 120);
  return path.join(tempDir(), `${safe}.mjs`);
}

function makePool(row) {
  const key = poolKey(row);
  let p = pools.get(key);
  if (!p) {
    p = { key, row, child: null, active: 0, waiting: [], jobs: [], idle: null, beat: null,
      lastUsed: 0, startedAt: 0, bootMs: null, lastBeat: 0, counter: 0 };
    pools.set(key, p);
  }
  return p;
}

function spawn(row) {
  const p = makePool(row);
  const dir = tempDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const execArgv = [
    permissionFlag(),
    `--allow-fs-read=${dir}`,
    `--allow-fs-read=${RUNNER}`,
    `--max-old-space-size=${cfg('workers.memory_mb') || 128}`,
  ];
  const child = fork(RUNNER, [], { cwd: dir, env: childEnv(), execPath: WORKER_NODE, execArgv, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  p.child = child;
  p.startedAt = Date.now();
  // The watchdog measures quiet-from-last-beat; until the first real
  // heartbeat arrives (~2 s), "last beat" is the spawn itself — otherwise
  // any job in flight during boot would look epoch-stale and be killed.
  p.lastBeat = p.startedAt;
  child.on('message', (msg) => handleChildMessage(p, row, msg));
  child.on('exit', () => {
    if (p.child !== child) return; // a newer child owns this slot
    p.child = null;
    const stopped = { status: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'The worker runtime stopped mid-query. Try again.' };
    for (const job of [...p.jobs]) finish(job, stopped, p);
    for (const job of p.waiting) { job.done = true; job.resolve(stopped); }
    p.waiting.length = 0;
    p.active = 0;
    if (p.keep) dispatch(p, row); // a queued job wants a fresh child
  });
  return child;
}

function handleChildMessage(p, row, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'wresult') {
    const job = p.jobs.find((j) => j.id === msg.id);
    if (!job) return;
    if (job.isBoot) p.bootMs = Date.now() - p.startedAt;
    finish(job, msg.error
      ? { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: String(msg.error) }
      : trimResponse(msg.result), p);
    return;
  }
  if (msg.type === 'log') {
    hubWorkers.logRow(row.user, row.app, 'log', row.name, null, msg.text);
    return;
  }
  if (msg.type === 'me') {
    handleMe(p, row, msg)
      .then((result) => { try { p.child?.send({ type: 'me-reply', id: msg.id, result }); } catch { /* gone */ } })
      .catch((err) => {
        try { p.child?.send({ type: 'me-reply', id: msg.id, error: String(err?.message || err).slice(0, 300) }); } catch { /* gone */ }
      });
    return;
  }
  if (msg.type === 'heartbeat') {
    p.lastBeat = Date.now();
    p.lastRss = msg.rss || 0;
    // §20 RSS watchdog: the child reports process.memoryUsage().rss.
    if (msg.rss && msg.rss > maxRssBytes()) {
      hubWorkers.logRow(row.user, row.app, 'resource-limit', row.name, null, `rss ${(msg.rss / 1048576) | 0} MB over cap`);
      killPool(p, { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ code: 'worker_resource_limit', message: 'The worker was stopped: it used more memory than the cap allows.' }) }, row);
    }
    return;
  }
}

function trimResponse(result) {
  const cap = (cfg('workers.max_response_mb') || 8) * 1048576;
  if (result && typeof result.body === 'string' && Buffer.byteLength(result.body, 'utf8') > cap) {
    return { status: 413, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'This worker response is over the 8 MB cap.' };
  }
  return result;
}

/* -- me.* — the owner SDK over IPC (§17) ------------------------------------ */

const emailCounters = new Map();
const DAY_MS = 86_400_000;
const WINDOW_MS = 10 * 60_000;

async function handleMe(p, row, msg) {
  const { op, args = {} } = msg;
  if (op === 'kv') {
    const user = row.user ?? `app-owner:${row.app}`;
    const app = workerKvApp(row);
    const [one, two] = args.args || [];
    switch (args.op) {
      case 'get':
        if (Array.isArray(one)) {
          const out = [];
          for (const k of one) out.push(((await hubKv.get({ user, app, key: String(k) })) ?? null));
          return out;
        }
        return (await hubKv.get({ user, app, key: String(one ?? '') })) ?? null;
      case 'set': {
        // Batch form: kv.set([{key, value}...]) (rsvp sync uses it).
        const items = Array.isArray(one)
          ? one.map((it) => ({ key: String(it?.key ?? ''), value: it?.value == null ? null : it?.value }))
          : [{ key: String(one ?? ''), value: two == null ? null : two }];
        let add = 0;
        for (const it of items) {
          const text = JSON.stringify(it.value ?? null);
          if (Buffer.byteLength(text) > hubKv.MAX_VALUE_SIZE) {
            throw new Error(`A value is over the ${hubKv.MAX_VALUE_SIZE / 1024 | 0} KiB per-key cap.`);
          }
          add += Buffer.byteLength(`${it.key}${text}`);
        }
        if (kvBytes(user, app) + add > kvCap()) {
          throw new Error('This worker has used up its key-value space (2 MB). Delete some keys first.');
        }
        for (const it of items) hubKv.set({ user, app, key: it.key, value: it.value });
        return true;
      }
      case 'del':
        for (const k of [].concat(one ?? [])) hubKv.del({ user, app, key: String(k) });
        return true;
      case 'list': {
        const entries = hubKv.list({ user, app, options: { pattern: String(args.args?.[0] || '*'), as: 'entries' } });
        return two === true ? entries : entries.map((e) => e.key);
      }
      case 'incr': return hubKv.incr({ user, app, key: String(one ?? ''), value: Number.isFinite(Number(two)) ? Number(two) : 1 });
      case 'expire':
        hubKv.expire({ user, app, key: String(one ?? ''), ttlSeconds: Number(two) || 0 });
        return true;
      default: throw new Error(`Unknown worker kv operation "${args.op}".`);
    }
  }
  if (op === 'fs') {
    if (!row.user) throw new Error('Packaged workers run without Drive access (design §10).');
    const input = String(args.args?.[0] ?? '');
    const need = args.op === 'write' ? 'write' : 'read';
    // access() authorizes AND resolves: the owner's grants apply, consent
    // overlays fire, and a revoked grant fails the call (§13/§17).
    switch (args.op) {
      case 'read': {
        const buf = await fsops.read({ user: row.user, app: row.app, input });
        return Buffer.isBuffer(buf) ? buf.toString('base64') : String(buf ?? '');
      }
      case 'write':
        await fsops.write({ user: row.user, app: row.app, input, data: args.args?.[1], options: { overwrite: args.args?.[2]?.overwrite ?? true } });
        return true;
      case 'mkdir':
        await fsops.mkdir({ user: row.user, app: row.app, input });
        return true;
      case 'delete':
        await fsops.del({ user: row.user, app: row.app, input });
        return true;
      default: throw new Error(`Unknown worker fs operation "${args.op}".`);
    }
  }
  if (op === 'email') return sendWorkerEmail(row, args.args || {});
  void p;
  throw new Error(`Unsupported me operation "${op}".`);
}

function kvCap() { return (cfg('limits.workers_kv_mb') ?? 2) * 1048576; }
function kvBytes(user, app) {
  const r = db.get('SELECT COALESCE(SUM(LENGTH(key) + LENGTH(value)), 0) AS n FROM hub_kv WHERE user = ? AND app = ?', user, app);
  return r?.n ?? 0;
}

/**
 * Worker email: send-only (§14), rate-capped (§21), From forced to the
 * server's configured address — a worker never sends as someone else.
 */
async function sendWorkerEmail(row, obj) {
  const recipients = [].concat(obj.to ?? []).flat(4).map(String).slice(0, cfg('workers.email_recipients_max') ?? 10);
  if (!recipients.length) throw new Error('Worker email needs at least one recipient.');
  const now = Date.now();
  const perWindow = cfg('workers.email_per_worker_10min') ?? 50;
  const perDay = cfg('workers.email_per_user_day') ?? 200;
  const wk = `${row.user ?? row.app}:${row.name}`;
  const uk = `user:${row.user ?? row.app}`;
  const w = emailCounters.get(wk) || { t0: now, n: 0 };
  const u = emailCounters.get(uk) || { day: Math.floor(now / DAY_MS), n: 0 };
  if (now - w.t0 > WINDOW_MS) { w.t0 = now; w.n = 0; }
  const uDay = Math.floor(now / DAY_MS);
  if (u.day !== uDay) { u.day = uDay; u.n = 0; }
  if (w.n + 1 > perWindow) throw new Error(`Email from this worker is limited to ${perWindow} per 10 minutes.`);
  if (u.n + recipients.length > perDay) throw new Error(`Email for this owner is limited to ${perDay} per day.`);
  w.n += recipients.length;
  u.n += recipients.length;
  emailCounters.set(wk, w);
  emailCounters.set(uk, u);

  const label = row.user ? `worker ${row.name}` : `app ${row.app}`;
  const info = await mail.send({
    to: recipients,
    subject: `[${label}] ${String(obj.subject ?? '').slice(0, 400)}`,
    text: String(obj.text ?? ''),
    html: obj.html ? String(obj.html).slice(0, 512_000) : undefined,
    user: row.user,
    source: `worker:${row.name}`,
  });
  return { ok: true, messageId: info?.messageId ?? null };
}

/* -- dispatch ----------------------------------------------------------------- */

function dispatch(p, row) {
  const concurrency = Math.max(1, Math.min(4, Number(cfg('workers.concurrency')) || 1));
  while (p.child && p.active < concurrency && p.waiting.length) {
    const job = p.waiting.shift();
    const canSend = p.child.connected || p.child.channel;
    if (!canSend) {
      finish(job, { status: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'The worker runtime stopped.' }, p);
      continue;
    }
    p.jobs.push(job);
    p.active += 1;
    job.timer = setTimeout(() => {
      if (job.done) return;
      hubWorkers.logRow(row.user, row.app, 'timeout', row.name, null, job.request.path);
      killPool(p, {
        status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ code: 'shim_timeout', message: `The worker did not finish in ${(cfg('workers.timeout_ms') ?? 30_000) / 1000} s.` }),
      }, row);
    }, Math.max(1000, Number(cfg('workers.timeout_ms')) || 30_000));
    job.timer.unref?.();
    try {
      p.child.send({ type: 'wcall', id: job.id, file: job.file, me: job.me, callerUser: job.user, request: job.request });
    } catch {
      p.jobs.splice(p.jobs.indexOf(job), 1);
      p.active -= 1;
      job.done = true;
      job.resolve({ status: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'The worker runtime stopped.' });
    }
  }
}

function finish(job, result, p) {
  if (job.done) return;
  job.done = true;
  clearTimeout(job.timer);
  const i = p.jobs.indexOf(job);
  if (i >= 0) p.jobs.splice(i, 1);
  if (p.active > 0) p.active -= 1;
  job.resolve(result);
  p.lastUsed = Date.now();
  scheduleEviction(p);
}

/** §11: idle eviction after five quiet minutes. */
function scheduleEviction(p) {
  clearTimeout(p.idle);
  p.idle = setTimeout(() => {
    if (p.active || p.jobs.length || p.waiting.length) return scheduleEviction(p);
    killPool(p, null, p.row);
  }, IDLE_MS);
  p.idle.unref?.();
}

function killPool(p, failure, row) {
  clearTimeout(p.idle);
  if (p.child) {
    p.child.removeAllListeners('exit');
    try { p.child.kill('SIGKILL'); } catch { /* gone */ }
    p.child = null;
  }
  const fail = failure ?? { status: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'The worker runtime stopped.' };
  for (const job of [...p.jobs]) { job.done = true; job.resolve(fail); }
  for (const job of p.waiting) { job.done = true; job.resolve(fail); }
  p.jobs.length = 0;
  p.waiting.length = 0;
  p.active = 0;
  pools.delete(poolKey(row ?? p.row));
}

/* -- heartbeat watchdog (§20) -------------------------------------------------- */

function heartbeatWatchdog(p, row) {
  clearTimeout(p.beat);
  p.beat = setTimeout(() => {
    if (!p.child) return;
    const quiet = Date.now() - p.lastBeat;
    // A synchronous infinite loop stops the heartbeats while work is in
    // flight — kill after the grace window. Quiet idle time (no jobs) is fine.
    if (quiet > HEARTBEAT_GRACE_MS && (p.jobs.length || p.waiting.length)) {
      hubWorkers.logRow(row.user, row.app, 'stall', row.name, null, `no heartbeat for ${quiet} ms (jobs ${p.jobs.length}, waiting ${p.waiting.length})`);
      killPool(p, {
        status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ code: 'shim_timeout', message: 'The worker stopped responding.' }),
      }, row);
      return;
    }
    heartbeatWatchdog(p, row);
  }, HEARTBEAT_MS);
  p.beat.unref?.();
}

/* -- the invocation path -------------------------------------------------------- */

/** §20 pool budget: workers.pool_rss_budget_mb (default 512) caps the pooled
 * children's total RSS. A fresh boot is estimated at
 * workers.boot_rss_estimate_mb (default 64, conservative for our measured
 * ~50 MB steady). If the budget would overflow, idle pools (nothing in
 * flight, nothing queued) are killed LRU-first until it fits; returns false
 * when nothing can evict — the caller refuses the invocation. */
function withinPoolBudget(row) {
  const budget = (cfg('workers.pool_rss_budget_mb') ?? 512) * 1048576;
  const estimate = (cfg('workers.boot_rss_estimate_mb') ?? 64) * 1048576;
  const mine = poolKey(row);
  // The target's own record (if makePool already stubbed it) has no child and
  // no measured RSS — counting it as `estimate` would double-count its own
  // boot, so only OTHER children count here.
  const total = () => [...pools.values()]
    .filter((x) => poolKey(x.row) !== mine)
    .reduce((n, x) => n + (x.lastRss || estimate), 0);
  if (total() + estimate <= budget) return true;
  const evictable = () => [...pools.values()]
    .filter((x) => x.child && !x.jobs.length && !x.waiting.length)
    .sort((a, b) => a.lastUsed - b.lastUsed);
  while (total() + estimate > budget && evictable().length) {
    const victim = evictable()[0];
    hubWorkers.logRow(victim.row.user ?? victim.row.app, victim.row.user ? victim.row.app : null, 'pool-evict', victim.row.name, null, 'LRU idle worker evicted for the pool RSS budget');
    killPool(victim, { status: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: '' }, victim.row);
  }
  return total() + estimate <= budget;
}

/**
 * Dispatch one HTTP request to a worker. `who` = { user: callerUser|null,
 * viaExec, ip, publicGuest } — the HTTP route owns the auth matrix; this is
 * runtime-only: no cookies cross this boundary (§16).
 */
export async function invoke(row, request, { user = null, ip = '', viaExec = false, publicGuest = false }) {
  const { text } = await scriptOf(row);
  const sha = hubWorkers.hashOf(text);
  if (row.sha !== sha) hubWorkers.recordDeploy(row, sha, row.sha ? 'redeploy' : 'deploy');

  // content-type allow-list check happens on the RESPONSE (below); the
  // request cookie rule (§16) is enforced while building the child request.
  const headers = {};
  for (const [k, v] of Object.entries(request.headers ?? {})) {
    const key = String(k).toLowerCase();
    if (key === 'cookie' || key === 'set-cookie') continue;
    headers[key] = String(v);
  }
  const body = typeof request.body === 'string' ? request.body : (request.body ? String(request.body) : '');
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY) {
    throw new HttpError(413, 'body_too_large', 'The request body is over 1 MB.');
  }

  const p = makePool(row);
  if (!p.child) {
    // §20 pool-budget: if a fresh boot would push the pooled children past
    // workers.pool_rss_budget_mb, evict LRU idle workers first; refuse with
    // the named `worker_busy` error only when nothing can evict.
    if (!withinPoolBudget(row)) {
      hubWorkers.logRow(row.user ?? row.app, row.app ?? null, 'pool-full', row.name, null, 'rss budget reached, nothing evictable');
      pools.delete(poolKey(row)); // don't leave the refusal's empty stub pooled
      throw new HttpError(503, 'worker_busy', 'The memory budget for running workers is full right now. Try again in a moment.');
    }
    spawn(row);
    heartbeatWatchdog(p, row);
  }
  if (p.waiting.length >= QUEUE_MAX) {
    throw new HttpError(503, 'worker_busy', 'This worker is at its queue limit. Try again in a moment.');
  }

  const file = stageFile(row, sha);
  await fsp.writeFile(file, text, { encoding: 'utf8', mode: 0o600 });

  const job = {
    id: `w${p.counter++}`,
    file,
    me: { kind: row.script_kind, app: row.app, user: row.user, name: row.name, publicGuest: !!publicGuest },
    user: (viaExec && user) || null, // ctx.user only via exec (§2/§17)
    // The child builds absolute URLs (RSVP-style redirect targets name the
    // WORKER's own origin) — pass the real scheme+host through when known.
    request: {
      method: request.method,
      path: request.path,
      absoluteUrl: request.absoluteUrl || '',
      workerBase: request.workerBase || '',
      headers,
      body,
      origin: request.origin || '',
    },
    isBoot: !p.bootMs,
    done: false,
    timer: null,
    resolve: null,
  };
  p.waiting.push(job);
  p.lastUsed = Date.now();
  dispatch(p, row);
  const out = await new Promise((resolve) => { job.resolve = resolve; });
  // §16: content-type allow-list on the response — the bare media type must
  // be in the list (parameters like charset are allowed).
  const ctRaw = String(out?.headers?.['Content-Type'] ?? out?.headers?.['content-type'] ?? 'application/octet-stream');
  const base = ctRaw.split(';')[0].trim().toLowerCase();
  if (!CONTENT_TYPES.has(base)) {
    hubWorkers.logRow(row.user, row.app, 'bad-content-type', row.name, null, ctRaw.slice(0, 100));
    return { status: 415, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'This worker returned a disallowed content type.' };
  }
  return out;
}

/** Import-time safety: the config defaults registered once at boot. */
hubWorkers.registerConfigDefaults();

/** Read-only pool telemetry (§19 measurements + later admin dashboards):
 * per worker pool: cold-boot cost, current RSS, queue depth, age. */
export function workerStats() {
  return [...pools.values()].map((p) => ({
    key: poolKey(p.row),
    user: p.row.user || null,
    app: p.row.app,
    name: p.row.name,
    bootMs: p.bootMs,
    rssBytes: p.lastRss || 0,
    lastBeatAgoMs: p.lastBeat ? Date.now() - p.lastBeat : null,
    ageMs: p.startedAt ? Date.now() - p.startedAt : 0,
    busy: p.jobs.length,
    queued: p.waiting.length,
  }));
}

/** Shutdown: every pooled child dies with the server (running.close()). */
export function closeAllPools() {
  for (const p of [...pools.values()]) killPool(p, { status: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'The server is shutting down.' }, p.row);
}
