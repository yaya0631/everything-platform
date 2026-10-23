/**
 * The pure, transport-free core of the workers runtime contract: the route
 * collector, route matching, and Response serialization. `worker-runner.js`
 * (the forked child) and the runtime test seam (`test/runtime/`) both use it
 * verbatim, so a test that frames calls through this module exercises the
 * same framing the server would use for the same worker source.
 */
export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler) {
    this.routes.push({ method: String(method).toUpperCase(), pattern: String(pattern), handler });
  }
  get(p, h) { this.add('GET', p, h); }
  post(p, h) { this.add('POST', p, h); }
  put(p, h) { this.add('PUT', p, h); }
  delete(p, h) { this.add('DELETE', p, h); }
  options(p, h) { this.add('OPTIONS', p, h); }
}

export function matchRoute(routes, method, path) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const segP = String(r.pattern).replace(/\/index$/, '').split('/');
    const segA = path.split('/');
    if (segP.length !== segA.length) continue;
    let ok = true;
    const params = {};
    for (let i = 0; i < segP.length; i++) {
      if (segP[i].startsWith(':')) params[segP[i].slice(1)] = decodeURIComponent(segA[i]);
      else if (segP[i] !== segA[i]) { ok = false; break; }
    }
    if (ok) return { handler: r.handler, params };
  }
  return null;
}

/** A handler's return value becomes the wire response: a Response/Response-like
 * object is read body-once; a plain object means a JSON 200. Returns the
 * canonical {status, headers, body} result, or null if `out` is not a
 * response-like value (the caller decides the plain-object branch). */
export async function serializeWorkerResponse(out) {
  if (out && typeof out === 'object' &&
    (out instanceof Response || (typeof out.status === 'number' && (out.headers !== undefined || out.body !== undefined)))) {
    // Response-like: read the body ONCE (a Response's .body is a stream),
    // then serialize status + headers + body text over IPC.
    const headers = {};
    let status = out.status ?? 200;
    for (const [k, v] of (typeof out.headers?.entries === 'function' ? out.headers.entries() : Object.entries(out.headers ?? {}))) {
      if (k.toLowerCase() === 'set-cookie') continue; // workers never hand out cookies — §16
      headers[k] = String(v);
    }
    let body;
    try {
      body = typeof out.text === 'function' ? await out.text() : (out.body == null ? '' : out.body);
    } catch {
      body = '';
    }
    if (typeof body !== 'string') {
      try { body = Buffer.from(body).toString('utf8'); } catch {
        headers['Content-Type'] = headers['Content-Type'] || 'application/json; charset=utf-8';
        body = JSON.stringify(body);
      }
    }
    return { status, headers, body };
  }
  return null;
}
