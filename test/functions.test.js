/**
 * Serverless functions: the sandboxed runner (Node's permission model), the
 * per-app queue, the timeout kill-and-restart, ctx over IPC, and what the
 * function logs keep to themselves. The tests fork real child processes and
 * talk to the server over HTTP, like the SDK does.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { start, cleanup, client } from './helpers.js';

let running, store, db, paths;
let admin, sam;

async function setup() {
  running = await start();
  store = await import('../lib/store.js');
  db = await import('../lib/db.js');
  paths = await import('../lib/paths.js');
  store.addUser('alex', 'alex-password', { email: 'alex@example.com' });
  store.addUser('sam', 'sam-password');
  admin = client(running.base);
  sam = client(running.base);
  await admin.login('alex', 'alex-password');
  await sam.login('sam', 'sam-password');

  const deploy = async (name, files) => {
    for (const [p, text] of Object.entries(files)) {
      const r = await admin.call('PUT', `admin/apps/${name}/staging?path=${encodeURIComponent(p)}`, { body: Buffer.from(text) });
      if (r.status !== 200) throw new Error(`staging ${p}: ${JSON.stringify(r.body)}`);
    }
    const pub = await admin.post(`admin/apps/${name}/publish`, {});
    if (pub.status !== 200) throw new Error(`publish ${name}: ${JSON.stringify(pub.body)}`);
    return pub;
  };

  await deploy('work', {
    'index.html': '<h1>work</h1>',
    'functions/loop.js': 'export default async () => new Promise(() => {}); // hangs forever',
    'functions/kv.js': 'export default async (request, ctx) => ({ hits: await ctx.kv.incr("hits") });',
    'functions/userkv.js': 'export default async (request, ctx) => { await ctx.userKv.set("mine", ctx.user && ctx.user.username); return await ctx.userKv.get("mine"); };',
    'functions/fswrite.js': 'import * as fs from "node:fs";\nexport default async () => { fs.writeFileSync("evil.txt", "nope"); return { wrote: true }; };',
    'functions/spawn.js': 'export default async () => { const cp = await import("node:child_process"); cp.spawn("ping", ["1.1.1.1"]); return "spawned"; };',
    'functions/worker.js': 'export default async () => { const wt = await import("node:worker_threads"); new wt.Worker("./nope.js"); return "forked"; };',
    'functions/envcheck.js': 'export default async (request, ctx) => {\n  console.log("env-check", ctx.app, (ctx.env.SECRET || "").length, "chars");\n  return { secret: "SECRET" in ctx.env ? "hidden" : "missing", named: ctx.app };\n};',
    'functions/slow.js': 'export default async () => { await new Promise((r) => setTimeout(r, 750)); return { ok: true }; };',
  });

  await deploy('hooked', {
    'index.html': '<h1>hooked</h1>',
    'functions/hello.js': 'export default async (request, ctx) => ({ ok: true, user: !!(ctx.user && ctx.user.username), method: request.method, q: request.query.a ?? null });',
  });
  const pub = await admin.put('admin/apps/hooked', { visibility: 'public' });
  assert.equal(pub.body.visibility, 'public');
  const env = await admin.put('admin/apps/work', { env: { SECRET: 's3cr3t-digits!' } });
  assert.equal(env.status, 200);
}

before(setup);
after(() => cleanup(running));

/** A scoped app token for client c. */
const token = async (c, app) => (await c.post(`apps/${app}/token`, {})).body.token;

/** Call /fn/<app>/<name> like a machine would: bearer, CAD session, or nothing. */
const fn = async (app, name, { method = 'POST', token: tk, c, pub = false, query = '', body } = {}) => {
  const headers = {};
  if (tk) headers.Authorization = `Bearer ${tk}`;
  if (c) {
    headers['X-CAD-Request'] = '1';
    headers.Cookie = c.cookie;
  }
  let data;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    data = JSON.stringify(body);
  }
  const res = await fetch(`${pub ? running.pub : running.base}/fn/${app}/${name}${query}`, { method, headers, body: data });
  const type = res.headers.get('content-type') || '';
  const text = await res.text();
  return { status: res.status, body: type.includes('json') && text ? JSON.parse(text) : text };
};

