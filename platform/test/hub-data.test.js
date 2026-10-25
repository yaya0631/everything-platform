/**
 * Phase-2 hub data layer, end to end: sandbox fs ops, Drive grants, read
 * tokens, kv semantics, honest AI answers and the data export — over HTTP
 * against the real server, with two people and two apps to prove isolation.
 */
import test from 'node:test';
import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, cleanup, client } from './helpers.js';
import * as hub from '../lib/hub.js';
import * as store from '../lib/store.js';
import * as config from '../lib/config.js';

const FIXTURE = 'test/fixtures/hub/fixture-dist';
const SHA40 = (c) => c.repeat(40);

let running;
before(async () => {
  running = await start();
  store.addUser('root', 'root-password', { admin: true });
  store.addUser('person1', 'person1-password');
  store.addUser('person2', 'person2-password');
  hub.installFromDist('alpha', FIXTURE, { sha: SHA40('a'), source: 'import', title: 'Alpha' });
  hub.installFromDist('beta', FIXTURE, { sha: SHA40('b'), source: 'import', title: 'Beta' });
});
after(() => cleanup(running));

const as = async (name) => {
  const c = client(running.base);
  await c.login(name, `${name}-password`);
  return c;
};

/** A small JSON api helper matching the shim's wire habits: app in the body. */
const hubPost = (c, route, json) => c.call('POST', `hub/${route}`, { json: { app: 'alpha', ...json } });
const hubBodyPut = (c, route, text, { headers = {} } = {}) =>
  c.call('PUT', `hub/${route}`, { body: text, headers, raw: true });

test('sandbox write/read/stat round-trip with puter-shaped entries', async () => {
  const c = await as('person1');
  const wr = await hubBodyPut(c, `fs/write?app=alpha&path=reports/a.txt&options=${encodeURIComponent('{}')}`, 'hello world');
  assert.equal(wr.status, 200);
  const entry = await wr.json();
  assert.equal(entry.name, 'a.txt');
  assert.equal(entry.path, 'reports/a.txt');
  assert.equal(entry.is_dir, false);
  assert.equal(entry.size, 'hello world'.length);
  assert.ok(entry.uid);
  assert.ok(entry.modified > 1_700_000_000_000);
  assert.ok(entry.created > 1_700_000_000_000);
  assert.equal(entry.writable, true);

  const rd = await c.get('hub/fs/read?app=alpha&path=reports/a.txt');
  assert.equal(rd.status, 200);
  assert.equal(rd.body, 'hello world');

  const st = await hubPost(c, 'fs/stat', { path: 'reports/a.txt' });
  assert.equal(st.status, 200);
  assert.equal(st.body.is_dir, false); // the shim maps this to .isdir/.isfile
  assert.equal(st.body.dirname, 'reports');
  assert.equal(st.body.type, 'file');

  // partially reading big content
  const part = await c.get('hub/fs/read?app=alpha&path=reports/a.txt&offset=6&byte_count=5');
  assert.equal(part.body, 'world');
});

test('readdir is a plain v1 list; mkdir auto-creates in app data (docs divergence)', async () => {
  const c = await as('person1');
  const list = await hubPost(c, 'fs/readdir', { path: '' });
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body));
  assert.ok(list.body.find((e) => e.name === 'reports'));

  // Inside the app's own folder, missing parents are made freely — the one
  // divergence from puter's strict mkdir(), documented in the README, because
  // easy-tier apps save to relative paths without creating folders first.
  const ok = await hubPost(c, 'fs/mkdir', { path: 'deep/nested/here' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.isdir ?? ok.body.is_dir, true);
  const dup = await hubPost(c, 'fs/mkdir', { path: 'deep/nested/here', options: { dedupeName: true } });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.name, 'here (1)');
});

test('sandbox writes auto-create parents; Drive writes stay strict', async () => {
  const c = await as('person1');
  // app data: the chain lands without any option (README divergence)
  const good = await hubBodyPut(c, `fs/write?app=alpha&path=meta/new/x.txt&options=${encodeURIComponent('{}')}`, 'x');
  assert.equal(good.status, 200);

  // the Drive keeps puter's documented default: parents must exist, or the
  // caller passes createMissingParents explicitly.
  await hubPost(c, 'grants', { path: '/Documents/made/by/app.txt', perms: 'write', source: 'picker-save' });
  const strict = await hubBodyPut(c, `fs/write?app=alpha&path=${encodeURIComponent('/Documents/made/by/app.txt')}&options=${encodeURIComponent('{}')}`, 'x');
  assert.equal(strict.status, 404);
  assert.equal((await strict.json()).code, 'missing_parent');
  const opted = await hubBodyPut(c, `fs/write?app=alpha&path=${encodeURIComponent('/Documents/made/by/app.txt')}&options=${encodeURIComponent(JSON.stringify({ createMissingParents: true }))}`, 'x');
  assert.equal(opted.status, 200);
});

