/** Verifier finding: a grant to /Junction — where data\files\alice\Junction
 * is a junction pointing OUTSIDE the Drive — allowed reads and writes outside
 * the user's root. The virtual path model cannot see reparse points, so every
 * fs operation now resolves the real path of its target (or, for a new file,
 * the nearest existing ancestor — where any planted link must live) and
 * rejects anything that leaves the user's root (or the server data dir when
 * the root itself is planted); case-insensitive compare on win32.
 *
 * Covered arms: read, write, mkdir, delete, rename, copy in both directions,
 * a same-root inner link that must STAY allowed, the read-URL token path, and
 * the plain Drive surface (drive.js chokepoint). Deleting a planted link is
 * rejected with the rest — removing one is for the machine owner, not hub
 * code (documented in the README's honest-diffs area). Platform note: NTFS
 * junctions need no elevation, so the test plants them itself. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, cleanup } from './helpers.js';
import * as store from '../lib/store.js';
import * as fsops from '../lib/hub-fsops.js';
import * as drive from '../lib/drive.js';
import * as paths from '../lib/paths.js';

let running;
let aliceRoot;
let plantedJunction; // the one we plant and remove at cleanup
let plantedLinks = [];

const APP = 'probe';

function grantAll() {
  fsops.grant('alice', APP, '/', 'write', 'default');
}

/** Plant one junction under alice's Drive root. Returns nothing (cleanup is global). */
function plant(name, to) {
  const src = path.join(aliceRoot, name);
  fs.symlinkSync(to, src, 'junction');
  plantedLinks.push(src);
  return src;
}

const escapes = (e) => e && e.code === 'escapes_root' && e.status === 403;

before(async () => {
  running = await start();
  store.addUser('alice', 'alice-password');
  aliceRoot = store.userRoot('alice');
  fs.mkdirSync(aliceRoot, { recursive: true });
  fs.mkdirSync(path.join(aliceRoot, 'Documents'), { recursive: true });

  // The outside world: a real folder far from the server's data dir.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-outside-'));
  fs.writeFileSync(path.join(outside, 'victim.txt'), 'outside world');
  plantedJunction = outside; // remember only for cleanup bookkeeping

  plant('Junction', outside);
  // An inner link that points BACK INSIDE the root: allowed (same space).
  plant('InnerLoop', path.join(aliceRoot, 'Documents'));
  // Sandbox link: planted inside the app's own data dir.
  fs.mkdirSync(path.join(fsops.HUB_USERS_DIR, 'alice', APP), { recursive: true });
  fs.symlinkSync(outside, path.join(fsops.HUB_USERS_DIR, 'alice', APP, 'Link'), 'junction');
  plantedLinks.push(path.join(fsops.HUB_USERS_DIR, 'alice', APP, 'Link'));

  fs.writeFileSync(path.join(aliceRoot, 'Documents', 'ok.txt'), 'inside');
  grantAll();
});

after(() => {
  for (const l of plantedLinks) fs.rmSync(l, { force: true });
  if (plantedJunction && fs.existsSync(plantedJunction)) {
    try { fs.rmSync(plantedJunction, { recursive: true, force: true }); } catch { /* tmp */ }
  }
  cleanup(running);
});

test('read through an outside-pointing junction is rejected', async () => {
  await assert.rejects(
    () => fsops.read({ user: 'alice', app: APP, input: '/Junction/victim.txt' }),
    escapes,
  );
  // File 901: the leaf exists but only BEHIND the link — same verdict.
  await assert.rejects(
    () => fsops.stat({ user: 'alice', app: APP, input: '/Junction/victim.txt' }),
    escapes,
  );
});

test('write through an outside-pointing junction is rejected — new file and existing target', async () => {
  await assert.rejects(
    () => fsops.write({ user: 'alice', app: APP, input: '/Junction/new.txt', data: 'nope' }),
    escapes,
  );
  await assert.rejects(
    () => fsops.write({ user: 'alice', app: APP, input: '/Junction/victim.txt', data: 'clobber' }),
    escapes,
  );
});

