/**
 * Shared test setup: a fresh data folder per test file (node --test runs each
 * file in its own process), the server on random ports, and a tiny client
 * with a cookie jar.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-home-test-'));
process.env.CAD_DATA_DIR = DATA;
process.env.CAD_PRIVATE_URL = '';
process.env.CAD_PUBLIC_URL = '';
process.env.CAD_TEST = '1';

export async function start() {
  const server = await import('../server.js');
  const running = await server.startServer({ port: 0, publicPort: 0, host: '127.0.0.1', tls: null });
  const base = `http://127.0.0.1:${running.privatePort}`;
  const pub = `http://127.0.0.1:${running.publicPort}`;
  return { ...running, base, pub, server };
}

export async function cleanup(running) {
  await running?.close();
  // A worker child killed in the same tick can still hold its cwd on Windows.
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(DATA, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  console.warn(`cleanup: left ${DATA} in place (a child process still held it)`);
}

/** A browser-like client for the private listener. */
export function client(base) {
  let cookie = '';
  async function call(method, route, { body, json, headers = {}, raw = false } = {}) {
    const h = { 'X-CAD-Request': '1', ...headers };
    if (cookie) h.Cookie = cookie;
    let data = body;
    if (json !== undefined) {
      h['Content-Type'] = 'application/json';
      data = JSON.stringify(json);
    }
    const res = await fetch(`${base}${route.startsWith('/') ? route : `/api/${route}`}`, { method, headers: h, body: data, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) {
      const m = /cad_session=([^;]*)/.exec(set);
      if (m) cookie = m[1] ? `cad_session=${m[1]}` : '';
    }
    if (raw) return res;
    const type = res.headers.get('content-type') || '';
    const out = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, body: out, headers: res.headers };
  }
  return {
    call,
    get: (r, o) => call('GET', r, o),
    post: (r, json, o) => call('POST', r, { json, ...o }),
    put: (r, json, o) => call('PUT', r, { json, ...o }),
    del: (r, json, o) => call('DELETE', r, { json, ...o }),
    get cookie() {
      return cookie;
    },
    set cookie(v) {
      cookie = v;
    },
    async login(username, password) {
      const r = await call('POST', 'auth/login', { json: { username, password } });
      if (r.status !== 200) throw new Error(`login failed: ${JSON.stringify(r.body)}`);
      return r.body;
    },
  };
}
