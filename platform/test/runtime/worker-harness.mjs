/**
 * RUNTIME variant of upstream `signatures/tests/helpers/worker-harness.js`.
 * Serves the same import surface (instantiateWorker / makeKv / sha256Hex) but
 * replaces every upstream-only piece with the cad-home runtime:
 *
 * - worker source is executed EXACTLY like the forked child does: a fresh
 *   contract Router from lib/worker-contract.js is exposed as the `router`
 *   global, the source (after placeholder substitution) is imported as an ESM
 *   module, and handler results go through the same Response serialization;
 * - `me` is the owner-context global the runner contract defines;
 * - kv goes through lib/hub-kv.js (the same module the parent's `me` frame
 *   handler uses), scoped to a synthetic runtime namespace, with a mirrored
 *   Map view for tests that peek at `kv.map`;
 * - fs goes through lib/hub-fsops.js like the parent's fs frame (read returns
 *   a Blob the way the app expects).
 *
 * Not in scope of this seam (declared): the HTTP wrapper (/wr/ dispatch,
 * content-type allow-list, child sandbox/permission model) stays tested by
 * the root suite; a runtime case here covers framing + kv + fs + worker code.
 */
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { vi } from '../vitest-shim/index.mjs';
import { Router, matchRoute, serializeWorkerResponse } from '../../lib/worker-contract.js';
import * as hubKv from '../../lib/hub-kv.js';
import * as fsops from '../../lib/hub-fsops.js';
import * as db from '../../lib/db.js';

/* ---- Runtime kv: hub-kv is the real store transport -------------------- */

let kvSeq = 0;
const runtimeKvUser = () => `runtime-signatures-${(kvSeq += 1)}`;

export class RuntimeKv {
  constructor({ user = runtimeKvUser(), app = 'signatures' } = {}) {
    this.user = user;
    this.app = app;
    this._map = new Map();
  }
  _refresh() {
    this._map.clear();
    for (const e of hubKv.list({ user: this.user, app: this.app, options: { as: 'entries' } })) {
      this._map.set(e.key, e.value);
    }
  }
}

/** The mirrored Map view. Upstream tests treat `kv.map` as a fixture handle
 * (they peek AND seed), so writes go THROUGH the runtime store: a map write
 * becomes a hubKv set, keeping the view honest and the case runtime-covered. */
