/**
 * LAN peer relay and local event bus for hub apps.
 *
 * Hub apps ask for the Puter Peer API (chess/checkers/backgammon online games,
 * meetings, huddles). This server implements the part that needs a signaller:
 * it hands out invite codes, pairs one serving socket with joining sockets,
 * and relays opaque JSON frames between them. App messages and WebRTC
 * signalling share the same private WebSocket, so two people on the LAN can
 * play a game or hold a call without any cloud service.
 *
 * Data relays through this process (the "LAN relay"); audio/video uses a
 * direct RTCPeerConnection between the two browsers, negotiated over the same
 * socket. The relay never sees media: it only forwards SDP and ICE.
 *
 * Everything here is private-listener only (the hub itself is private), and
 * scoped to one installed app: an invite minted by chess cannot be dialled by
 * meetings. Invite codes are short-lived secrets; the server keeps no history.
 *
 * The same module serves `puter.events.onLocal` on /api/hub/events. Events
 * are per-person and per-app: a KV/fs write made by one of a person's sessions
 * wakes their other sessions. There are no cross-person shares here, so a
 * subscription to somebody else's key is refused honestly instead of
 * pretending to work.
 */
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import * as db from './db.js';
import * as store from './store.js';
import { HttpError, send, readJSONBody, requestOrigin } from './http.js';

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const MAX_FRAME = 96 * 1024;
const MAX_SERVERS_PER_USER = 8;
const MAX_CONNS_PER_INVITE = 8;
const MAX_GRANTS_PER_USER = 10;
const GRANT_TTL_MS = 60 * 60 * 1000;
const PEER_RATE = 400; // frames per 10 s, per socket
const PEER_RATE_WINDOW = 10_000;
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const invites = new Map(); // code -> invite
const conns = new Map(); // conn id -> connection record
const grants = new Map(); // grant token -> {user, app, expires}
const sockets = new Set(); // live WS, for shutdown
const peerWss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
const eventWss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
let heartbeat = null;

function deny(socket, status = 403, text = 'Forbidden') {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    /* the peer is already gone */
  }
  socket.destroy();
}

function sendJson(ws, value) {
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(value));
    } catch {
      /* the socket closed between the check and the write */
    }
  }
}

function sessionFor(req, registry) {
  const token = registry.sessionToken(req);
  const info = token ? store.sessionInfo(token) : null;
  if (!info) return null;
  const account = info.account || {};
  return {
    user: info.user,
    username: info.user,
    displayName: account.display_name || info.user,
    uuid: account.uuid || '',
    isAdmin: !!account.is_admin,
  };
}

function publicUser(session) {
  return {
    username: session.username,
    name: session.username,
    displayName: session.displayName,
    uuid: session.uuid,
  };
}

function appRow(app) {
  if (!app || !NAME_RE.test(app)) return null;
  return db.get('SELECT enabled, access, users FROM hub_apps WHERE name = ?', app) || null;
}

function appAllowed(app, session) {
  const row = appRow(app);
  if (!row || !row.enabled) return false;
  if (session && session.isAdmin) return true;
  if (row.access !== 'users') return true;
  try {
    return JSON.parse(row.users || '[]').includes(session.user);
  } catch {
    return false;
  }
}

function relayFrame(data) {
  if (data === undefined) return;
  // Keep the relay contract data-only: no control verbs can be smuggled in
  // from an app frame because the server only looks at the outer envelope.
  if (typeof data === 'string' && data.length > MAX_FRAME) return;
  try {
    if (JSON.stringify(data).length > MAX_FRAME) return;
  } catch {
    return;
  }
  return data;
}

function newInviteCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 8; i++) code += INVITE_ALPHABET[crypto.randomInt(INVITE_ALPHABET.length)];
    if (!invites.has(code)) return code;
  }
}

function newId() {
  return crypto.randomBytes(9).toString('hex');
}

function inviteForUser(user) {
  let count = 0;
  for (const invite of invites.values()) if (invite.user === user) count++;
  return count;
}

function closeConn(conn, reason, { notifyHost = false, notifyGuest = false, closeGuest = false } = {}) {
  if (!conn || conn.closed) return;
  conn.closed = true;
  const invite = invites.get(conn.invite);
  if (invite) invite.conns.delete(conn.id);
  conns.delete(conn.id);
  const message = { type: 'conn-closed', connId: conn.id, reason: reason || 'The connection closed.' };
  if (notifyHost) sendJson(conn.hostWs, message);
  if (notifyGuest) sendJson(conn.guestWs, message);
  if (closeGuest) {
    try {
      conn.guestWs?.close();
    } catch {
      /* already gone */
    }
  }
}

