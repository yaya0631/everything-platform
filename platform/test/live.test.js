import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { DATA, start, cleanup, client } from './helpers.js';
import { Drawing } from '../../cad-home/app/src/core/drawing.js';
import { LiveSession } from '../../cad-home/app/src/collab/live.js';

let running, store, live, cadfile;
const clients = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 5000, what = 'condition') {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

before(async () => {
  running = await start();
  store = await import('../lib/store.js');
  live = await import('../lib/live.js');
  cadfile = await import('../lib/cadfile.js');
  live.timing.debounce = 40;
  live.timing.maxDelay = 200;
  live.timing.closeAfter = 200;
  for (const n of ['alex', 'sam', 'lee', 'kim']) {
    store.addUser(n, `${n}-password`);
    clients[n] = client(running.base);
    await clients[n].login(n, `${n}-password`);
  }
  const d = new Drawing();
  d.transaction('seed', () => {
    for (let i = 0; i < 20; i++) d.add({ type: 'line', layer: '0', x1: i, y1: 0, x2: i, y2: 10 });
  });
  const bytes = cadfile.encode(d.toJSON());
  const w = await clients.alex.call('PUT', 'fs/write?path=Drawings/live.cad', { body: bytes });
  assert.equal(w.status, 200);
  for (const [who, mode] of [['sam', 'edit'], ['lee', 'edit'], ['kim', 'view']]) {
    const r = await clients.alex.post('share/people', { path: '/Drawings/live.cad', user: who, mode });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
});
after(() => cleanup(running));

function join(who, drawPath) {
  const c = clients[who];
  const url = `ws://127.0.0.1:${running.privatePort}/api/live?path=${encodeURIComponent(drawPath)}`;
  const s = new LiveSession({
    url,
    createSocket: (u) => new WebSocket(u, { headers: { Origin: running.base, Cookie: c.cookie } }),
  });
  const me = { s, drawing: null, snapshots: 0, closed: null };
  s.on('snapshot', (data) => {
    me.drawing = new Drawing(data);
    me.snapshots++;
    s.attach(me.drawing);
  });
  s.on('closed', (r) => (me.closed = r));
  s.connect();
  return me;
}

function stateOf(drawing) {
  const header = { ...drawing.header };
  delete header.nextId;
  return JSON.stringify({ ents: [...drawing.entities.values()], layers: [...drawing.layers.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)), header, blocks: [...drawing.blocks.keys()] });
}

function diskState() {
  const data = cadfile.decode(fs.readFileSync(path.join(DATA, 'files', 'alex', 'Drawings', 'live.cad')));
  return stateOf(new Drawing(data));
}

function randomEdit(me, rnd) {
  const d = me.drawing;
  const ids = [...d.entities.keys()];
  const pick = () => ids[Math.floor(rnd() * ids.length)];
  const r = rnd();
  if (r < 0.3 || !ids.length) d.transaction('add', () => d.add({ type: 'circle', layer: '0', cx: rnd() * 100, cy: rnd() * 100, r: 1 + rnd() }));
  else if (r < 0.55) d.transaction('move', () => d.update(pick(), { x1: rnd() * 100 }));
  else if (r < 0.65) d.transaction('erase', () => d.remove(pick()));
  else if (r < 0.72) d.transaction('order', () => d.reorder([pick(), pick()], rnd() < 0.5));
  else if (r < 0.78) {
    const name = `L${Math.floor(rnd() * 3)}`;
    d.transaction('layer', () => d.setTable('layers', name, { name, color: Math.floor(rnd() * 7) + 1, on: true, frozen: false, locked: false, linetype: 'Continuous', lineweight: -3 }));
  } else if (r < 0.83) d.transaction('header', () => d.setHeader({ ltscale: Math.round(rnd() * 10) }));
  else if (r < 0.93) d.undo();
  else d.redo();
}

function seeded(seed) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    return x / 0x7fffffff;
  };
}

async function settle(people) {
  await until(() => people.every((p) => p.s.status !== 'connecting' && p.s.welcomed), 5000, 'everyone joined');
  await until(() => people.every((p) => p.s.outbox.every((b) => b.seq !== null)), 5000, 'acks');
  const room = live.getOpenRoom('alex', '/Drawings/live.cad');
  await until(() => people.every((p) => p.s.seq === room.seq), 5000, 'everyone caught up');
  people[0].s.flush();
  await until(() => room.savedSeq === room.seq && !room.saving && !room.dirty, 5000, 'saved');
  await sleep(150);
  await until(() => people.every((p) => p.s.outbox.length === 0), 5000, 'outboxes cleared');
}

test('three editors with concurrent random edits converge with each other and the file', async () => {
  const people = ['alex', 'sam', 'lee'].map((w) => join(w, w === 'alex' ? 'Drawings/live.cad' : '/@alex/Drawings/live.cad'));
  await until(() => people.every((p) => p.drawing), 5000, 'snapshots');
  assert.equal(people[1].s.you.mode, 'edit');
  const rnds = people.map((_, i) => seeded(1000 + i));
  for (let round = 0; round < 40; round++) {
    for (let i = 0; i < people.length; i++) for (let k = 0; k < 3; k++) randomEdit(people[i], rnds[i]);
    await sleep(round % 5 === 0 ? 15 : 0);
  }
  await settle(people);
  const states = people.map((p) => stateOf(p.drawing));
  const show = (a, b) => {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return `${a.slice(Math.max(0, i - 200), i + 200)}\n  vs\n${b.slice(Math.max(0, i - 200), i + 200)}`;
  };
  if (states[1] !== states[0]) console.log('SAM DIFF', show(states[0], states[1]));
  if (states[2] !== states[0]) console.log('LEE DIFF', show(states[0], states[2]));
  assert.equal(states[1], states[0], 'sam matches alex');
  assert.equal(states[2], states[0], 'lee matches alex');
  // Loading a file fills in default fields, so compare like with like.
  assert.equal(diskState(), stateOf(new Drawing(JSON.parse(JSON.stringify(people[0].drawing.toJSON())))), 'the file matches');
  // Ids from leases never collide.
  const all = people.flatMap((p) => [...p.drawing.entities.keys()]);
  assert.ok(all.every((id) => Number.isFinite(id)));
  for (const p of people) p.s.close();
});

