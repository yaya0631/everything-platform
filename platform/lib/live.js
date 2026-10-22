/**
 * Live co-editing of .cad drawings. Every open of a server .cad joins a room;
 * the server holds the drawing in memory, applies everyone's changes in
 * arrival order (last writer wins per object) and writes the file to disk.
 *
 * Protocol (JSON over WebSocket), see the README and app/src/collab/live.js:
 *   C→S hello {name?, color?, client, resume?: {instance, seq}}
 *   S→C welcome {instance, you, seq, idRange, snapshot | replay, peers}
 *   C→S ops {cseq, ops}          S→C ack {cseq, seq} · remote {seq, cid, ops} · denied · reject
 *   C→S ids                      S→C idRange {range}
 *   C→S presence {cursor, sel}   S→C presence {cid, cursor, sel} · join {peer} · leave {cid}
 *   C→S getOrder                 S→C order {ids, seq}
 *   C→S flush                    S→C saved {seq, orderDigest} · error {code}
 *                                S→C closed {reason} · mode {mode}
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import * as store from './store.js';
import * as drive from './drive.js';
import * as cadfile from './cadfile.js';
import * as history from './history.js';
import * as shares from './shares.js';
import { HttpError, send, readJSONBody, cookies, isHttps, clientIp } from './http.js';

const MAX_PEOPLE = 25;
const MAX_OPS = 2000;
const MAX_MESSAGE = 4 * 1024 * 1024;
const BUFFER = 5000;
const LEASE = 10_000;
const SAVE_DEBOUNCE = 2000;
const SAVE_MAX_DELAY = 10_000;
const CLOSE_AFTER = 30_000;
const SNAPSHOT_EVERY = 30 * 60_000;
const LINK_SOCKETS = 30;
const WIN = process.platform === 'win32';
const fold = (p) => (WIN ? p.toLowerCase() : p);

/** Tests shorten the timings. */
export const timing = { debounce: SAVE_DEBOUNCE, maxDelay: SAVE_MAX_DELAY, closeAfter: CLOSE_AFTER };

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 1024 }, maxPayload: MAX_MESSAGE });
const rooms = new Map();
const linkSockets = new Map();

const keyOf = (owner, ownerRel) => `${owner}\0${fold(ownerRel)}`;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function validOp(op) {
  if (!isObj(op)) return false;
  switch (op.k) {
    case 'ent':
      return finite(op.id) && (op.v === null || (isObj(op.v) && typeof op.v.type === 'string' && op.v.id === op.id));
    case 'table':
      return cadfile.TABLES.includes(op.table) && typeof op.key === 'string' && op.key.length <= 512 && (op.v === null || (isObj(op.v) && typeof op.v.name === 'string'));
    case 'block':
      return typeof op.key === 'string' && op.key.length <= 512 && (op.v === null || (isObj(op.v) && typeof op.v.name === 'string' && Array.isArray(op.v.entities)));
    case 'header':
      return isObj(op.patch);
    case 'order':
      return Array.isArray(op.ids) && op.ids.length <= 1_000_000 && op.ids.every(finite) && typeof op.front === 'boolean';
    default:
      return false;
  }
}

class Room {
  constructor(owner, ownerRel, full) {
    this.owner = owner;
    this.ownerRel = ownerRel;
    this.full = full;
    this.key = keyOf(owner, ownerRel);
    this.instance = crypto.randomBytes(8).toString('hex');
    this.people = new Map();
    this.cidSeq = 0;
    this.seq = 0;
    this.savedSeq = 0;
    this.buffer = [];
    this.dirty = false;
    this.firstDirty = 0;
    this.saveTimer = null;
    this.closeTimer = null;
    this.saving = null;
    this.saveAgain = false;
    this.failures = 0;
    this.lastSave = null;
    this.lastSnapshot = Date.now();
    this.snapshotAfterSave = false;
    this.closed = false;
  }

