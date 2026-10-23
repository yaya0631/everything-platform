/**
 * The inside of the workers runtime (lib/hub-workers-run.js forks one per
 * worker, keyed <owner>:<name>). The worker script itself is NOT a default
 * export: it is a top-level program that registers handlers on a `router`
 * global (worker-harness.js is the spec), so the preamble below injects:
 *
 *   router          — 'the route collector' (`router.get|post|put|delete|options`)
 *   __cadRoutes     — the routes it collected, for the runtime to dispatch
 *   me              — the OWNER context: me.puter.{kv,fs,email} over IPC
 *   crypto / Response — Node 24 globals (webcrypto + WHATWG Response)
 *
 * Network is closed in three layers (design §12), each with a named error:
 *   1. module.registerHooks denies net/child_process builtins (this file's
 *      first statements, before any user code is imported);
 *   2. the preamble deletes `fetch`, `WebSocket`, `XMLHttpRequest`;
 *   3. this process's ONLY channel is process.send IPC — the parent does the
 *      real work and enforces access/audit.
 * Node's --permission (--allow-fs-read is scoped to this directory by the
 * parent) blocks filesystem, child_process, addons and worker threads.
 */
import { registerHooks } from 'node:module';

// -- layer 1: the module gate (must run before any worker code) --------------

const NET_DENIED = [
  'node:net', 'node:http', 'node:https', 'node:tls', 'node:dgram', 'node:dns',
  'node:http2', 'node:cluster', 'node:child_process', 'node:worker_threads',
  'node:inspector', 'node:module', 'node:process',
  'net', 'http', 'https', 'tls', 'dgram', 'dns', 'http2',
  'cluster', 'child_process', 'worker_threads', 'inspector',
];
registerHooks({
  resolve(specifier, context, nextResolve) {
    const spec = String(specifier || '').toLowerCase();
    if (NET_DENIED.includes(spec)) {
      throw new Error(`net_disabled: workers cannot reach the network (import "${specifier}" denied).`);
    }
    return nextResolve(specifier, context);
  },
});

// -- layer 2: outbound globals gone ------------------------------------------

for (const g of ['fetch', 'WebSocket', 'XMLHttpRequest']) {
  try { delete globalThis[g]; } catch { /* frozen realms shouldn't happen */ }
  const forced = Object.getOwnPropertyDescriptor(globalThis, g);
  if (!forced && globalThis[g]) {
    try { globalThis[g] = undefined; } catch { /* ignore */ }
  }
}

// -- layer 2b: the doors that bypass the resolve hook (§12, best-effort) ------
// process.getBuiltinModule() hands out builtins with NO resolver involvement,
// process.binding() would hand out raw internal handles, and process.mainModule
// is the dead CJS bridge someone could still probe. None of these have any
// legitimate use inside a worker script, so the worker realm simply loses them.
for (const door of ['getBuiltinModule', 'binding', 'mainModule']) {
  try { delete process[door]; } catch { /* ignore */ }
  if (process[door] !== undefined) {
    try { process[door] = undefined; } catch { /* ignore */ }
  }
}

// -- layer 2c: the undici global dispatcher (§12, measured on Node 24.21) ------
// Deep-touching the undici classes boots the bundled undici, which installs
// `Symbol.for('undici.globalDispatcher.*')` on globalThis — and its
// dispatcher.request({origin, path}) opens real sockets with fetch deleted
// and --permission on (reproduced: a worker reached a live loopback listener
// this way). So the preamble boots undici FIRST (touch Response, Request,
// Headers, FormData and consume a body), then locks every undici-flavoured
// symbol to a frozen `undefined` before any worker module is imported.
try { await new Response('undici-boot').text(); } catch { /* ignore */ }
try { await new Request('http://undici-boot.invalid/x').arrayBuffer(); } catch { /* ignore */ }
for (const boot of [Headers, FormData, Request, Response]) {
  try { void new boot(); } catch { /* ignore */ }
}
for (const sym of Object.getOwnPropertySymbols(globalThis)) {
  if (!String(sym).includes('undici')) continue;
  try {
    Object.defineProperty(globalThis, sym, { value: undefined, writable: false, configurable: false });
  } catch { /* already non-configurable: fine */ }
}

