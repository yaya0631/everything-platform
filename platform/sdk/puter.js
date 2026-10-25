/**
 * puter.js — CAD Home's Puter-compatible SDK for hosted apps.
 *
 * This file runs inside the app's sandboxed iframe (opaque origin: no CAD
 * cookies, no shared storage). The launcher gives it a scoped bearer token and
 * every call goes to /appapi/<app>/… with it. When the token expires, the SDK
 * asks the launcher for a fresh one. File pickers (and the email prompt) live
 * in the launcher too, because only that page can show the person's files.
 *
 * Functions (`puter.functions.call`) POST to /fn/<app>/<name> with the same
 * bearer token; the server runs the deployed serverless function for the app.
 */
(() => {
  'use strict';

  const m = /\/(?:app|p)-content\/([^/?#]+)/.exec(location.pathname);
  if (!m) return; // Not an app page; the SDK stays inactive.
  const APP = m[1];

  const launched = window.parent && window.parent !== window;
  const state = { token: null, tokenWaiters: [], user: undefined };

  if (!launched) {
    // No launcher parent: nothing can hand us a token, and nothing can show
    // pickers. Tell whoever is looking at the app directly.
    document.addEventListener('DOMContentLoaded', () => {
      const note = document.createElement('div');
      note.textContent = `This app should be opened from /apps/${APP}/ on your CAD Home server, so it can get access to your files.`;
      note.style.cssText = 'position:fixed;inset:auto 0 0 0;padding:10px 14px;font:14px system-ui;background:#b3261e;color:#fff;z-index:2147483647';
      document.body.append(note);
    });
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const d = e.data || {};
    if (d.type === 'token' && typeof d.token === 'string') {
      state.token = d.token;
      while (state.tokenWaiters.length) state.tokenWaiters.shift()();
    }
  });

  const haveToken = () => new Promise((r) => {
    if (state.token) return r();
    state.tokenWaiters.push(r);
  });

  function askLauncher(msg) {
    if (!launched) throw new Error(`Open this app from /apps/${APP}/ on your CAD Home server.`);
    const win = window.parent;
    win.postMessage(msg, '*');
    return new Promise((resolve, reject) => {
      const onMsg = (e) => {
        if (e.source !== win) return;
        const d = e.data || {};
        if (d.id !== msg.id) return;
        window.removeEventListener('message', onMsg);
        if (d.error) reject(new Error(d.error === 'cancelled' ? 'Cancelled.' : d.error));
        else resolve(d);
      };
      window.addEventListener('message', onMsg);
    });
  }

  async function call(route, { method = 'GET', body, raw = false, json = true } = {}) {
    if (!launched) throw new Error(`Open this app from /apps/${APP}/ on your CAD Home server.`);
    await haveToken();
    const run = async (tk) =>
      fetch(`/appapi/${APP}/${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${tk}`,
          ...(body !== undefined && typeof body === 'string' ? { 'Content-Type': 'text/plain; charset=utf-8' } : {}),
        },
        body: body === undefined ? undefined : body,
      });
    let res = await run(state.token);
    if (res.status === 401) {
      state.token = null;
      window.parent?.postMessage({ type: 'refreshToken', app: APP }, '*');
      await haveToken();
      res = await run(state.token);
    }
    if (raw) return res;
    const type = res.headers.get('content-type') || '';
    const out = type.includes('json') ? await res.json().catch(() => null) : null;
    if (!res.ok) {
      const err = new Error(out?.message || `The request failed (${res.status}).`);
      err.status = res.status;
      err.code = out?.code || `http_${res.status}`;
      throw err;
    }
    return json ? (out ?? {}) : res;
  }

  let pickId = 0;

  const items = (r) => (r.items || []).map((i) => new FSItem(i));

  class FSItem {
    constructor(o = {}) {
      this.name = o.name || '';
      this.path = o.path || `~grant/${o.id || ''}`;
      this.uid = o.id || null;
      this.isDir = false;
      Object.freeze(this);
    }
    async read() {
      const res = await call(`fs/read?path=${encodeURIComponent(this.path)}`, { raw: true });
      return res.arrayBuffer();
    }
    async write(data) {
      const body = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      await call(`fs/write?path=${encodeURIComponent(this.path)}`, { method: 'PUT', body });
      return this;
    }
    async stat() {
      return call(`fs/stat?path=${encodeURIComponent(this.path)}`);
    }
    async rename(newName) {
      const parts = this.path.split('/');
      parts.pop();
      const to = `${parts.join('/')}/${newName}`;
      const out = await call('fs/rename', { method: 'POST', body: JSON.stringify({ from: this.path, to }) });
      return new FSItem({ name: newName, path: `~${out.path || to}`, id: this.uid });
    }
    async delete() {
      await call(`fs/delete?path=${encodeURIComponent(this.path)}`, { method: 'DELETE' });
      return this;
    }
  }

  // auth ---------------------------------------------------------------------------------------

  async function getUser() {
    if (state.user !== undefined) return state.user;
    try {
      state.user = await call('whoami');
    } catch {
      state.user = null;
    }
    return state.user;
  }

  // fs -------------------------------------------------------------------------------------------

  /** Paths outside the app's own data folder need a grant from a picker. */
  const fs = {
    async read(path) {
      const res = await call(`fs/read?path=${encodeURIComponent(String(path))}`, { raw: true });
      return res.arrayBuffer();
    },
    async write(path, data) {
      const body = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      return call(`fs/write?path=${encodeURIComponent(String(path))}`, { method: 'PUT', body });
    },
    async readdir(path = '') {
      const r = await call(`fs/readdir?path=${encodeURIComponent(String(path))}`);
      return (r.items || []).map((i) => new FSItem({ name: i.name, path: i.path.startsWith('/') ? i.path : i.path, id: i.name }));
    },
    async mkdir(path) {
      return call(`fs/mkdir?path=${encodeURIComponent(String(path))}`, { method: 'POST' });
    },
    async delete(path, { recursive = false } = {}) {
      return call(`fs/delete?path=${encodeURIComponent(String(path))}&recursive=${recursive ? 1 : 0}`, { method: 'DELETE' });
    },
    async stat(path) {
      return call(`fs/stat?path=${encodeURIComponent(String(path))}`);
    },
    async rename(from, to) {
      return call('fs/rename', { method: 'POST', body: JSON.stringify({ from: String(from), to: String(to) }) });
    },
  };

  // kv ---------------------------------------------------------------------------------------------

  const kv = {
    set: (key, value) => call(`kv/${encodeURIComponent(String(key))}`, { method: 'PUT', body: JSON.stringify({ value: value ?? null }) }).then(() => value ?? null),
    get: async (key) => (await call(`kv/${encodeURIComponent(String(key))}`)).value ?? null,
    del: (key) => call(`kv/${encodeURIComponent(String(key))}`, { method: 'DELETE' }).then(() => true),
    list: async (pattern = '*', withValues = false) => {
      const r = await call(`kv/list?pattern=${encodeURIComponent(String(pattern))}&values=${withValues ? 1 : 0}`);
      return r;
    },
    incr: (key, by = 1) => call('kv/incr', { method: 'POST', body: JSON.stringify({ key, by }) }).then((r) => r.value),
    flush: () => call('kv/flush', { method: 'POST' }).then(() => true),
  };

  // ai -----------------------------------------------------------------------------------------------

  function normalizeChatArgs(arg, opts, arg2) {
    /** accepted: prompt string, messages array, or (prompt, options) */
    let messages;
    if (Array.isArray(arg)) messages = arg;
    else if (typeof arg === 'string') messages = [{ role: 'user', content: arg }];
    else messages = [];
    const o = opts && typeof opts === 'object' ? opts : {};
    return { messages, model: o.model, stream: !!o.stream };
  }

  async function* ndjson(res) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) {
          let ev;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          yield ev;
        }
      }
    }
    if (buf.trim()) {
      try {
        yield JSON.parse(buf.trim());
      } catch {
        /* trailing junk */
      }
    }
  }

  /** Normalise tool definitions the app hands in into the flat shape the core expects. */
  function normalizeTools(tools) {
    if (tools == null || tools === false) return undefined;
    if (!Array.isArray(tools)) throw new Error('tools must be a list.');
    return tools.map((t) => {
      const f = t && typeof t.function === 'object' ? t.function : t;
      if (!f || typeof f.name !== 'string') throw new Error('Each tool needs a name.');
      return {
        name: f.name,
        description: String(f.description || ''),
        parameters: f.parameters && typeof f.parameters === 'object' ? f.parameters : { type: 'object', properties: {} },
      };
    });
  }

  class Message {
    constructor({ text, toolCalls, model }) {
      this.content = text;
      this.text = text;
      this.tool_calls = toolCalls || [];
      this.model = model || null;
    }
    toString() {
      return this.text;
    }
  }

  const ai = {
    listModels: () => call('ai/models').then((r) => r),
    async chat(promptOrMessages, options, _e) {
      const { messages, model, stream } = normalizeChatArgs(promptOrMessages, options, _e);
      const o = options && typeof options === 'object' ? options : {};
      const tools = normalizeTools(o.tools);
      const res = await call('ai/chat', { method: 'POST', raw: true, body: JSON.stringify({ model, messages, ...(tools ? { tools } : {}) }) });
      if (!res.ok) {
        const out = await res.json().catch(() => ({}));
        const err = new Error(out?.message || `The AI request failed (${res.status}).`);
        err.status = res.status;
        err.code = out?.code || `http_${res.status}`;
        throw err;
      }
      if (!stream) {
        let text = '';
        const toolCalls = [];
        for await (const ev of ndjson(res)) {
          if (ev.type === 'text') text += ev.delta;
          else if (ev.type === 'tool_call') toolCalls.push({ id: ev.id, name: ev.name, arguments: ev.arguments });
          else if (ev.type === 'error') throw Object.assign(new Error(ev.message), { code: ev.code });
        }
        return new Message({ text, toolCalls, model });
      }
      return {
        async *[Symbol.asyncIterator]() {
          for await (const ev of ndjson(res)) {
            if (ev.type === 'text') yield { type: 'text', text: ev.delta };
            else if (ev.type === 'tool_call') yield { type: 'tool_call', id: ev.id, name: ev.name, arguments: ev.arguments };
            else if (ev.type === 'error') throw Object.assign(new Error(ev.message), { code: ev.code });
          }
        },
      };
    },
  };

  // ui -----------------------------------------------------------------------------------------------

  const ui = {
    async showOpenFilePicker(options = {}) {
      const r = await askLauncher({ type: 'showOpenFilePicker', id: ++pickId, accept: options.accept || [], multiple: !!options.multiple, mode: options.mode || 'read' });
      return items(r);
    },
    async showSaveFilePicker(data, suggestedName) {
      const r = await askLauncher({ type: 'showSaveFilePicker', id: ++pickId, suggestedName: typeof suggestedName === 'string' ? suggestedName : (typeof data === 'string' ? '' : 'file') || 'file' });
      const item = items(r)[0];
      if (data !== undefined) return item.write(data);
      return item;
    },
  };

  const email = {
    async send(obj) {
      try {
        await call('email/send', { method: 'POST', body: JSON.stringify({ to: obj?.to, subject: obj?.subject, text: obj?.text, html: obj?.html }) });
        return { ok: true };
      } catch (err) {
        if (err.code === 'email_permission') {
          const r = await askLauncher({ type: 'emailPermission', id: ++pickId, title: APP });
          if (!r?.allowed) throw new Error(`${APP} is not allowed to send your email.`);
          await call('email/send', { method: 'POST', body: JSON.stringify({ to: obj?.to, subject: obj?.subject, text: obj?.text, html: obj?.html }) });
          return { ok: true };
        }
        throw err;
      }
    },
  };

  const functions = {
    async call(name, args) {
      if (!launched) throw new Error(`Open this app from /apps/${APP}/ on your CAD Home server.`);
      await haveToken();
      const run = async (tk) =>
        fetch(`/fn/${APP}/${name}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(args ?? {}),
        });
      let res = await run(state.token);
      if (res.status === 401) {
        state.token = null;
        window.parent?.postMessage({ type: 'refreshToken', app: APP }, '*');
        await haveToken();
        res = await run(state.token);
      }
      const out = await res.json().catch(() => null);
      if (!res.ok) {
        const err = new Error(out?.message || `The function call failed (${res.status}).`);
        err.status = res.status;
        err.code = out?.code || `http_${res.status}`;
        throw err;
      }
      return out;
    },
  };

  window.puter = {
    APP_NAME: APP,
    auth: { isSignedIn: async () => !!(await getUser()), getUser },
    fs,
    kv,
    ai,
    ui,
    email,
    functions,
  };
})();