function closeInvite(invite, reason = 'The invite closed.') {
  if (!invite || invite.closed) return;
  invite.closed = true;
  invites.delete(invite.code);
  for (const conn of [...invite.conns.values()]) {
    closeConn(conn, reason, { notifyGuest: true, closeGuest: true });
  }
  invite.conns.clear();
}

function clientMeta(state, message) {
  const anon = typeof message?.anonToken === 'string' ? message.anonToken.slice(0, 200) : '';
  if (!state.session) {
    return { username: 'Guest', name: 'Guest', displayName: 'Guest', uuid: anon || `guest-${newId()}` };
  }
  const user = publicUser(state.session);
  // A caller that names itself (meetings' self-probe) keeps that name; it is
  // how the host tells its own probe apart from a real newcomer.
  if (anon) user.uuid = anon;
  return user;
}

function touch(state) {
  const now = Date.now();
  if (now - state.windowStart > PEER_RATE_WINDOW) {
    state.windowStart = now;
    state.window = 0;
  }
  state.window++;
  return state.window <= PEER_RATE;
}

function handleHost(state, message) {
  if (message.type === 'serve') {
    if (state.role) return sendJson(state.ws, { type: 'error', code: 'already_serving', message: 'This socket already serves an invite.' });
    if (!state.session) return sendJson(state.ws, { type: 'error', code: 'not_signed_in', message: 'Sign in to invite someone.' });
    if (inviteForUser(state.session.user) >= MAX_SERVERS_PER_USER) {
      return sendJson(state.ws, {
        type: 'error',
        code: 'too_many_servers',
        message: 'Too many open invites on this account. Close one and try again.',
      });
    }
    const invite = {
      code: newInviteCode(),
      hostWs: state.ws,
      app: state.app,
      user: state.session.user,
      session: state.session,
      conns: new Map(),
      createdAt: Date.now(),
      closed: false,
    };
    invites.set(invite.code, invite);
    state.role = 'host';
    state.invite = invite.code;
    return sendJson(state.ws, { type: 'served', inviteCode: invite.code });
  }

  if (message.type === 'relay') {
    const conn = conns.get(String(message.connId || ''));
    if (!conn || conn.hostWs !== state.ws) return;
    const data = relayFrame(message.data);
    if (data !== undefined) sendJson(conn.guestWs, { type: 'relay', data });
    return;
  }

  if (message.type === 'close-conn') {
    const conn = conns.get(String(message.connId || ''));
    if (!conn || conn.hostWs !== state.ws) return;
    closeConn(conn, String(message.reason || 'Closed by the host.').slice(0, 500), { notifyGuest: true, closeGuest: true });
    return;
  }

  if (message.type === 'close-server') {
    if (state.invite) closeInvite(invites.get(state.invite));
    try {
      state.ws.close();
    } catch {
      /* already gone */
    }
  }
}

function handleGuest(state, message) {
  const conn = state.conn;
  if (!conn) return;
  if (message.type === 'relay') {
    const data = relayFrame(message.data);
    if (data !== undefined) sendJson(conn.hostWs, { type: 'relay', connId: conn.id, data });
    return;
  }
  if (message.type === 'close') {
    closeConn(conn, String(message.reason || 'The other person left.').slice(0, 500), { notifyHost: true });
    state.conn = null;
    try {
      state.ws.close();
    } catch {
      /* already gone */
    }
  }
}

function handleJoin(state, message) {
  if (message.type !== 'join') {
    return sendJson(state.ws, { type: 'error', code: 'not_joined', message: 'Join an invite first.' });
  }
  const code = String(message.code || '').trim().toUpperCase().slice(0, 64);
  if (!/^[A-Z0-9]{4,64}$/.test(code)) {
    return sendJson(state.ws, { type: 'join-error', code: 'invalid_invite', message: 'Invalid invite code.' });
  }
  const invite = invites.get(code);
  if (!invite || invite.closed) {
    sendJson(state.ws, { type: 'join-error', code: 'invalid_invite', message: 'Invalid invite code.' });
    return state.ws.close();
  }
  if (invite.app !== state.app) {
    sendJson(state.ws, { type: 'join-error', code: 'invalid_invite', message: 'Invalid invite code.' });
    return state.ws.close();
  }
  if (state.grant && state.grant.user !== invite.user) {
    sendJson(state.ws, { type: 'join-error', code: 'invalid_invite', message: 'That grant is for a different host.' });
    return state.ws.close();
  }
  if (invite.conns.size >= MAX_CONNS_PER_INVITE) {
    sendJson(state.ws, { type: 'join-error', code: 'invite_full', message: 'This invite has no room left.' });
    return state.ws.close();
  }
  const user = clientMeta(state, message);
  const conn = {
    id: newId(),
    invite: invite.code,
    hostWs: invite.hostWs,
    guestWs: state.ws,
    hostUser: publicUser(invite.session),
    guestUser: user,
    createdAt: Date.now(),
    closed: false,
  };
  invite.conns.set(conn.id, conn);
  conns.set(conn.id, conn);
  state.role = 'guest';
  state.conn = conn;
  sendJson(state.ws, { type: 'joined', connId: conn.id, code: invite.code, host: conn.hostUser });
  sendJson(invite.hostWs, { type: 'connection', connId: conn.id, user });
}