// -- the preamble the worker program runs inside ------------------------------

import { format } from 'node:util';
import { pathToFileURL } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
// The pure contract pieces live in worker-contract.js so the runtime test seam
// can frame calls exactly like this child does.
import { Router as ContractRouter, matchRoute as matchRouteContract, serializeWorkerResponse } from './worker-contract.js';

const post = process.send?.bind(process) ?? (() => {});
const emit = (msg) => {
  try { post(msg); } catch { /* parent gone; the process is ending anyway */ }
};

// §20: the heartbeat the parent's watchdog reads — every 2 s with RSS. A
// synchronous infinite loop stops this beat while a job is in flight, and
// the parent kills the worker after the grace window.
const beatTimer = setInterval(() => {
  emit({ type: 'heartbeat', rss: process.memoryUsage().rss });
}, 2000);
if (beatTimer.unref) beatTimer.unref();

const logs = new AsyncLocalStorage();
for (const level of ['log', 'info', 'warn', 'error']) {
  console[level] = (...args) => {
    const text = format(...args);
    emit({ type: 'log', level, text: text.length > 512 ? text.slice(0, 512) : text });
  };
}

// -- layer 2d: an allocation size cap (best-effort, in-process) ----------------
// A single `Buffer.alloc(400 * 1024 * 1024, 1)` used to sail through: the §20
// RSS watchdog acts only while the parent sees work in flight, and one fast
// allocation never triggers it. This layer checks the REQUESTED byte count
// BEFORE the allocation happens — Buffer.alloc / allocUnsafe /
// allocUnsafeSlow / .from, ArrayBuffer, SharedArrayBuffer and every typed
// array constructor — and throws a named RangeError (`alloc_cap_exceeded`)
// instead of honoring it. Default 64 MB, set by the parent through
// CAD_WORKER_ALLOC_CAP (a bare number; the child env allow-list otherwise
// admits nothing). Best-effort by design: a plain object growth loop, fs
// side effects or otherwise uncalled-for schemes are not allocations this
// layer can see — the OS limits and the private-only rule for member
// deployments (README) remain the real walls. The runner's own internals
// allocate through the ORIGINAL bindings taken below, so the cap only ever
// bites worker code.
const ALLOC_CAP_BYTES = (() => {
  const n = Number(process.env.CAD_WORKER_ALLOC_CAP);
  return Number.isInteger(n) && n > 0 ? n : 64 * 1024 * 1024;
})();

const RAW = {
  alloc: Buffer.alloc.bind(Buffer),
  allocUnsafe: Buffer.allocUnsafe.bind(Buffer),
  allocUnsafeSlow: Buffer.allocUnsafeSlow.bind(Buffer),
};

function denyAlloc(kind, bytes) {
  const err = new RangeError(
    `alloc_cap_exceeded: ${kind} requesting ${bytes} bytes exceeds this worker's ${ALLOC_CAP_BYTES} byte allocation cap.`);
  err.code = 'alloc_cap_exceeded';
  err.allocCap = ALLOC_CAP_BYTES;
  throw err;
}

const capOk = (bytes, kind) => {
  if (Number.isFinite(Number(bytes)) && Number(bytes) > ALLOC_CAP_BYTES) denyAlloc(kind, bytes);
};

const bytesOfBufferFrom = (arg) => {
  if (arg == null) return 0;
  if (typeof arg === 'string') {
    try { return Buffer.byteLength(arg); } catch { return 0; }
  }
  if (typeof arg === 'object' && typeof arg.byteLength === 'number') return arg.byteLength;
  if (typeof arg.length === 'number') return arg.length; // array / iterable proxy (best-effort)
  return 0;
};

const origBufferFrom = Buffer.from.bind(Buffer);
Buffer.alloc = function alloc(len, ...rest) {
  capOk(len, 'Buffer.alloc');
  return RAW.alloc(len, ...rest);
};
Buffer.allocUnsafe = function allocUnsafe(len) {
  capOk(len, 'Buffer.allocUnsafe');
  return RAW.allocUnsafe(len);
};
Buffer.allocUnsafeSlow = function allocUnsafeSlow(len) {
  capOk(len, 'Buffer.allocUnsafeSlow');
  return RAW.allocUnsafeSlow(len);
};
Buffer.from = function from(arg, ...rest) {
  capOk(bytesOfBufferFrom(arg), 'Buffer.from');
  return origBufferFrom(arg, ...rest);
};