  load(data) {
    this.header = { ...(data.header || {}) };
    this.entities = new Map();
    let maxId = 0;
    for (const e of data.entities) {
      this.entities.set(e.id, e);
      if (e.id > maxId) maxId = e.id;
    }
    this.tables = {};
    for (const t of cadfile.TABLES) this.tables[t] = new Map((data[t] || []).map((x) => [x.name, x]));
    this.blocks = new Map((data.blocks || []).map((b) => [b.name, b]));
    this.floor = Math.max(maxId + 1, finite(this.header.nextId) ? this.header.nextId : 1);
  }

  toJSON() {
    return {
      version: 1,
      header: { ...this.header, nextId: this.floor },
      layers: [...this.tables.layers.values()],
      linetypes: [...this.tables.linetypes.values()],
      textStyles: [...this.tables.textStyles.values()],
      dimStyles: [...this.tables.dimStyles.values()],
      blocks: [...this.blocks.values()],
      entities: [...this.entities.values()],
    };
  }

  lease() {
    const range = [this.floor, this.floor + LEASE];
    this.floor += LEASE;
    return range;
  }

  apply(op) {
    switch (op.k) {
      case 'ent':
        if (op.v === null) this.entities.delete(op.id);
        else this.entities.set(op.id, op.v);
        if (op.id >= this.floor && op.id < 2 ** 52) this.floor = Math.floor(op.id) + 1;
        break;
      case 'table':
        if (op.v === null) this.tables[op.table].delete(op.key);
        else this.tables[op.table].set(op.key, op.v);
        break;
      case 'block':
        if (op.v === null) this.blocks.delete(op.key);
        else this.blocks.set(op.key, op.v);
        break;
      case 'header': {
        const patch = { ...op.patch };
        delete patch.nextId;
        this.header = { ...this.header, ...patch };
        break;
      }
      case 'order': {
        const set = new Set(op.ids);
        const ids = [...this.entities.keys()];
        const moved = ids.filter((id) => set.has(id));
        const rest = ids.filter((id) => !set.has(id));
        const next = op.front ? rest.concat(moved) : moved.concat(rest);
        this.entities = new Map(next.map((id) => [id, this.entities.get(id)]));
        break;
      }
    }
  }

  broadcast(msg, except = null) {
    const text = JSON.stringify(msg);
    for (const p of this.people.values()) if (p !== except && p.ws.readyState === 1) p.ws.send(text);
  }

  peer(p) {
    return { cid: p.cid, name: p.name, color: p.color, mode: p.mode, guest: !p.user, cursor: p.cursor ?? null, sel: p.sel ?? [] };
  }

  markDirty() {
    this.dirty = true;
    const now = Date.now();
    if (!this.firstDirty) this.firstDirty = now;
    if (now - this.lastSnapshot >= SNAPSHOT_EVERY) {
      this.lastSnapshot = now;
      this.snapshotAfterSave = true;
    }
    clearTimeout(this.saveTimer);
    const delay = Math.max(0, Math.min(timing.debounce, this.firstDirty + timing.maxDelay - now));
    this.saveTimer = setTimeout(() => this.save(), delay);
  }