function handleMessage(state, raw) {
  if (!touch(state)) {
    try {
      state.ws.close();
    } catch {
      /* already gone */
    }
    return;
  }
  let message;
  try {
    message = JSON.parse(String(raw));
  } catch {
    return sendJson(state.ws, { type: 'error', code: 'bad_frame', message: 'Frames are JSON objects.' });
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return sendJson(state.ws, { type: 'error', code: 'bad_frame', message: 'Frames are JSON objects.' });
  }
  if (state.role === 'host') return handleHost(state, message);
  if (state.role === 'guest') return handleGuest(state, message);
  if (message.type === 'serve') return handleHost(state, message);
  return handleJoin(state, message);
}

function cleanupPeer(state) {
  sockets.delete(state.ws);
  if (state.role === 'host' && state.invite) {
    closeInvite(invites.get(state.invite));
    state.invite = null;
  } else if (state.role === 'guest' && state.conn) {
    closeConn(state.conn, 'The other person disconnected.', { notifyHost: true });
    state.conn = null;
  }
}

function attachPeer(ws, meta) {
  const state = {
    ws,
    app: meta.app,
    session: meta.session,
    grant: meta.grant,
    role: null,
    invite: null,
    conn: null,
    windowStart: Date.now(),
    window: 0,
  };
  sockets.add(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => handleMessage(state, raw));
  ws.on('close', () => cleanupPeer(state));
  ws.on('error', () => cleanupPeer(state));
}

/* ------------------------------------------------------------------------- *
 * Events: onLocal
 * ------------------------------------------------------------------------- */

const eventSockets = new Set();
const subscriptions = new Map(); // subId -> {socket state, subject, includeValue, type, key/path}
let eventSeq = 0;

function normalizeEventSubject(raw) {
  const subject = String(raw || '').slice(0, 2048);
  if (!subject) return null;
  if (subject.startsWith('kv:')) {
    // kv:<key> is this app's own namespace. The explicit kv:<app>:<key> form
    // is accepted only when it names this app: there are no cross-app KV
    // shares on this server for events to follow.
    const rest = subject.slice(3);
    const colon = rest.indexOf(':');
    if (colon > 0) {
      const head = rest.slice(0, colon);
      const key = rest.slice(colon + 1);
      if (head === '__app__') return { type: 'kv', key };
      return { type: 'kv-app', app: head, key };
    }
    return { type: 'kv', key: rest };
  }
  if (subject.startsWith('fs:')) {
    const path = subject.slice(3);
    if (!path) return null;
    return { type: 'fs', path };
  }
  return { type: 'unknown' };
}

function subjectMatches(sub, event) {
  if (event.user !== sub.user) return false;
  if (sub.type === 'kv' && event.type === 'kv') {
    if (event.app !== sub.app) return false;
    // A flush is a gap for every key in this app, not just a literal "*".
    if (event.op === 'gap' && (event.key === '*' || !event.key)) return true;
    if (sub.key === '*' || sub.key === '') return true;
    if (sub.key.endsWith('*')) return event.key.startsWith(sub.key.slice(0, -1));
    return event.key === sub.key;
  }
  if (sub.type === 'fs' && event.type === 'fs') {
    // Sandbox paths belong to one installed app. A Drive path is the
    // person's own and may be watched from any of their apps.
    if (event.kind === 'sandbox' && event.app !== sub.app) return false;
    const paths = [event.path].concat(Array.isArray(event.aliases) ? event.aliases : []).filter((p) => typeof p === 'string');
    const subjectPath = sub.path;
    if (subjectPath === '*' || subjectPath === '' || subjectPath === '/') return true;
    const prefix = subjectPath.endsWith('*') ? subjectPath.slice(0, -1) : (subjectPath.endsWith('/') ? subjectPath : `${subjectPath}/`);
    return paths.some((p) => (subjectPath.endsWith('*') ? p.startsWith(prefix) : (p === subjectPath || p.startsWith(prefix))));
  }
  return false;
}