test('view-only people cannot edit; writes to a live file are refused', async () => {
  const alex = join('alex', 'Drawings/live.cad');
  const kim = join('kim', '/@alex/Drawings/live.cad');
  await until(() => alex.drawing && kim.drawing, 5000, 'snapshots');
  assert.equal(kim.s.mode, 'view');
  assert.equal(kim.drawing.readOnly, true);
  assert.throws(() => kim.drawing.transaction('x', () => kim.drawing.add({ type: 'point', x: 0, y: 0 })), /view-only/);
  // A hand-made op from a view-only socket is denied.
  const raw = new WebSocket(`ws://127.0.0.1:${running.privatePort}/api/live?path=${encodeURIComponent('/@alex/Drawings/live.cad')}`, { headers: { Origin: running.base, Cookie: clients.kim.cookie } });
  const msgs = [];
  raw.on('message', (m) => msgs.push(JSON.parse(m)));
  await new Promise((r) => raw.on('open', r));
  raw.send(JSON.stringify({ t: 'hello', client: 'x' }));
  await until(() => msgs.some((m) => m.t === 'welcome'));
  raw.send(JSON.stringify({ t: 'ops', cseq: 1, ops: [{ k: 'ent', id: 1, v: null }] }));
  await until(() => msgs.some((m) => m.t === 'denied'));
  raw.close();
  // Another origin cannot open a live socket with the cookie.
  const evil = new WebSocket(`ws://127.0.0.1:${running.privatePort}/api/live?path=Drawings/live.cad`, { headers: { Origin: 'http://evil.example', Cookie: clients.alex.cookie } });
  const status = await new Promise((r) => evil.on('unexpected-response', (_req, res) => r(res.statusCode)));
  assert.equal(status, 403);
  const put = await clients.alex.call('PUT', 'fs/write?path=Drawings/live.cad', { body: 'x' });
  assert.equal(put.status, 409);
  assert.equal(put.body.code, 'live_session');
  // Removing kim's share drops them.
  await clients.alex.del('share/people', { path: '/Drawings/live.cad', user: 'kim' });
  await until(() => kim.closed === 'access_removed', 5000, 'kim dropped');
  alex.s.close();
});

test('reconnect replays missed changes, or resends local edits after a snapshot', async () => {
  const alex = join('alex', 'Drawings/live.cad');
  const sam = join('sam', '/@alex/Drawings/live.cad');
  await until(() => alex.drawing && sam.drawing && alex.s.welcomed && sam.s.welcomed, 5000, 'joined');
  // Replay: sam drops, alex edits, sam comes back with resume.
  sam.s.ws.terminate();
  alex.drawing.transaction('add', () => alex.drawing.add({ type: 'point', layer: '0', x: 1, y: 2 }));
  await sleep(50);
  await until(() => sam.s.welcomed, 8000, 'sam back');
  assert.equal(sam.snapshots, 1, 'no snapshot needed');
  // Snapshot: sam drops, edits while offline, and the resume is impossible.
  sam.s.ws.terminate();
  await sleep(20);
  sam.drawing.transaction('offline', () => sam.drawing.add({ type: 'point', layer: '0', x: 9, y: 9 }));
  sam.s.instance = 'bogus';
  await until(() => sam.s.welcomed && sam.snapshots === 2, 8000, 'sam snapshot');
  await settle([alex, sam]);
  assert.equal(stateOf(sam.drawing), stateOf(alex.drawing));
  assert.ok([...alex.drawing.entities.values()].some((e) => e.type === 'point' && e.x === 9));
  assert.equal(diskState(), stateOf(new Drawing(JSON.parse(JSON.stringify(alex.drawing.toJSON())))));

  // Undo never reverts someone else's newer change.
  const id = [...alex.drawing.entities.keys()][0];
  alex.drawing.transaction('mine', () => alex.drawing.update(id, { x1: 111 }));
  await settle([alex, sam]);
  sam.drawing.transaction('theirs', () => sam.drawing.update(id, { x1: 222 }));
  await settle([alex, sam]);
  alex.drawing.undo();
  assert.equal(alex.drawing.lastSkipped, true);
  await settle([alex, sam]);
  assert.equal(alex.drawing.get(id).x1, 222);
  assert.equal(sam.drawing.get(id).x1, 222);
  alex.s.close();
  sam.s.close();
});

test('deleting a live drawing closes the room', async () => {
  const alex = join('alex', 'Drawings/live.cad');
  const sam = join('sam', '/@alex/Drawings/live.cad');
  await until(() => alex.s.welcomed && sam.s.welcomed, 5000, 'joined');
  const hist = await clients.sam.get(`history?path=${encodeURIComponent('/@alex/Drawings/live.cad')}`);
  assert.equal(hist.status, 200);
  assert.ok(hist.body.length >= 1);
  const r = await clients.alex.del('fs/delete?path=Drawings/live.cad');
  assert.equal(r.status, 200);
  await until(() => alex.closed === 'deleted' && sam.closed === 'deleted', 5000, 'closed');
  assert.equal(fs.existsSync(path.join(DATA, 'files', 'alex', 'Drawings', 'live.cad')), false);
});