test('rename, move, copy and delete follow puter semantics', async () => {
  const c = await as('person1');
  await hubPost(c, 'fs/rename', { path: 'reports/a.txt', newName: 'b.txt' });
  const listed = await hubPost(c, 'fs/readdir', { path: 'reports' });
  assert.ok(listed.body.find((e) => e.name === 'b.txt'));
  const moved = await hubPost(c, 'fs/move', { source: 'reports/b.txt', destination: 'deep/nested' });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.path, 'deep/nested/b.txt');
  const copied = await hubPost(c, 'fs/copy', { source: 'deep/nested/b.txt', destination: 'reports/c.txt' });
  assert.equal(copied.status, 200);
  const gone = await hubPost(c, 'fs/delete', { path: 'deep/nested/b.txt' });
  assert.equal(gone.status, 200);
  const after = await hubPost(c, 'fs/stat', { path: 'deep/nested/b.txt' });
  assert.equal(after.status, 404);
});

test('Drive paths are refused until a grant exists; other apps never inherit it', async () => {
  const c = await as('person1');
  const denied = await hubBodyPut(c, `fs/write?app=alpha&path=${encodeURIComponent('/Documents/shared.txt')}&options=${encodeURIComponent('{}')}`, 'secret');
  assert.equal(denied.status, 403);
  const deniedBody = await denied.json();
  assert.equal(deniedBody.code, 'no_permission_for_app');
  // The shim's consent overlay builds itself from this structured request:
  // which app, which Drive path, what it wanted to do — one exact prompt,
  // one offer to remember nothing silently.
  assert.deepEqual(deniedBody.grant_request, {
    app: 'alpha', path: '/Documents/shared.txt', need: 'write', action: 'save',
  });
  // The consent endpoint answers the same shape the overlay posts.
  const consentGrant = await hubPost(c, 'grants', { path: '/Documents/consented.txt', perms: 'write', source: 'consent' });
  assert.equal(consentGrant.status, 200);
  assert.equal(consentGrant.body.ok, true);

  // picker-save style grant: write on the exact file
  const grant = await hubPost(c, 'grants', { path: '/Documents/shared.txt', perms: 'write', source: 'picker-save' });
  assert.equal(grant.status, 200);
  assert.equal(grant.body.ok, true);

  const wr = await hubBodyPut(c, `fs/write?app=alpha&path=${encodeURIComponent('/Documents/shared.txt')}&options=${encodeURIComponent('{}')}`, 'secret');
  assert.equal(wr.status, 200);

  // read works through the same grant (write implies read)
  const rd = await c.get(`hub/fs/read?app=alpha&path=${encodeURIComponent('/Documents/shared.txt')}`);
  assert.equal(rd.body, 'secret');

  // beta has no grant for that path — its calls stay 403
  const cj = await as('person1'); // same person, other app
  const deniedBeta = await cj.get(`hub/fs/read?app=beta&path=${encodeURIComponent('/Documents/shared.txt')}`);
  assert.equal(deniedBeta.status, 403);

  // revoking closes it for alpha too
  const mine = await c.get('hub/grants');
  const row = mine.body.find((g) => g.app === 'alpha' && g.path === '/Documents/shared.txt');
  assert.ok(row);
  const rev = await c.call('DELETE', `hub/grants/${row.id}`, { json: {} });
  assert.equal(rev.status, 200);
  const closed = await c.get(`hub/fs/read?app=alpha&path=${encodeURIComponent('/Documents/shared.txt')}`);
  assert.equal(closed.status, 403);
});