export function runtimeKvMapView(ns) {
  return new Proxy(ns._map, {
    get(target, key, receiver) {
      if (key === 'set') {
        return (k, v) => {
          hubKv.set({ user: ns.user, app: ns.app, key: String(k), value: JSON.parse(JSON.stringify(v ?? null)) });
          ns._refresh();
          return target; // Map.set chainability contract
        };
      }
      if (key === 'delete') {
        return (k) => {
          hubKv.del({ user: ns.user, app: ns.app, key: String(k) });
          ns._refresh();
          return true;
        };
      }
      const v = Reflect.get(target, key, target);
      // Map methods need a REAL Map receiver: bind everything to the target
      // so keys()/get()/forEach() on the proxy never hit "incompatible receiver".
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

export function makeKv(initial = {}, { user, app } = {}) {
  const ns = new RuntimeKv({ ...(user != null ? { user } : {}), ...(app != null ? { app } : {}) });
  const kv = {
    // A write-through view of the runtime store (see runtimeKvMapView).
    map: runtimeKvMapView(ns),
    scope: `worker:${ns.user}`,
    set: vi.fn(async (k, v) => {
      const items = Array.isArray(k) ? k : [{ key: k, value: v }];
      for (const { key, value } of items) hubKv.set({ user: ns.user, app: ns.app, key: String(key), value: JSON.parse(JSON.stringify(value ?? null)) });
      ns._refresh();
      return true;
    }),
    get: vi.fn(async (k) => hubKv.get({ user: ns.user, app: ns.app, key: k })),
    del: vi.fn(async (k) => {
      for (const one of [].concat(k ?? [])) hubKv.del({ user: ns.user, app: ns.app, key: one });
      ns._refresh();
      return true;
    }),
    incr: vi.fn(async (k, by = 1) => hubKv.incr({ user: ns.user, app: ns.app, key: String(k), value: Number(by) || 0 })),
    expire: vi.fn(async (k, ttlSeconds) => { hubKv.expire({ user: ns.user, app: ns.app, key: String(k), ttlSeconds: Number(ttlSeconds) || 0 }); return true; }),
    list: vi.fn(async (pattern = '*', returnValues = false) => {
      // cad-home runtime contract: hub-kv matches PREFIXES (a trailing '*' is
      // stripped), unlike the upstream harness's glob. Cases that relied on
      // glob middles will honestly fail here and force a declared fix.
      let p = typeof pattern === 'string' ? pattern.trim() : '*';
      p = p.endsWith('*') ? p.slice(0, -1) : null;
      const entries = hubKv.list({ user: ns.user, app: ns.app, options: { ...(p != null ? { pattern: p } : {}), as: 'entries' } });
      return returnValues ? entries : entries.map((e) => e.key);
    }),
  };
  for (const [key, value] of Object.entries(initial)) {
    hubKv.set({ user: ns.user, app: ns.app, key, value: JSON.parse(JSON.stringify(value)) });
  }
  ns._refresh();
  return kv;
}

/* ---- Runtime fs: hub-fsops is the same transport the parent's me frame uses */

let fsUseSeq = 0;
export function makeFs({ user = `runtime-fs-${(fsUseSeq += 1)}`, app = 'signatures' } = {}) {
  const files = new Map(); // virtualPath -> string content (mirror view)
  const listeners = new Set();
  const fs = {
    user,
    app,
    files,
    onWrite: (fn) => listeners.add(fn),
    write: vi.fn(async (inputPath, content, options = {}) => {
      const data = content instanceof Blob ? new Uint8Array(await content.arrayBuffer()) : content;
      const entry = await fsops.write({ user, app, input: String(inputPath), data, options: { overwrite: true, ...options } });
      // Mirror EVERY write (strings and blobs alike): upstream introspects
      // fs.files for both text sources and binary artifacts.
      files.set(String(inputPath), data);
      for (const fn of listeners) fn(String(inputPath), content);
      void entry;
      return { path: `/${user}/AppData/app/${String(inputPath)}`, name: String(inputPath).split('/').pop() };
    }),
    read: vi.fn(async (inputPath) => {
      // The app writes app-relative paths but records absolute ones; the
      // runtime fs accepts both, missing files name the same error code the
      // upstream fake raised (subject_does_not_exist).
      let buf = null;
      let lastErr = null;
      for (const c of [String(inputPath), String(inputPath).replace(/^\/[^/]+\/AppData\/app\//, '')]) {
        try { buf = await fsops.read({ user, app, input: c }); break; } catch (e) { lastErr = e; }
      }
      if (buf == null) {
        const err = new Error(lastErr?.message || 'No such file');
        err.code = 'subject_does_not_exist';
        err.cause = lastErr;
        throw err;
      }
      return new Blob([Buffer.isBuffer(buf) ? buf : Buffer.from(buf)]);
    }),
    delete: vi.fn(async (inputPath, options = {}) => {
      for (const key of [...files.keys()]) {
        if (key === inputPath || key.startsWith(`${inputPath}/`)) files.delete(key);
      }
      await fsops.del({ user, app, input: String(inputPath), options: { ...options } });
      return true;
    }),
    mkdir: vi.fn(async (inputPath) => {
      const entry = await fsops.mkdir({ user, app, input: String(inputPath) });
      void entry;
      return true;
    }),
  };
  return fs;
}

/* ---- sha256 (same as upstream helper: webcrypto) ------------------------ */

export async function sha256Hex(text) {
  const buf = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---- Worker instantiation: the runner's exact loading contract ---------- */

async function loadWorkerRoutes(source, owner) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-runtime-worker-'));
  const file = path.join(stage, 'worker.mjs');
  await fsp.writeFile(file, source, 'utf8');
  const prevRouter = globalThis.router;
  const prevMe = globalThis.me;
  // Like the runner's child: a fresh contract Router and the owner context go
  // in BEFORE the module import, so scripts that register on the `router`
  // global and read `me` at top level see exactly the runtime shape.
  const router = new Router();
  globalThis.router = router;
  globalThis.me = owner;
  try {
    await import(pathToFileURL(file).href);
  } finally {
    try { await fsp.rm(stage, { recursive: true, force: true }); } catch { /* Windows temp lag */ }
    if (prevRouter === undefined) delete globalThis.router; else globalThis.router = prevRouter;
    if (prevMe === undefined) delete globalThis.me; else globalThis.me = prevMe;
  }
  return router;
}

export function instantiateWorker(source, { kv = null, me = null } = {}) {
  db.open();
  const owner = me || { puter: { kv: kv || makeKv() } };
  const routesPromise = loadWorkerRoutes(String(source));
  const baseOrigin = 'https://test-worker.puter.work';

  /** The serialized view of a runtime response, shaped like the upstream
   * harness's ResponseShim ({status, ok, headers.get(), text()/json()}). */
  class ResponseView {
    constructor(r) {
      this.status = r.status;
      this.ok = r.status >= 200 && r.status < 300;
      const m = new Map(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
      this.headers = { get: (name) => m.get(String(name).toLowerCase()) ?? null };
      this._body = r.body;
    }
    async text() { return this._body; }
    async json() { return this._body == null || !String(this._body).trim() ? null : JSON.parse(this._body); }
    async arrayBuffer() { return new TextEncoder().encode(this._body).buffer; }
  }

  /** `user` stands in for the caller context the runtime attaches when the
   * request arrives through puter.workers.exec(); omit it to call as an
   * anonymous visitor. Request framing follows lib/worker-runner.js run(). */
  async function call(method, pathAndQuery, { headers = {}, body, json, user = null, bindAs = 'user' } = {}) {
    const routes = (await routesPromise).routes;
    const init = { method, headers: { ...headers } };
    if (json !== undefined) {
      init.body = JSON.stringify(json);
      init.headers['content-type'] = 'application/json';
    } else if (body !== undefined) {
      init.body = body;
    }
    const url = new URL(pathAndQuery, baseOrigin);
    let pathOnly = url.pathname;
    if (pathOnly.length > 1 && pathOnly.endsWith('/')) pathOnly = pathOnly.slice(0, -1);
    const hit = matchRoute(routes, method.toUpperCase(), pathOnly);
    if (!hit) return new ResponseView({ status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'no route' });

    const text = init.body == null ? '' : String(init.body);
    const requestHeaders = new Map(Object.entries(init.headers).map(([k, v]) => [String(k).toLowerCase(), String(v)]));
    const request = {
      url: new URL(pathAndQuery, 'https://test-worker.puter.work'),
      workerBase: 'https://test-worker.puter.work/wr/',
      method: method.toUpperCase(),
      path: pathOnly,
      headers: requestHeaders,
      headerNames: () => [...requestHeaders.keys()],
      body: text,
      text: async () => text,
      json: async () => {
        if (!text.trim()) return null;
        try { return JSON.parse(text); } catch { throw new Error('The request body is not valid JSON.'); }
      },
    };
    const ctx = { request, params: hit.params, me: owner };
    if (user) ctx[bindAs] = user;
    // A handler may read the `me` global directly: during the call it sees
    // this worker's owner context, like the runner's per-call setMe.
    const prevMe = globalThis.me;
    globalThis.me = owner;
    let out;
    try {
      out = await hit.handler(ctx);
    } finally {
      if (prevMe === undefined) delete globalThis.me; else globalThis.me = prevMe;
    }
    const serialized = await serializeWorkerResponse(out);
    if (serialized) return new ResponseView(serialized);
    return new ResponseView({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(out ?? null) });
  }

  return { call, kv: owner.puter.kv || kv, me: owner, routes: routesPromise.then((r) => r.routes) };
}