test('mkdir through an outside-pointing junction is rejected', async () => {
  await assert.rejects(
    () => fsops.mkdir({ user: 'alice', app: APP, input: '/Junction/planted-here' }),
    escapes,
  );
});

test('delete through an outside-pointing junction is rejected (the link itself included)', async () => {
  await assert.rejects(
    () => fsops.del({ user: 'alice', app: APP, input: '/Junction/victim.txt' }),
    escapes,
  );
  await assert.rejects(
    () => fsops.del({ user: 'alice', app: APP, input: '/Junction' }),
    escapes,
  );
});

test('rename out of the link is rejected; rename INTO a link-named parent is rejected', async () => {
  await assert.rejects(
    () => fsops.rename({ user: 'alice', app: APP, from: '/Junction/victim.txt', newName: 'b.txt' }),
    escapes,
  );
  await assert.rejects(
    () => fsops.move({ user: 'alice', app: APP, source: '/Documents/ok.txt', destination: '/Junction/moved-in.txt' }),
    escapes,
  );
});

test('copy in both directions through the link is rejected', async () => {
  await assert.rejects(
    () => fsops.copy({ user: 'alice', app: APP, source: '/Junction/victim.txt', destination: '/Documents/out.txt' }),
    escapes,
  );
  await assert.rejects(
    () => fsops.copy({ user: 'alice', app: APP, source: '/Documents/ok.txt', destination: '/Junction/in.txt' }),
    escapes,
  );
});

test('a link pointing BACK INSIDE the root stays usable (containment, not a link ban)', async () => {
  const res = await fsops.write({ user: 'alice', app: APP, input: '/InnerLoop/inner.txt', data: 'fine' });
  assert.equal(res.path, '/InnerLoop/inner.txt');
  const buf = await fsops.read({ user: 'alice', app: APP, input: '/InnerLoop/inner.txt' });
  assert.equal(Buffer.from(buf).toString('utf8'), 'fine');
});

test('the sandbox arm: a link inside the app data dir cannot read or write outside', async () => {
  await assert.rejects(
    () => fsops.read({ user: 'alice', app: APP, input: 'Link/victim.txt' }),
    escapes,
  );
  await assert.rejects(
    () => fsops.write({ user: 'alice', app: APP, input: 'Link/out.txt', data: 'nope' }),
    escapes,
  );
});

test('ordinary paths keep working (no false positive from the containment pass)', async () => {
  const res = await fsops.write({ user: 'alice', app: APP, input: '/Documents/plain.txt', data: 'plain' });
  assert.equal(res.name, 'plain.txt');
  const buf = await fsops.read({ user: 'alice', app: APP, input: '/Documents/plain.txt' });
  assert.equal(Buffer.from(buf).toString('utf8'), 'plain');
  const listing = await fsops.readdir({ user: 'alice', app: APP, input: '/Documents' });
  assert.ok(listing.some((e) => e.name === 'plain.txt'));
});

test('the read-URL token cannot serve a path that resolves outside the root', async () => {
  // A token is bound to a virtual path, but the real file behind it is
  // re-checked here too: a link planted at drive level must not turn a
  // previously-issued read URL into a door outside the root.
  assert.throws(
    () => fsops.access({ user: 'alice', app: APP, input: '/Junction/victim.txt', need: 'read' }),
    escapes,
  );
  const token = fsops.readUrlToken({ user: 'alice', app: APP, virtualPath: '/Junction/victim.txt', expiresIn: 60 });
  // Tokens stay opaque: a containment failure serves the plain 404, never a
  // 403 that would confirm the target exists.
  let seen = null;
  const fakeRes = { writeHead(s) { seen = s; }, end(d) { seen = seen ?? d; } };
  const again = await fsops.serveReadToken({ method: 'GET', socket: {} }, fakeRes, token.token);
  assert.equal(again, undefined);
  assert.equal(seen, 404);
});

test('the plain Drive surface (drive.js) rejects through the same helper', () => {
  assert.throws(() => drive.ownerFull('alice', '/Junction/victim.txt'), escapes);
  assert.equal(drive.ownerFull('alice', '/Documents/ok.txt'), path.join(aliceRoot, 'Documents', 'ok.txt'));
});