test('read URLs are token files on /hub/f/; bad or expired tokens 404', async () => {
  const c = await as('person1');
  await hubPost(c, 'grants', { path: '/Documents/shared.txt', perms: 'write', source: 'picker-save' });
  const tok = await hubPost(c, 'fs/readurl', { path: '/Documents/shared.txt', expiresIn: 60 });
  assert.equal(tok.status, 200);
  assert.match(tok.body.url, /^\/hub\/f\//);
  const round = await fetch(`${running.base}${tok.body.url}`);
  assert.equal(round.status, 200);
  assert.equal(await round.text(), 'secret');

  const tampered = await fetch(`${running.base}${tok.body.url}x`);
  assert.equal(tampered.status, 404);
  const nope = await fetch(`${running.base}/hub/f/none.none`);
  assert.equal(nope.status, 404);
});

test('space counts Drive plus app data under the configured capacity', async () => {
  const c = await as('person1');
  const before = await c.get('hub/fs/space');
  assert.equal(before.status, 200);
  assert.ok(before.body.capacity > 0);
  assert.ok(before.body.percentage >= 0);

  // The quota must count the app's own data folder too, not just the Drive:
  // write a known-size file through a sandbox path and watch `used` jump.
  const blob = 'quota-probe'.repeat(373); // 4096 + 3 bytes, unambiguous size
  const wr = await hubBodyPut(c, `fs/write?app=alpha&path=${encodeURIComponent('quota-probe.bin')}&options=${encodeURIComponent('{}')}`, blob);
  assert.equal(wr.status, 200);

  const after = await c.get('hub/fs/space');
  assert.equal(after.status, 200);
  assert.ok(after.body.used >= before.body.used + 4096,
    `quota must count app data: used ${before.body.used} -> ${after.body.used} for a ${blob.length}-byte sandbox write`);
});

test('path classes: own-username alias reaches your Drive, another person\u2019s name is rejected', async () => {
  const c = await as('person1');
  // own name as an alias of the Drive root (video-studio style /<user>/…);
  // it is still a Drive path, so the usual grant applies first
  const grant = await hubPost(c, 'grants', { path: '/Documents/alias.txt', perms: 'write', source: 'picker-save' });
  assert.equal(grant.status, 200);
  const wr = await hubBodyPut(c, `fs/write?app=alpha&path=${encodeURIComponent('/person1/Documents/alias.txt')}&options=${encodeURIComponent(JSON.stringify({ createMissingParents: true }))}`, 'alias');
  assert.equal(wr.status, 200);
  const st = await hubPost(c, 'fs/stat', { path: '/Documents/alias.txt' });
  assert.equal(st.status, 200); // same file through the Documents alias

  // another person's name: not a folder name, a rejected path class
  const bad = await hubBodyPut(c, `fs/write?app=alpha&path=${encodeURIComponent('/person2/Documents/x.txt')}&options=${encodeURIComponent('{}')}`, 'x');
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, 'other_person');
  const badTilde = await hubPost(c, 'fs/stat', { path: '~/person2/escape' });
  assert.equal(badTilde.status, 400);
  assert.equal(badTilde.body.code, 'other_person');
});

test('another person never sees the first one\u2019s app data', async () => {
  const p2 = await as('person2');
  const rd = await p2.get(`hub/fs/read?app=alpha&path=${encodeURIComponent('reports/c.txt')}`);
  assert.equal(rd.status, 404); // their own sandbox, not person1\u2019s
  const list = await hubPost(p2, 'fs/readdir', { path: '' });
  assert.ok(!JSON.stringify(list.body).includes('c.txt'));
});