test('auth: bearer or CAD session on the private listener; unknown functions 404; private apps are invisible on the public listener', async () => {
  assert.equal((await fn('work', 'slow')).status, 401);
  // The session cookie plus the X-CAD-Request header works too.
  const mine = await fn('work', 'slow', { c: sam });
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body, { ok: true });

  assert.equal((await fn('work', 'nope', { token: await token(admin, 'work') })).status, 404);
  assert.equal((await fn('work', 'kv', { pub: true, token: await token(admin, 'work') })).status, 404);
});

test('ctx.kv is shared per app, ctx.userKv is per user', async () => {
  const t = await token(admin, 'work');
  assert.deepEqual((await fn('work', 'kv', { token: t })).body, { hits: 1 });
  assert.deepEqual((await fn('work', 'kv', { token: t })).body, { hits: 2 });

  const s = await token(sam, 'work');
  assert.deepEqual((await fn('work', 'userkv', { token: s })).body, 'sam');
});

test('the sandbox blocks file writes, child processes and workers', async () => {
  const t = await token(admin, 'work');
  for (const name of ['fswrite', 'spawn', 'worker']) {
    const r = await fn('work', name, { token: t });
    assert.equal(r.status, 500, `${name}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'function_error', `${name}: ${JSON.stringify(r.body)}`);
  }
  // Nothing landed on disk from the fs attempt.
  const dir = fs.readdirSync(`${paths.DATA_DIR}/apps/work/functions`);
  assert.ok(!dir.some((f) => f.includes('evil')), JSON.stringify(dir));
});

test('env values never appear in the function logs', async () => {
  const t = await token(admin, 'work');
  const r = await fn('work', 'envcheck', { token: t });
  assert.deepEqual(r.body, { secret: 'hidden', named: 'work' });
  await new Promise((done) => setTimeout(done, 200)); // let the log row arrive

  const logs = (await admin.get('admin/apps/work/logs')).body.filter((l) => l.fn === 'envcheck');
  assert.ok(logs.length >= 1, 'the console.log line should be stored');
  assert.ok(logs.some((l) => l.message.includes('env-check work 14 chars')), JSON.stringify(logs));
  for (const l of (await admin.get('admin/apps/work/logs')).body) {
    assert.ok(!String(l.message).includes('s3cr3t-digits'), `the secret leaked into the logs: ${l.message}`);
  }
});

test('queue: 4 running plus 50 waiting per app, then 503', async () => {
  const t = await token(admin, 'work');
  const statuses = await Promise.all(Array.from({ length: 56 }, () => fn('work', 'slow', { token: t }).then((r) => r.status)));
  assert.equal(statuses.filter((s) => s === 503).length, 2, JSON.stringify(statuses));
  assert.ok(statuses.every((s) => s === 200 || s === 503), JSON.stringify(statuses));
});

test('a hung function is killed at the timeout and the next call works', async () => {
  await admin.put('admin/server', { functionTimeoutMs: 1500 });
  try {
    const hung = await fn('work', 'loop', { token: await token(admin, 'work') });
    assert.equal(hung.status, 500);
    assert.equal(hung.body.code, 'timed_out');
    await new Promise((done) => setTimeout(done, 300)); // the runner exits; the next call respawns it
    const next = await fn('work', 'kv', { token: await token(admin, 'work') });
    assert.equal(next.status, 200, JSON.stringify(next.body));
    assert.ok(next.body.hits >= 1);
  } finally {
    await admin.put('admin/server', { functionTimeoutMs: 30000 });
  }
});

test('public webhook: no token needed on the public listener for a public app', async () => {
  const anon = await fn('hooked', 'hello', { pub: true, method: 'GET' });
  assert.equal(anon.status, 200);
  assert.deepEqual(anon.body, { ok: true, user: false, method: 'GET', q: null });

  const withQuery = await fn('hooked', 'hello', { pub: true, method: 'GET', query: '?a=5' });
  assert.equal(withQuery.body.q, '5');

  // A token for another app is refused, a token for this app calls as its user.
  const wrong = await fn('hooked', 'hello', { pub: true, token: await token(admin, 'work') });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.code, 'wrong_app');
  const mine = await fn('hooked', 'hello', { pub: true, token: await token(sam, 'hooked') });
  assert.equal(mine.body.user, true);

  // The private listener always wants credentials, even for a public app.
  assert.equal((await fn('hooked', 'hello')).status, 401);
});