const TYPEDS = [ArrayBuffer, SharedArrayBuffer, Int8Array, Uint8Array, Uint8ClampedArray,
  Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array,
  BigInt64Array, BigUint64Array];
for (const C of TYPEDS) {
  const isBufferCtor = C === ArrayBuffer || C === SharedArrayBuffer;
  const bpe = isBufferCtor ? 1 : (C.BYTES_PER_ELEMENT ?? 1);
  const Wrapped = function (...args) {
    // Constructor byte-length forms: (n) for buffer ctors; for typed arrays
    // (len), (bufferOrArrayLike) or (buffer, byteOffset, len).
    let request;
    if (isBufferCtor) {
      request = typeof args[0] === 'object' ? (args[0]?.byteLength ?? 0) : Number(args[0] ?? 0);
    } else {
      const a0 = args[0];
      if (a0 == null) request = 0;
      else if (typeof a0 === 'object') request = Number(a0.byteLength ?? ((a0.length ?? 0) * bpe));
      else if (args.length >= 3) request = Number(args[2] ?? 0) * bpe;
      else request = Number(a0) * bpe;
    }
    capOk(request, `new ${C.name}`);
    return new C(...args);
  };
  Wrapped.prototype = C.prototype;
  for (const stat of Object.getOwnPropertyNames(C)) {
    if (['length', 'name', 'prototype', 'BYTES_PER_ELEMENT'].includes(stat)) continue;
    try { Wrapped[stat] = C[stat]; } catch { /* getters that resist copying: fine */ }
  }
  if ('BYTES_PER_ELEMENT' in C) {
    try { Object.defineProperty(Wrapped, 'BYTES_PER_ELEMENT', { value: C.BYTES_PER_ELEMENT }); } catch { /* ignore */ }
  }
  try { Object.defineProperty(Wrapped, 'name', { value: C.name }); } catch { /* ignore */ }
  globalThis[C.name] = Wrapped;
}

const waiting = new Map(); // reply id -> {resolve, reject}
process.on('message', (msg) => {
  if (!msg) return;
  if (msg.type === 'me-reply') {
    const p = waiting.get(msg.id);
    if (!p) return;
    waiting.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
    return;
  }
});

function meCall(op, args) {
  return new Promise((resolve, reject) => {
    const id = `c${++seq}`;
    waiting.set(id, { resolve, reject });
    emit({ type: 'me', id, op, args });
  });
}

/** The owner-context SDK. `scope` guards fs (the parent enforces per-call). */
function ownerSdk({ kind, app, user, name, publicGuest, callerUser }) {
  const nsKv = `worker:${user != null ? user : `app:${app}`}:${name}`;
  return {
    __meMeta: { kind, app, user, publicGuest },
    puter: {
      kv: {
        get: (k) => meCall('kv', { op: 'get', args: Array.isArray(k) ? [k] : [String(k ?? '')] }),
        set: (k, v) => meCall('kv', {
          // puter.kv.set has two forms: set(key, value) and set([{key,value}]) —
          // the rsvp worker uses the batch form on sync.
          op: 'set', args: Array.isArray(k) ? [k] : [String(k ?? ''), v === undefined ? null : v],
        }),
        del: (k) => meCall('kv', { op: 'del', args: [k] }),
        remove: (k) => meCall('kv', { op: 'del', args: [k] }),
        list: (pattern = '*', returnValues = false) => meCall('kv', { op: 'list', args: [String(pattern ?? '*'), !!returnValues] }),
        incr: (k, by = 1) => meCall('kv', { op: 'incr', args: [String(k ?? ''), Number(by) || 0] }),
        expire: (k, ttlSeconds) => meCall('kv', { op: 'expire', args: [String(k ?? ''), Number(ttlSeconds) || 0] }),
      },
      // fs + email exist only where the design says so (§17): a public guest
      // invocation has NEITHER. The parent enforces per call as well.
      fs: publicGuest ? undefined : {
        read: (p) => meCall('fs', { op: 'read', args: [String(p ?? '')] }),
        write: (p, data, options = {}) => meCall('fs', { op: 'write', args: [String(p ?? ''), data === undefined ? null : data, options || {}] }),
        mkdir: (p) => meCall('fs', { op: 'mkdir', args: [String(p ?? '')] }),
        delete: (p) => meCall('fs', { op: 'delete', args: [String(p ?? '')] }),
      },
      email: publicGuest ? undefined : {
        send: (obj) => meCall('email', { args: { to: obj?.to, subject: obj?.subject, text: obj?.text, html: obj?.html } }),
      },
    },
  };
}