test('kv: exact get/set/del/list/add/incr/decr/update semantics and the size caps', async () => {
  const c = await as('person1');
  const k = (r) => r.body;

  let r = await hubPost(c, 'kv/get', { key: 'nothing' });
  assert.equal(k(r), null);

  r = await hubPost(c, 'kv/set', { key: 'greeting', value: { hello: 'world', n: 1 } });
  assert.equal(k(r), null); // puter.kv.set resolves null
  r = await hubPost(c, 'kv/get', { key: 'greeting' });
  assert.deepEqual(k(r), { hello: 'world', n: 1 });

  // list: keys by default; pairs with returnValues; glob filtering
  await hubPost(c, 'kv/set', { key: 'alpha.one', value: 1 });
  await hubPost(c, 'kv/set', { key: 'alpha.two', value: 2 });
  r = await hubPost(c, 'kv/list', { options: { pattern: 'alpha.*' } });
  assert.deepEqual(k(r), ['alpha.one', 'alpha.two']);
  r = await hubPost(c, 'kv/list', { options: { pattern: 'alpha.*', returnValues: true } });
  assert.deepEqual(k(r), [{ key: 'alpha.one', value: 1 }, { key: 'alpha.two', value: 2 }]);

  // The real puter contract: a pattern is a PREFIX match. A trailing '*' is
  // accepted and stripped (flat form and options form alike); a bare prefix
  // matches everything beneath it; '*' mid-pattern is NOT a glob.
  await hubPost(c, 'kv/set', { key: 'contact:a', value: 1 });
  await hubPost(c, 'kv/set', { key: 'contact:b', value: 2 });
  await hubPost(c, 'kv/set', { key: 'contact:star', value: 3 });
  r = await hubPost(c, 'kv/list', { pattern: 'contact:*' });
  assert.deepEqual(k(r), ['contact:a', 'contact:b', 'contact:star']);
  r = await hubPost(c, 'kv/list', { options: { pattern: 'contact' } });
  assert.deepEqual(k(r), ['contact:a', 'contact:b', 'contact:star']);
  r = await hubPost(c, 'kv/list', { options: { pattern: 'contact:st' } });
  assert.deepEqual(k(r), ['contact:star']);
  r = await hubPost(c, 'kv/list', { options: { pattern: 'c*tact:star' } });
  assert.deepEqual(k(r), []);
  r = await hubPost(c, 'kv/list', { options: { pattern: 'contact:star', as: 'entries' } });
  assert.deepEqual(k(r), [{ key: 'contact:star', value: 3 }]);
  r = await hubPost(c, 'kv/list', { options: { pattern: 'contact:star', as: 'values' } });
  assert.deepEqual(k(r), [3]);

  // add appends to a list
  r = await hubPost(c, 'kv/add', { key: 'log', value: 'first' });
  assert.deepEqual(k(r), ['first']);
  r = await hubPost(c, 'kv/add', { key: 'log', value: 'second' });
  assert.deepEqual(k(r), ['first', 'second']);

  // an array arg appends its ELEMENTS — cap-table's add(key, [obj]) revision
  // chain must read back [obj], never [[obj]]
  r = await hubPost(c, 'kv/add', { key: 'revs', value: [{ n: 1 }] });
  assert.deepEqual(k(r), [{ n: 1 }]);
  r = await hubPost(c, 'kv/add', { key: 'revs', value: [{ n: 2 }, 'tail'] });
  assert.deepEqual(k(r), [{ n: 1 }, { n: 2 }, 'tail']);
  r = await hubPost(c, 'kv/get', { key: 'revs' });
  assert.deepEqual(k(r), [{ n: 1 }, { n: 2 }, 'tail']);

  // incr/decr are numeric
  await hubPost(c, 'kv/set', { key: 'count', value: 10 });
  r = await hubPost(c, 'kv/incr', { key: 'count', value: 5 });
  assert.equal(k(r), 15);
  r = await hubPost(c, 'kv/decr', { key: 'count', value: 3 });
  assert.equal(k(r), 12);

  // update sets dot paths on an object, creating intermediates
  r = await hubPost(c, 'kv/update', { key: 'greeting', pathMap: { 'deep.edge': 'x' } });
  assert.equal(k(r).deep.edge, 'x');

  // del removes; deleting twice is fine
  await hubPost(c, 'kv/del', { key: 'alpha.one' });
  r = await hubPost(c, 'kv/get', { key: 'alpha.one' });
  assert.equal(k(r), null);
  r = await hubPost(c, 'kv/del', { key: 'alpha.one' });
  assert.equal(k(r), null);

  // cap errors, with the codes the SDK documents. Sizes are measured like
  // the store does: UTF-8 bytes of the value's JSON encoding (quotes count).
  r = await hubPost(c, 'kv/set', { key: undefined, value: 1 });
  assert.equal(r.body.code, 'key_undefined');
  r = await hubPost(c, 'kv/set', { key: 'x'.repeat(1025), value: 1 });
  assert.equal(r.body.code, 'key_too_large');
  r = await hubPost(c, 'kv/set', { key: 'big', value: 'y'.repeat(399 * 1024 + 1) });
  assert.equal(r.body.code, 'value_too_large');
  r = await hubPost(c, 'kv/set', { key: 'maxok', value: 'y'.repeat(399 * 1024 - 2) }); // +2 quotes = exactly 399*1024
  assert.equal(k(r), null);
  r = await hubPost(c, 'kv/get', { key: 'maxok' });
  assert.equal(k(r).length, 399 * 1024 - 2);
});

test('kv TTL hides rows once expired; everything survives by being a real row', async () => {
  const c = await as('person1');
  await hubPost(c, 'kv/set', { key: 'flash', value: 'soon gone' });
  await hubPost(c, 'kv/expire', { key: 'flash', ttlSeconds: 1 });
  let r = await hubPost(c, 'kv/get', { key: 'flash' });
  assert.equal(r.body, 'soon gone');
  await new Promise((ok) => setTimeout(ok, 1200));
  r = await hubPost(c, 'kv/get', { key: 'flash' });
  assert.equal(r.body, null);
  // listing skips expired ones too
  r = await hubPost(c, 'kv/list', { options: { pattern: 'flash*' } });
  assert.deepEqual(r.body, []);
});

test('kv is scoped per app: beta never sees alpha\u2019s values', async () => {
  const c = await as('person1');
  let r = await c.call('POST', 'hub/kv/get', { json: { app: 'beta', key: 'greeting' } });
  assert.equal(r.body, null);
});