function dispatchEvent(event) {
  for (const sub of subscriptions.values()) {
    if (!subjectMatches(sub, event)) continue;
    const payload = {
      op: event.op,
      key: event.key,
      path: event.path,
      value: sub.includeValue ? event.value : undefined,
      type: event.type,
      at: Date.now(),
    };
    if (event.op === 'gap') payload.reason = event.reason || 'gap';
    sendJson(sub.socket, { type: 'event', id: sub.requestId, event: payload });
  }
}

/** A KV write by one of this person's sessions. Called by the hub data API. */
export function emitKv({ user, app, key, value, op = 'set', reason }) {
  if (!user || !app || typeof key !== 'string') return;
  dispatchEvent({ type: 'kv', user, app, key, value, op, reason });
}

/** A file change by one of this person's sessions. */
export function emitFs({ user, app, path: virtualPath, kind, op = 'set' }) {
  if (!user || typeof virtualPath !== 'string') return;
  const path = virtualPath.replace(/^\/+/, '') || '/';
  // Drive paths are emitted relative to the Drive root (`.mail/x`), but the
  // apps name them with their own username prefix (`/ana/.mail`). Both forms
  // are matched, so either subject style hears the same write.
  const aliases = kind === 'drive' ? [`/${user}/${path === '/' ? '' : path}`.replace(/\/$/, '')] : [];
  dispatchEvent({ type: 'fs', user, app, kind, path, aliases, op });
}

function handleEventMessage(state, raw) {
  if (!touch(state)) {
    try {
      state.ws.close();
    } catch {
      /* already gone */
    }
    return;
  }
  let message;
  try {
    message = JSON.parse(String(raw));
  } catch {
    return sendJson(state.ws, { type: 'error', code: 'bad_frame', message: 'Frames are JSON objects.' });
  }
  if (!message || typeof message !== 'object') return;
  if (message.type === 'sub') {
    const id = String(message.id || '');
    if (!id || id.length > 80) return;
    if (state.subs.size >= 200) {
      return sendJson(state.ws, { type: 'sub-error', id, code: 'too_many_subscriptions', message: 'Too many subscriptions on this page.' });
    }
    const normalized = normalizeEventSubject(message.subject);
    if (!normalized || normalized.type === 'unknown') {
      return sendJson(state.ws, { type: 'sub-error', id, code: 'subject_does_not_exist', message: 'That event subject is not supported here.' });
    }
    if (normalized.type === 'kv-app') {
      if (normalized.app !== state.app) {
        return sendJson(state.ws, { type: 'sub-error', id, code: 'subject_does_not_exist', message: 'Cross-app events are not available here.' });
      }
      normalized.type = 'kv';
    }
    const app = state.app;
    const sub = {
      id: `${++eventSeq}-${newId()}`,
      requestId: id,
      socket: state.ws,
      user: state.session.user,
      app,
      type: normalized.type,
      key: normalized.key,
      path: normalized.path,
      includeValue: !!message.includeValue,
      createdAt: Date.now(),
    };
    subscriptions.set(sub.id, sub);
    state.subs.add(sub.id);
    sendJson(state.ws, {
      type: 'sub-ok',
      id,
      subId: sub.id,
      subject: String(message.subject),
      anchor: Date.now(),
      match: normalized.type === 'fs' ? 'prefix' : (sub.key || '').endsWith('*') ? 'prefix' : 'exact',
      op: 'set|del|expire|gap',
      includeValue: sub.includeValue,
    });
    return;
  }
  if (message.type === 'unsub') {
    const subId = String(message.subId || '');
    const sub = subscriptions.get(subId);
    if (sub && sub.socket === state.ws) {
      subscriptions.delete(subId);
      state.subs.delete(subId);
      sendJson(state.ws, { type: 'unsub-ok', subId });
    }
    return;
  }
  if (message.type === 'ping') sendJson(state.ws, { type: 'pong' });
}