  /** Write the drawing to disk now (if anything changed). */
  save() {
    if (this.saving) {
      this.saveAgain = true;
      return this.saving;
    }
    if (!this.dirty || this.closed) return Promise.resolve();
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const seq = this.seq;
    const ids = [...this.entities.keys()];
    const bytes = cadfile.encode(this.toJSON());
    this.dirty = false;
    this.firstDirty = 0;
    this.saving = (async () => {
      const tmp = `${this.full}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      try {
        await fsp.mkdir(path.dirname(this.full), { recursive: true, mode: 0o700 });
        await fsp.writeFile(tmp, bytes, { mode: 0o600 });
        if (this.closed) throw Object.assign(new Error('closed'), { code: 'CLOSED' });
        await fsp.rename(tmp, this.full);
        this.savedSeq = Math.max(this.savedSeq, seq);
        this.lastSave = Date.now();
        if (this.failures) this.broadcast({ t: 'error', code: 'save_ok' });
        this.failures = 0;
        this.broadcast({ t: 'saved', seq, orderDigest: cadfile.orderDigest(ids) });
        if (this.snapshotAfterSave) {
          this.snapshotAfterSave = false;
          history.snapshotBytes(this.owner, this.ownerRel, bytes, 'activity', null).catch((err) => console.warn('Snapshot:', err.message));
        }
      } catch (err) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        if (err.code === 'CLOSED') return;
        this.failures++;
        this.dirty = true;
        console.error(`Could not save ${this.owner}${this.ownerRel}:`, err.message);
        this.broadcast({ t: 'error', code: 'save_failed', message: "Changes aren't being saved on the server." });
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.save(), Math.min(60_000, 1000 * 2 ** this.failures));
      }
    })().finally(() => {
      this.saving = null;
      if (this.saveAgain) {
        this.saveAgain = false;
        if (this.dirty && !this.failures) this.save();
      }
    });
    return this.saving;
  }

  async flush() {
    while (this.saving) await this.saving;
    if (this.dirty) await this.save();
    while (this.saving) await this.saving;
  }

  /** Drop everyone and forget the room. */
  async close(reason, { save = true } = {}) {
    if (save) await this.flush().catch(() => {});
    this.closed = true;
    clearTimeout(this.saveTimer);
    clearTimeout(this.closeTimer);
    for (const p of this.people.values()) dropPerson(p, reason);
    this.people.clear();
    if (rooms.get(this.key) === this) rooms.delete(this.key);
    while (this.saving) await this.saving.catch(() => {});
  }

  scheduleClose() {
    clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(async () => {
      if (this.people.size) return;
      await this.flush().catch(() => {});
      if (this.people.size || this.closed) return;
      this.closed = true;
      if (rooms.get(this.key) === this) rooms.delete(this.key);
    }, timing.closeAfter);
    this.closeTimer.unref?.();
  }
}

function dropPerson(p, reason) {
  try {
    if (p.ws.readyState === 1) p.ws.send(JSON.stringify({ t: 'closed', reason }));
    p.ws.close(4000, reason);
  } catch {
    /* already gone */
  }
}

const loading = new Map();

async function getRoom(owner, ownerRel, full, by) {
  const key = keyOf(owner, ownerRel);
  const existing = rooms.get(key);
  if (existing && !existing.closed) return existing;
  if (loading.has(key)) return loading.get(key);
  const p = (async () => {
    const stat = await fsp.stat(full).catch(() => null);
    if (!stat?.isFile()) throw new HttpError(404, 'not_found', 'That drawing was not found on the server.');
    if (stat.size > drive.MAX_FILE) throw new HttpError(413, 'too_large', 'That drawing is too large for live editing.');
    const bytes = await fsp.readFile(full);
    const room = new Room(owner, ownerRel, full);
    try {
      room.load(cadfile.decode(bytes));
    } catch (err) {
      throw new HttpError(422, 'bad_drawing', err.message);
    }
    await history.snapshotBytes(owner, ownerRel, bytes, 'opened', by).catch((err) => console.warn('Snapshot:', err.message));
    rooms.set(key, room);
    return room;
  })().finally(() => loading.delete(key));
  loading.set(key, p);
  return p;
}

// Joining --------------------------------------------------------------------------------

export function rejectUpgrade(socket, status, message) {
  const body = JSON.stringify({ code: 'rejected', message });
  socket.write(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : 'Bad Request'}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  socket.destroy();
}

/** Private listener: cookie session, same-origin only. */
export function upgradePrivate(req, socket, head, url) {
  const origin = req.headers.origin;
  let ok = false;
  try {
    const o = new URL(origin);
    ok = o.host === req.headers.host && (o.protocol === 'https:' || (o.protocol === 'http:' && !isHttps(req)));
  } catch {
    ok = false;
  }
  if (!ok) return rejectUpgrade(socket, 403, 'Live editing must be opened from the CAD app.');
  const token = cookies(req).cad_session;
  const session = store.sessionInfo(token);
  if (!session) return rejectUpgrade(socket, 401, 'Sign in to edit live.');
  let t;
  try {
    t = drive.resolve(session.user, url.searchParams.get('path'), 'view');
  } catch (err) {
    return rejectUpgrade(socket, err.status || 400, err.message);
  }
  if (!t.ownerRel.toLowerCase().endsWith('.cad')) return rejectUpgrade(socket, 400, 'Only .cad drawings can be edited live.');
  wss.handleUpgrade(req, socket, head, (ws) => {
    const a = session.account;
    attach(ws, { owner: t.owner, ownerRel: t.ownerRel, full: t.full, mode: t.mode === 'view' ? 'view' : 'edit', user: session.user, token, name: a.display_name || a.name, color: a.color || store.defaultColor(a.name), link: null });
  });
}

/** Public listener: a share link, no cookies. */
export function upgradeLink(req, socket, head, link) {
  const open = linkSockets.get(link.token) || 0;
  if (open >= LINK_SOCKETS) return rejectUpgrade(socket, 429, 'Too many people are using this link right now.');
  let full;
  try {
    full = drive.ownerFull(link.owner, link.path);
  } catch (err) {
    return rejectUpgrade(socket, 400, err.message);
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    linkSockets.set(link.token, (linkSockets.get(link.token) || 0) + 1);
    ws.once('close', () => {
      const n = (linkSockets.get(link.token) || 1) - 1;
      if (n > 0) linkSockets.set(link.token, n);
      else linkSockets.delete(link.token);
    });
    attach(ws, { owner: link.owner, ownerRel: link.path, full, mode: link.mode, user: null, token: null, name: null, color: null, link: link.token, ip: clientIp(req) });
  });
}

const cleanName = (s) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40);

function attach(ws, who) {
  let p = null;
  let room = null;
  const sendTo = (msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
  const helloTimer = setTimeout(() => ws.close(4001, 'no hello'), 15_000);
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', async (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (!isObj(msg)) return;
    if (!p) {
      if (msg.t !== 'hello' || room) return;
      clearTimeout(helloTimer);
      room = 'joining';
      try {
        room = await getRoom(who.owner, who.ownerRel, who.full, who.user);
      } catch (err) {
        sendTo({ t: 'error', code: err.code || 'open_failed', message: err.message });
        return ws.close(4004, 'open failed');
      }
      if (ws.readyState !== 1) return;
      if (room.people.size >= MAX_PEOPLE) {
        sendTo({ t: 'error', code: 'room_full', message: `${MAX_PEOPLE} people are already editing this drawing.` });
        return ws.close(4003, 'full');
      }
      clearTimeout(room.closeTimer);
      const guestName = cleanName(msg.name) || 'Guest';
      p = {
        ws,
        cid: `c${++room.cidSeq}`,
        client: typeof msg.client === 'string' ? msg.client.slice(0, 64) : null,
        user: who.user,
        token: who.token,
        link: who.link,
        name: who.user ? who.name : `${guestName} (guest)`,
        color: who.user ? who.color : store.validColor(msg.color) ? msg.color : store.defaultColor(guestName),
        mode: who.mode,
        cursor: null,
        sel: [],
      };
      const welcome = { t: 'welcome', instance: room.instance, you: room.peer(p), seq: room.seq, savedSeq: room.savedSeq, idRange: room.lease(), peers: [...room.people.values()].map((x) => room.peer(x)) };
      const r = isObj(msg.resume) ? msg.resume : null;
      const canReplay = r && r.instance === room.instance && Number.isInteger(r.seq) && r.seq <= room.seq && (r.seq === room.seq || (room.buffer.length && room.buffer[0].seq <= r.seq + 1));
      if (canReplay) welcome.replay = room.buffer.filter((b) => b.seq > r.seq);
      else welcome.snapshot = room.toJSON();
      room.people.set(p.cid, p);
      sendTo(welcome);
      room.broadcast({ t: 'join', peer: room.peer(p) }, p);
      return;
    }
    handle(room, p, msg, sendTo);
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    if (!p || !room || typeof room === 'string') return;
    if (room.people.get(p.cid) === p) {
      room.people.delete(p.cid);
      room.broadcast({ t: 'leave', cid: p.cid });
      if (!room.people.size && !room.closed) room.scheduleClose();
    }
  });
  ws.on('error', () => {});
}

function handle(room, p, msg, sendTo) {
  switch (msg.t) {
    case 'ops': {
      const cseq = msg.cseq;
      if (p.mode === 'view') return sendTo({ t: 'denied', cseq, message: 'This drawing is view-only for you.' });
      const ops = msg.ops;
      if (!Array.isArray(ops) || !ops.length || ops.length > MAX_OPS || !ops.every(validOp)) return sendTo({ t: 'reject', cseq });
      for (const op of ops) room.apply(op);
      const seq = ++room.seq;
      room.buffer.push({ seq, cid: p.cid, client: p.client, cseq, ops });
      if (room.buffer.length > BUFFER) room.buffer.splice(0, room.buffer.length - BUFFER);
      sendTo({ t: 'ack', cseq, seq });
      room.broadcast({ t: 'remote', seq, cid: p.cid, ops }, p);
      room.markDirty();
      return;
    }
    case 'ids':
      return sendTo({ t: 'idRange', range: room.lease() });
    case 'presence': {
      const c = msg.cursor;
      p.cursor = isObj(c) && finite(c.x) && finite(c.y) ? { x: c.x, y: c.y } : null;
      p.sel = Array.isArray(msg.sel) ? msg.sel.filter(finite).slice(0, 500) : [];
      room.broadcast({ t: 'presence', cid: p.cid, cursor: p.cursor, sel: p.sel }, p);
      return;
    }
    case 'getOrder':
      return sendTo({ t: 'order', ids: [...room.entities.keys()], seq: room.seq });
    case 'flush':
      room.markDirty();
      room.save();
      return;
    case 'ping':
      return sendTo({ t: 'pong' });
  }
}

// Keep-alive: drop sockets that stopped answering (a laptop lid closed, a phone asleep).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* closing */
    }
  }
}, 30_000);
heartbeat.unref();

// Access changes ------------------------------------------------------------------------

function revalidateRoom(room) {
  for (const p of [...room.people.values()]) {
    if (p.link) {
      if (!shares.getLink(p.link)) {
        room.people.delete(p.cid);
        room.broadcast({ t: 'leave', cid: p.cid });
        dropPerson(p, 'revoked');
      }
      continue;
    }
    const session = store.sessionInfo(p.token);
    const mode = session ? drive.accessMode(p.user, room.owner, room.ownerRel) : null;
    if (!mode) {
      room.people.delete(p.cid);
      room.broadcast({ t: 'leave', cid: p.cid });
      dropPerson(p, 'access_removed');
      continue;
    }
    const next = mode === 'view' ? 'view' : 'edit';
    if (next !== p.mode) {
      p.mode = next;
      p.ws.send(JSON.stringify({ t: 'mode', mode: next }));
      room.broadcast({ t: 'join', peer: room.peer(p) }, p);
    }
  }
  if (!room.people.size && !room.closed) room.scheduleClose();
}

/** After a share under owner/ownerRel changed. */
export function revalidate(owner, ownerRel) {
  for (const room of rooms.values()) if (room.owner === owner && drive.within(room.ownerRel, ownerRel)) revalidateRoom(room);
}

export function revalidateAll() {
  for (const room of rooms.values()) revalidateRoom(room);
}

export function closeLink(token, reason) {
  for (const room of rooms.values()) {
    for (const p of [...room.people.values()]) {
      if (p.link !== token) continue;
      room.people.delete(p.cid);
      room.broadcast({ t: 'leave', cid: p.cid });
      dropPerson(p, reason);
    }
    if (!room.people.size && !room.closed) room.scheduleClose();
  }
}

const revalidator = setInterval(() => {
  try {
    revalidateAll();
  } catch (err) {
    console.warn('Live access check:', err.message);
  }
}, 30_000);
revalidator.unref();

export function isLive(owner, ownerRel, prefix = false) {
  for (const room of rooms.values()) {
    if (room.closed || room.owner !== owner) continue;
    if (prefix ? drive.within(room.ownerRel, ownerRel) : fold(room.ownerRel) === fold(ownerRel)) return true;
  }
  return false;
}

export function listRooms() {
  return [...rooms.values()].map((r) => ({
    owner: r.owner,
    path: r.ownerRel,
    people: [...r.people.values()].map((p) => ({ name: p.name, mode: p.mode })),
    seq: r.seq,
    savedSeq: r.savedSeq,
    lastSave: r.lastSave,
    saveFailing: r.failures > 0,
  }));
}

export function getOpenRoom(owner, ownerRel) {
  const r = rooms.get(keyOf(owner, ownerRel));
  return r && !r.closed ? r : null;
}

export async function shutdown() {
  await Promise.all([...rooms.values()].map((r) => r.close('shutdown')));
}

drive.hooks.isLive = isLive;
drive.hooks.onDelete.push(async (owner, ownerRel) => {
  for (const room of [...rooms.values()]) if (room.owner === owner && drive.within(room.ownerRel, ownerRel)) await room.close('deleted', { save: false });
});

// Version history -----------------------------------------------------------------------

export function register(s) {
  const { api, upgradeMounts, onShutdown } = s;
  upgradeMounts.private.push(['/api/live', upgradePrivate]);
  onShutdown(shutdown);

  api.add('GET', 'history', async ({ res, url, user }) => {
    const t = drive.resolve(user, url.searchParams.get('path'), 'edit');
    return send(res, 200, history.list(t.owner, t.ownerRel));
  });

  api.add('GET', 'history/file', async ({ res, url, user }) => {
    const t = drive.resolve(user, url.searchParams.get('path'), 'edit');
    const row = history.find(t.owner, t.ownerRel, url.searchParams.get('id'));
    if (!row) throw new HttpError(404, 'not_found', 'That version is no longer kept.');
    const bytes = await history.read(row);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
    res.end(bytes);
  });

  api.add('POST', 'history/restore', async ({ req, res, user }) => {
    const b = (await readJSONBody(req)) || {};
    const t = drive.resolve(user, b.path, 'edit');
    const row = history.find(t.owner, t.ownerRel, b.id);
    if (!row) throw new HttpError(404, 'not_found', 'That version is no longer kept.');
    const bytes = await history.read(row);
    let data;
    try {
      data = cadfile.decode(bytes);
    } catch (err) {
      throw new HttpError(422, 'bad_drawing', err.message);
    }
    const room = getOpenRoom(t.owner, t.ownerRel);
    if (room) {
      await room.flush().catch(() => {});
      await history.snapshotBytes(t.owner, t.ownerRel, cadfile.encode(room.toJSON()), 'before restore', user);
      const floor = room.floor;
      room.load(data);
      room.floor = Math.max(room.floor, floor);
      room.seq++;
      room.buffer = [];
      room.dirty = true;
      await room.save();
      // Everyone reconnects and loads the restored drawing.
      for (const p of [...room.people.values()]) dropPerson(p, 'restored');
      room.people.clear();
      room.scheduleClose();
    } else {
      await history.snapshotFile(t.owner, t.ownerRel, t.full, 'before restore', user);
      await drive.writeFile(t, bytes);
    }
    store.audit(user, 'history.restored', { owner: t.owner, path: t.ownerRel, id: row.id, created: row.created });
    return send(res, 200, { ok: true });
  });
}