test('ai.chat answers honestly without a configured model, streamed and plain', async () => {
  const c = await as('person1');
  let r = await hubPost(c, 'ai/chat', { messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(r.status >= 400);
  assert.ok(r.body.code); // no_default_model or a provider error — always a code

  // with the testing-only provider set as the default, the plain HTTP path
  // must actually answer (regression: it used to return without sending)
  config.set('hubAiDefaultModel', 'test:demo');
  r = await hubPost(c, 'ai/chat', { prompt: 'ping' });
  assert.equal(r.status, 200);
  assert.match(r.body?.message?.content || '', /^test-reply: ping/);
  config.set('hubAiDefaultModel', null);

  // streaming: the wire is 200 NDJSON with a typed error event, and it ends.
  const streamRes = await c.call('POST', 'hub/ai/chat', {
    json: { app: 'alpha', messages: [{ role: 'user', content: 'hi' }], stream: true },
    raw: true,
  });
  assert.equal(streamRes.status, 200);
  const text = await streamRes.text();
  const events = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(events.some((e) => e.type === 'error' && e.code));

  // promised engines answer with their exact install-engine shape
  r = await c.post('hub/ai/txt2img', { app: 'alpha' });
  assert.equal(r.body.code, 'engine_missing');
  assert.match(r.body.message, /engine|README/i);
});

test('the picker\x27s browse feeds it both roots with round-tripping paths', async () => {
  const c = await as('person1');
  const drive = await c.get('hub/fs/browse?app=alpha&root=drive&dir=/');
  assert.equal(drive.status, 200);
  assert.ok(drive.body.entries.some((e) => e.name === 'Documents' && e.is_dir));

  const sandbox = await c.get('hub/fs/browse?app=alpha&root=sandbox&dir=/');
  assert.equal(sandbox.status, 200);
  assert.ok(sandbox.body.entries.length > 0);
  for (const e of sandbox.body.entries) {
    assert.doesNotMatch(String(e.path), /^\//); // app-relative, round-trips
  }
  const sub = await c.get(`hub/fs/browse?app=alpha&root=sandbox&dir=${encodeURIComponent('reports')}`);
  assert.ok(sub.body.entries.some((e) => e.name === 'c.txt'));
  // the round trip: stat the path browse handed back
  const st = await hubPost(c, 'fs/stat', { path: sandbox.body.entries[0].path });
  assert.equal(st.status, 200);
});

test('Export my app data is a real zip with the app folders and kv pairs', async () => {
  const c = await as('person1');
  const res = await c.call('GET', 'hub/data/export', { raw: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /zip/);
  const head = Buffer.from(await res.arrayBuffer()).subarray(0, 16);
  assert.equal(head[0], 0x50); // PK
  assert.equal(head[1], 0x4b);
});

test('a directory pick grants the subtree, not the world around it', async () => {
  const c = await as('person1');
  const g = await hubPost(c, 'grants', { path: '/Documents/by-picker', perms: 'write', source: 'picker-dir' });
  assert.equal(g.status, 200);

  const inside = await hubBodyPut(c, `fs/write?app=alpha&path=${encodeURIComponent('/Documents/by-picker/sub/x.txt')}&options=${encodeURIComponent(JSON.stringify({ createMissingParents: true }))}`, 'x');
  assert.equal(inside.status, 200);

  const sibling = await hubBodyPut(c, `fs/write?app=alpha&path=${encodeURIComponent('/Documents/by-other.txt')}&options=${encodeURIComponent(JSON.stringify({ createMissingParents: true }))}`, 'x');
  assert.equal(sibling.status, 403);

  // prefix games do not widen a subtree: someone's ../ or exact-file tricks
  const escape = await hubPost(c, 'fs/stat', { path: '/Documents/by-picker/../by-other.txt' });
  assert.equal(escape.status, 400); // rejected as a path hazard, not just unauthorized
});

test('read URLs are refused for app-local files (app-private on purpose)', async () => {
  const c = await as('person1');
  const r = await hubPost(c, 'fs/readurl', { path: 'reports/c.txt', expiresIn: 60 });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'not_supported');
});

test('server-side guards: unknown app, disabled app and a forged Origin', async () => {
  const c = await as('person1');
  let r = await hubPost(c, 'fs/stat', { app: 'nosuch', path: 'x' });
  assert.equal(r.status, 404);

  const forged = await c.call('POST', 'hub/fs/mkdir', {
    json: { app: 'alpha', path: 'z' },
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(forged.status, 403);
  assert.equal(forged.body.code, 'bad_origin');
});
