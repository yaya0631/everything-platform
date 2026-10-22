/**
 * The inside of a serverless function (lib/functions.js forks one of these per
 * app). It loads the deployed functions/<name>.js module, hands it
 * (request, ctx) and sends the answer back over IPC.
 *
 * Node's permission model is on (the --permission flags come from the parent),
 * so the function only reads its own app folder and cannot write files, spawn
 * processes, open workers or load addons. console.* travels to the parent,
 * which stores it in function_logs. ctx.kv, ctx.userKv, ctx.ai and ctx.email
 * are proxies: the parent does the real work.
 */
import { pathToFileURL } from 'node:url';
import { format } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';

const post = process.send?.bind(process) ?? (() => {});
/** IPC only knows JSON; never let a send failure kill a call. */
const emit = (msg) => {
  try {
    post(msg);
  } catch {
    /* the parent is gone; the process is about to die anyway */
  }
};

/** The running call, so console.* and ctx messages can name their function. */
const current = new AsyncLocalStorage();

// console.* goes to the server's function_logs.
for (const level of ['log', 'info', 'warn', 'error']) {
  console[level] = (...args) => {
    const text = format(...args);
    emit({ type: 'log', level, fn: current.getStore()?.name ?? '', text: text.length > 512 ? text.slice(0, 512) : text });
  };
}

process.on('uncaughtException', (err) => emit({ type: 'log', level: 'error', fn: current.getStore()?.name ?? '', text: `uncaught: ${String(err?.message || err).slice(0, 400)}` }));
process.on('unhandledRejection', (err) => emit({ type: 'log', level: 'error', fn: current.getStore()?.name ?? '', text: `unhandled rejection: ${String(err?.message || err).slice(0, 400)}` }));

let seq = 0;
const waiting = new Map(); // ctx call id → { resolve, reject }

process.on('message', (msg) => {
  if (!msg) return;
  if (msg.type === 'ctx-reply') {
    const p = waiting.get(msg.id);
    if (!p) return;
    waiting.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
    return;
  }
  if (msg.type === 'call') {
    current.run({ id: msg.id, name: msg.name }, () =>
      run(msg).then(
        (result) => emit({ type: 'result', id: msg.id, result }),
        (err) => emit({ type: 'result', id: msg.id, error: String(err?.message || err).slice(0, 400) }),
      ),
    );
  }
});

function ctxCall(op, args) {
  return new Promise((resolve, reject) => {
    const id = `c${++seq}`;
    waiting.set(id, { resolve, reject });
    emit({ type: 'ctx', id, op, args, fnName: current.getStore()?.name ?? '', job: current.getStore()?.id ?? '' });
  });
}

const modules = new Map();
async function load(name, file) {
  if (modules.has(file)) return modules.get(file);
  const mod = await import(pathToFileURL(file).href);
  if (typeof mod?.default !== 'function') throw new Error(`${name} does not export a default function.`);
  modules.set(file, mod.default);
  return mod.default;
}

async function run(msg) {
  const fn = await load(msg.name, msg.file);
  const request = {
    method: msg.request.method,
    path: msg.request.path,
    query: msg.request.query,
    headers: msg.request.headers,
    text: async () => String(msg.request.body ?? ''),
    json: async () => {
      const text = String(msg.request.body ?? '');
      if (!text.trim()) return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new Error('The request body is not valid JSON.');
      }
    },
  };

  const kvApi = (nsName, forUser) => {
    if (forUser && !msg.user) return null; // anonymous callers have no key-value storage
    const ns = { op: forUser ? 'ukv' : 'kv' };
    return {
      async get(key) {
        return (await ctxCall('kv', { ...ns, user: msg.user, fn: 'get', args: [String(key ?? '')] })) ?? null;
      },
      async set(key, value) {
        await ctxCall('kv', { ...ns, user: msg.user, fn: 'set', args: [String(key ?? ''), value === undefined ? null : value] });
        return true;
      },
      async remove(key) {
        return !!(await ctxCall('kv', { ...ns, user: msg.user, fn: 'del', args: [String(key ?? '')] }));
      },
      async list() {
        return await ctxCall('kv', { ...ns, user: msg.user, fn: 'list' });
      },
      async incr(key, by = 1) {
        return await ctxCall('kv', { ...ns, user: msg.user, fn: 'incr', args: [String(key ?? ''), Number(by) || 0] });
      },
    };
  };

  const ctx = {
    app: msg.app,
    user: msg.user ? { username: msg.user } : null,
    env: msg.env,
    kv: kvApi('shared', false),
    userKv: kvApi('user', true),
    ai: {
      async chat(options) {
        return await ctxCall('ai', { options: options ?? {}, user: msg.user, guest: !msg.user, ip: msg.ip });
      },
    },
    email: {
      async send(obj) {
        return await ctxCall('email', { to: obj?.to, subject: obj?.subject, text: obj?.text, html: obj?.html, user: msg.user, ip: msg.ip });
      },
    },
  };

  const out = await fn(request, ctx);
  if (out && typeof out === 'object' && !Array.isArray(out) && ('status' in out || 'headers' in out || 'body' in out)) {
    const status = Number.isInteger(out.status) && out.status >= 100 && out.status < 600 ? out.status : 200;
    const headers = {};
    for (const [k, v] of Object.entries(out.headers || {})) {
      if (typeof v !== 'string' && typeof v !== 'number') continue;
      if (k.toLowerCase() === 'set-cookie') continue; // functions never hand out cookies
      headers[k] = String(v);
    }
    let body = out.body == null ? '' : out.body;
    if (body instanceof Uint8Array) body = Buffer.from(body).toString('utf8');
    if (typeof body !== 'string') {
      body = JSON.stringify(body);
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json; charset=utf-8';
    }
    return { status, headers, body };
  }
  // Any other value is the JSON response body.
  return { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(out ?? null) };
}