function attachEvents(ws, meta) {
  const state = { ws, app: meta.app, session: meta.session, subs: new Set(), windowStart: Date.now(), window: 0 };
  eventSockets.add(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => handleEventMessage(state, raw));
  const cleanup = () => {
    eventSockets.delete(ws);
    for (const id of state.subs) subscriptions.delete(id);
    state.subs.clear();
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
}

function grantValid(token) {
  const g = token && grants.get(token);
  if (!g) return null;
  if (g.expires < Date.now()) {
    grants.delete(token);
    return null;
  }
  return g;
}

function upgradePeer(req, socket, head, url, registry) {
  const origin = req.headers.origin;
  if (origin && origin !== requestOrigin(req)) return deny(socket);
  const app = url.searchParams.get('app');
  const session = sessionFor(req, registry);
  if (session) {
    if (!appAllowed(app, session)) return deny(socket);
  } else {
    const grant = grantValid(url.searchParams.get('grant'));
    if (!grant || grant.app !== app) return deny(socket);
    if (!appRow(app)?.enabled) return deny(socket);
    // No session: only joining through a host's grant is allowed.
    return peerWss.handleUpgrade(req, socket, head, (ws) => attachPeer(ws, { app, session: null, grant }));
  }
  return peerWss.handleUpgrade(req, socket, head, (ws) => attachPeer(ws, { app, session, grant: null }));
}

function upgradeEvents(req, socket, head, url, registry) {
  const origin = req.headers.origin;
  if (origin && origin !== requestOrigin(req)) return deny(socket);
  const app = url.searchParams.get('app');
  const session = sessionFor(req, registry);
  if (!session || !appAllowed(app, session)) return deny(socket);
  return eventWss.handleUpgrade(req, socket, head, (ws) => attachEvents(ws, { app, session }));
}

function startHeartbeat() {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    for (const ws of [...sockets, ...eventSockets]) {
      if (ws.isAlive === false) {
        try {
          ws.terminate();
        } catch {
          /* already gone */
        }
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* already gone */
      }
    }
  }, 30_000);
  heartbeat.unref?.();
}

function stopAll() {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  grants.clear();
  for (const invite of [...invites.values()]) closeInvite(invite, 'The server is shutting down.');
  for (const ws of [...sockets, ...eventSockets]) {
    try {
      ws.close();
    } catch {
      /* already gone */
    }
  }
}

/** The grant endpoint is a same-origin POST from a signed-in page. */
function assertSameOrigin(req) {
  if (req.headers.origin && req.headers.origin !== requestOrigin(req)) {
    throw new HttpError(403, 'bad_origin', 'Cross-origin requests are not allowed here.');
  }
  const site = req.headers['sec-fetch-site'];
  if (site && !['same-origin', 'none'].includes(site)) {
    throw new HttpError(403, 'bad_origin', 'Cross-site requests are not allowed here.');
  }
}

export function register(registry) {
  registry.upgradeMounts.private.push(['/api/hub/peer', (req, socket, head, url) => upgradePeer(req, socket, head, url, registry)]);
  registry.upgradeMounts.private.push(['/api/hub/events', (req, socket, head, url) => upgradeEvents(req, socket, head, url, registry)]);

  registry.api.add('POST', 'hub/peer/grant', async ({ req, res, user, account }) => {
    assertSameOrigin(req);
    if (!user) throw new HttpError(401, 'not_signed_in', 'Sign in to create a guest grant.');
    const body = (await readJSONBody(req, 4096)) || {};
    const app = body.app || new URL(req.url, 'http://x').searchParams.get('app');
    if (!appAllowed(app, { user, isAdmin: !!account?.is_admin })) throw new HttpError(404, 'not_found', 'No such app for this account.');
    let count = 0;
    for (const [token, g] of grants) {
      if (g.expires < Date.now()) grants.delete(token);
      else if (g.user === user) count++;
    }
    if (count >= MAX_GRANTS_PER_USER) {
      // Oldest first, so a stuck tab cannot lock the account out forever.
      let oldest = null;
      for (const [token, g] of grants) if (g.user === user && (!oldest || g.created < oldest.created)) oldest = { token, created: g.created };
      if (oldest) grants.delete(oldest.token);
    }
    const token = `pg1.${crypto.randomBytes(24).toString('base64url')}`;
    const grant = { token, user, app, account: account?.uuid || null, created: Date.now(), expires: Date.now() + GRANT_TTL_MS };
    grants.set(token, grant);
    return send(res, 200, {
      grant: token,
      expiresAt: Math.floor(grant.expires / 1000),
      app,
    });
  });

  registry.onShutdown?.(stopAll);
  startHeartbeat();
}