/** The route collector — same shape as calendar/tests/helpers/worker-harness.js. */
const Router = ContractRouter;

const router = new Router();
globalThis.router = router;
globalThis.__cadRouter = router;
// `me` is the owner context the upstream runtime exposes as a global; like
// router it is a live object whose methods call home over IPC. Scripts can
// also reach it as ctx.me inside a handler (the harness contract).
globalThis.me = null;

/** Replace the global owner context for the call about to run. */
function setMe(meta) {
  globalThis.me = ownerSdk(meta);
  return globalThis.me;
}

// -- the call loop -------------------------------------------------------------

let seq = 0;

const modules = new Map(); // file -> true
async function loadWorker(file) {
  if (!modules.has(file)) {
    // A fresh file's registrations replace whatever was there before: the
    // parent writes each deploy (each distinct sha) to its own tmp module.
    router.routes.length = 0;
    await import(pathToFileURL(file).href);
    modules.set(file, true);
  }
  return { routes: router.routes };
}

process.on('message', (msg) => {
  if (!msg) return;
  if (msg.type !== 'wcall') return;
  run(msg).then(
    (result) => emit({ type: 'wresult', id: msg.id, result }),
    (err) => emit({ type: 'wresult', id: msg.id, error: String(err?.message || err).slice(0, 500), errName: err?.name || 'Error' }),
  );
});

async function run(msg) {
  // The owner context goes in BEFORE the module import so scripts that read
  // the `me` global at top level (the upstream preamble's contract) see it.
  setMe(msg.me);
  const { routes } = await loadWorker(msg.file);

  const method = String(msg.request.method || 'GET').toUpperCase();
  let pathOnly = String(msg.request.path || '/').split('?')[0];
  if (pathOnly.length > 1 && pathOnly.endsWith('/')) pathOnly = pathOnly.slice(0, -1);
  const hit = matchRouteContract(routes, method, pathOnly);
  if (!hit) {
    return { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: `No route for ${method} ${pathOnly}` };
  }

  const me = ownerSdk(msg.me);
  globalThis.__cadMe = me;

  const headers = new Map(Object.entries(msg.request.headers || {}));
  const text = String(msg.request.body ?? '');
  const request = {
    // The worker's absolute URL — its redirect targets (§24-style one-click
    // links) name their OWN origin in the fragment. Real origin when the
    // parent knows it; otherwise the placeholder worker.local.
    url: new URL(msg.request.absoluteUrl || msg.request.path || '/', msg.request.origin || 'http://worker.local'),
    workerBase: msg.request.workerBase || '',
    method,
    path: pathOnly,
    headers,
    headerNames: () => [...headers.keys()],
    body: text,
    text: async () => text,
    json: async () => {
      if (!text.trim()) return null;
      try { return JSON.parse(text); } catch { throw new Error('The request body is not valid JSON.'); }
    },
  };

  const ctx = { request, params: hit.params, me };
  if (msg.callerUser) {
    ctx.user = { username: msg.callerUser };
    ctx.requestor = { username: msg.callerUser }; // apps check both — design §2
  }

  const out = await hit.handler(ctx);
  const serialized = await serializeWorkerResponse(out);
  if (serialized) return serialized;
  // A plain object means JSON 200 — harness lines 167-170.
  return { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(out ?? null) };
}

function matchRoute(routes, method, path) {
  return matchRouteContract(routes, method, path);
}
