/**
 * RUNTIME variant of upstream `signatures/tests/helpers/fake-puter.js`.
 * Same import surface (makeFs / makeFakePuter / re-exported makeKv), with the
 * app-side slices backed by the cad-home runtime:
 *
 * - kv: lib/hub-kv.js transport (worker-harness.mjs makeKv, write-through map);
 * - fs: lib/hub-fsops.js transport (same rules the parent's me frame uses);
 * - workers.create: a REAL hub worker row (lib/hub-workers.js) whose requests
 *   run through the parent-side dispatcher (lib/hub-workers-run.js `invoke`);
 * - fetchTo: an app-side fetch routed to that live instance by its canonical
 *   host label (§26), executed by the forked child with me frames over IPC.
 *
 * Declared differences from the upstream fake (kept for audit):
 * - workers.exec stays a plain spy: cases that use it inject canned exec
 *   results on purpose (they test the app's handling, not the canal);
 * - `p.workersByUrl` keeps the upstream record shape for introspection, but
 *   the record's `instance` is built by the RUNTIME worker harness (runtime
 *   kv/fs in me). The deployed ROW is the dispatch path; the instance is
 *   what a test peeks into directly (instance.kv/call).
 */
import { vi } from '../vitest-shim/index.mjs';
import { makeKv, makeFs, instantiateWorker } from './worker-harness.mjs';
import * as hubWorkers from '../../lib/hub-workers.js';

export { makeKv };
export { makeFs };

/** Serialized dispatch result shaped like a fetch Response (apps check
 * ok/status and call json()/text(); signlinks, expiry and deleteflow do).
 * Accepts BOTH shapes our transports produce: the serialized dispatch object
 * ({status, headers, body}) from lib/hub-workers-run.js and the ResponseView
 * the runtime worker harness's call() returns ({status, ok, headers.get(),
 * _body/text()/json()}). */
class RuntimeFetchResponse {
  constructor(r) {
    if (r && typeof r.text === 'function') {
      this.status = r.status;
      this.ok = !!r.ok;
      const m = new Map();
      this.headers = { get: (name) => m.get(String(name).toLowerCase()) ?? null };
      this._body = null;
      this._view = r;
    } else {
      this.status = r.status;
      this.ok = r.status >= 200 && r.status < 300;
      const entries = Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]);
      const m = new Map(entries);
      this.headers = { get: (name) => m.get(String(name).toLowerCase()) ?? null };
      this._body = r.body == null ? '' : String(r.body);
      this._view = null;
    }
  }
  async text() { return this._view ? this._view.text() : this._body; }
  async json() { return this._view ? this._view.json() : (this._body.trim() ? JSON.parse(this._body) : null); }
}

export function makeFakePuter({ user = { username: 'testuser', email: 'me@example.com', uuid: 'u-1' } } = {}) {
  const kv = makeKv();
  const fs = makeFs();
  const workersByUrl = new Map(); // canonical origin -> upstream-shaped record
  const workersByName = new Map(); // name -> record
  const rowsByLabel = new Map(); // host label -> real worker row
  const canonicalUrl = (label) => `https://${label}.puter.work`;

  const workers = {
    create: vi.fn(async (name, filePath) => {
      const nameStr = String(name);
      const pathStr = String(filePath);
      const source = fs.files.get(pathStr);
      if (source == null) throw new Error(`no source at ${pathStr}`);
      // Real row: the app's own deploy flow (write through the runtime fs,
      // then create). The dispatcher re-reads the file per request.
      hubWorkers.create({ user: fs.user, app: 'signatures', name: nameStr, filePath: pathStr });
      const row = hubWorkers.resolveRoute({ user: fs.user, name: nameStr });
      rowsByLabel.set(row.host_label, row);
      const record = {
        name: nameStr,
        filePath: pathStr,
        hostLabel: row.host_label,
        // The upstream fake's instance slot: an instance of the SAME source
        // over the SAME namespace the real dispatcher uses for the row
        // (user = row.user, app = worker:<name>, lib/hub-workers-run.js
        // handleMe) — introspection (instance.kv/call) sees exactly what a
        // request through the deployed row sees.
        rowKv: makeKv({}, { user: row.user, app: `worker:${row.name}` }),
        instance: null,
      };
      const buildInstance = () => {
        record.instance = instantiateWorker(String(fs.files.get(pathStr)), { me: { puter: { kv: record.rowKv, fs } } });
      };
      buildInstance();
      // Overwriting a deployed worker's file redeploys it (Puter semantics):
      // the row re-reads its file per dispatch; the introspection instance is
      // rebuilt from the new source over the same namespace.
      fs.onWrite((writtenPath) => {
        if (writtenPath === pathStr && workersByName.get(nameStr) === record) buildInstance();
      });
      workersByUrl.set(canonicalUrl(row.host_label), record);
      workersByName.set(nameStr, record);
      return { url: canonicalUrl(row.host_label), name: row.name, file_path: row.file_path, host_label: row.host_label };
    }),
    delete: vi.fn(async (name) => {
      const record = workersByName.get(String(name));
      if (record) {
        await hubWorkers.deployDelete({ user: fs.user, app: 'signatures' }, String(name));
        rowsByLabel.delete(record.hostLabel);
        workersByUrl.delete(canonicalUrl(record.hostLabel));
        workersByName.delete(String(name));
      }
      return true;
    }),
    get: vi.fn(async (name) => {
      const record = workersByName.get(String(name));
      return record ? { name: record.name, file_path: record.filePath, url: canonicalUrl(record.hostLabel) } : null;
    }),
    exec: vi.fn(),
  };

  const p = {
    env: 'web',
    auth: {
      isSignedIn: vi.fn(() => true),
      getUser: vi.fn(async () => user),
      signOut: vi.fn(),
    },
    kv,
    fs,
    workers,
  };
  p.workersByUrl = workersByUrl;
  p.workersByName = workersByName;

  /** An app-side fetch: resolve the canonical host label to the deployed
   * record and run the SAME worker source through the runtime harness
   * instance (worker-contract Router + hub-kv transport). Upstream's fake
   * routes fetches through the record's instance.call too — cases that
   * introspect admin calls (seen-paths) depend on that indirection. The
   * deployed ROW for the record still exists (create() made it); the full
   * /wr HTTP wrapper + child sandbox dispatch is root-suite coverage. */
  p.fetchTo = async (url, init = {}) => {
    const u = new URL(String(url));
    const label = u.hostname.replace(/\.puter\.work$/, '');
    const record = [...workersByUrl.values()].find((r) => r.hostLabel === label);
    if (!record || !record.instance?.call) {
      return new RuntimeFetchResponse({ status: 404, headers: { 'content-type': 'text/plain' }, body: 'no worker' });
    }
    const out = await record.instance.call(String(init.method || 'GET').toUpperCase(), `${u.pathname}${u.search}`, {
      headers: init.headers || {},
      body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body ?? ''),
    });
    return new RuntimeFetchResponse(out);
  };

  return p;
}
