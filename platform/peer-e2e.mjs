#!/usr/bin/env node
/**
 * Chromium acceptance for W2 against a throwaway hub:
 *
 *   peer data    two contexts serve/connect, exchange messages, see each
 *                other's owner, and one closes while the other is told why;
 *   peer media   both publish a fake camera+mic; the exposed RTCPeerConnection
 *                reaches connected, each side's `media` event carries a live
 *                audio and video track from the other, and unpublish says so;
 *   events       a second tab of the same person's session receives a KV write
 *                with its value, while the same write from another person is
 *                not delivered;
 *   errors       a dead invite rejects connect() with code invalid_invite.
 *
 * Run: node peer-e2e.mjs   (needs Chrome; evidence lands in peer-e2e-results.json)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, '.tmp-peer-e2e');
fs.rmSync(DATA, { recursive: true, force: true });
process.env.CAD_DATA_DIR = DATA;
process.env.CAD_TEST = '1';
const PORT = Number(process.env.PEER_E2E_PORT || 18191);
const PUB_PORT = PORT + 1;
const USER = 'peere2e';
const PASS = 'peer-e2e-pass-1';
const OTHER = 'peere2e-other';
const OTHER_PASS = 'peer-e2e-pass-2';
const chrome = [
  process.env.BROWSER_EXE,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean).find((p) => { try { fs.accessSync(p); return true; } catch { return false; } });
if (!chrome) throw new Error('Chrome is required for the peer E2E.');

const [server, store, hub] = await Promise.all([
  import('./server.js'), import('./lib/store.js'), import('./lib/hub.js'),
]);

const steps = [];
const check = (step, ok, detail = '') => {
  steps.push({ step, pass: !!ok, detail: String(detail).slice(0, 1600) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step}${detail ? `: ${String(detail).slice(0, 400)}` : ''}`);
};

async function login(base, username, password) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CAD-Request': '1' },
    body: JSON.stringify({ username, password }),
  });
  const token = (res.headers.get('set-cookie') || '').split(';')[0].split('=')[1];
  if (!res.ok || !token) throw new Error(`login ${username}: HTTP ${res.status}`);
  return token;
}

async function pageFor(browser, base, token, label) {
  const ctx = await browser.createBrowserContext();
  await ctx.overridePermissions(base, ['camera', 'microphone']);
  await ctx.setCookie({ name: 'cad_session', value: token, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  await page.goto(`${base}/h/peer-probe/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__peer && window.__peer.ready === true, { timeout: 45000 });
  return { ctx, page, errors };
}

const logsOf = (page) => page.evaluate(() => window.__peer.log);
const has = (log, kind, predicate = () => true) => log.some((e) => e.kind === kind && predicate(e.data));
async function waitLog(page, kind, predicate = () => true, timeout = 30000) {
  const started = Date.now();
  for (;;) {
    const log = await logsOf(page);
    const hit = log.find((e) => e.kind === kind && predicate(e.data));
    if (hit) return hit;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${kind}; log=${JSON.stringify(log.slice(-8))}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

let running;
let browser;
let hostCtx;
let guestCtx;
try {
  running = await server.startServer({ port: PORT, publicPort: PUB_PORT, host: '127.0.0.1', tls: null });
  store.addUser(USER, PASS, { admin: true });
  store.addUser(OTHER, OTHER_PASS);
  hub.installFromDist('peer-probe', path.join(here, 'test', 'fixtures', 'hub', 'peer-dist'), {
    sha: 'c'.repeat(40), source: 'import', title: 'Peer probe',
  });
  const base = `http://127.0.0.1:${running.privatePort}`;
  const hostToken = await login(base, USER, PASS);
  const guestToken = await login(base, OTHER, OTHER_PASS);
  check('throwaway accounts sign in', !!hostToken && !!guestToken, `host=${!!hostToken} guest=${!!guestToken}`);

  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: [
      '--no-first-run',
      '--mute-audio',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const host = await pageFor(browser, base, hostToken, 'host');
  const guest = await pageFor(browser, base, guestToken, 'guest');
  hostCtx = host.ctx;
  guestCtx = guest.ctx;
  check('both probe pages expose puter.peer and puter.events',
    await host.page.evaluate(() => typeof puter.peer?.serve === 'function' && typeof puter.peer?.connect === 'function' && typeof puter.events?.onLocal === 'function'),
    '');

  const code = await host.page.evaluate(() => window.__peer.serve());
  check('host mints an invite code', /^[A-Z0-9]{8}$/.test(String(code)), code);

  const joined = await guest.page.evaluate((invite) => window.__peer.connect(invite), code);
  await waitLog(host.page, 'connection');
  const hostConnection = await waitLog(host.page, 'connection');
  check('guest connects and the host sees who arrived',
    joined && joined.owner && joined.owner.username === USER && hostConnection.data.user.username === OTHER,
    JSON.stringify({ joined: joined?.owner, hostSees: hostConnection.data.user }));
  await waitLog(host.page, 'open');
  await waitLog(guest.page, 'open');
  check('both connections report open', true);

  await guest.page.evaluate(() => window.__peer.send('hello-host'));
  const guestToHost = await waitLog(host.page, 'message', (d) => d === 'hello-host');
  await host.page.evaluate(() => window.__peer.send('hello-guest'));
  const hostToGuest = await waitLog(guest.page, 'message', (d) => d === 'hello-guest');
  check('messages relay both ways', guestToHost.data === 'hello-host' && hostToGuest.data === 'hello-guest',
    JSON.stringify({ guestToHost: guestToHost.data, hostToGuest: hostToGuest.data }));

  // Media: both sides publish the fake camera+mic. The control message names
  // the stream; the tracks come from the transceiver receivers.
  await host.page.evaluate(() => window.__peer.publish('camera'));
  await guest.page.evaluate(() => window.__peer.publish('camera'));
  await waitLog(host.page, 'media', (d) => d && d.kind === 'video');
  await waitLog(host.page, 'media', (d) => d && d.kind === 'audio');
  await waitLog(guest.page, 'media', (d) => d && d.kind === 'video');
  await waitLog(guest.page, 'media', (d) => d && d.kind === 'audio');

  // Wait for the real peer connection to connect and carry RTP (it can lag
  // the media event: the event names the receiver track, not its first frame).
  const mediaState = async (page) => page.evaluate(async () => {
    const conn = window.__peer.conn;
    const pc = conn && conn.peerconnection;
    const stream = window.__peer.remoteStream;
    const inbound = {};
    if (pc) {
      const stats = await pc.getStats();
      stats.forEach((row) => {
        if (row.type === 'inbound-rtp' && row.kind) inbound[row.kind] = (inbound[row.kind] || 0) + Number(row.bytesReceived || 0);
      });
    }
    return {
      connected: conn && conn.connected,
      link: conn && conn.linkState,
      pc: pc && { connectionState: pc.connectionState, iceConnectionState: pc.iceConnectionState, transceivers: pc.getTransceivers().length },
      inbound,
      tracks: stream ? stream.getTracks().map((t) => ({ kind: t.kind, readyState: t.readyState, muted: t.muted })) : [],
    };
  });
  const mediaFlowing = (state) => state.pc?.connectionState === 'connected'
    && (state.inbound.audio || 0) > 0 && (state.inbound.video || 0) > 0
    && ['audio', 'video'].every((kind) => state.tracks.some((t) => t.kind === kind && t.readyState === 'live' && !t.muted));
  let hostMedia = await mediaState(host.page);
  let guestMedia = await mediaState(guest.page);
  for (let i = 0; i < 60 && (!mediaFlowing(hostMedia) || !mediaFlowing(guestMedia)); i++) {
    await new Promise((r) => setTimeout(r, 500));
    hostMedia = await mediaState(host.page);
    guestMedia = await mediaState(guest.page);
  }
  check('the WebRTC connection reaches connected on both ends',
    hostMedia.pc?.connectionState === 'connected' && guestMedia.pc?.connectionState === 'connected',
    JSON.stringify({ host: hostMedia.pc, guest: guestMedia.pc }));

  check('each side receives live audio and video RTP from the other',
    mediaFlowing(hostMedia) && mediaFlowing(guestMedia),
    JSON.stringify({
      host: { inbound: hostMedia.inbound, tracks: hostMedia.tracks },
      guest: { inbound: guestMedia.inbound, tracks: guestMedia.tracks },
    }));
  check('linkstate reports connected', hostMedia.link === 'connected' && guestMedia.link === 'connected',
    JSON.stringify({ host: hostMedia.link, guest: guestMedia.link }));

  // Screen share rides the third media slot. The host's answer to the first
  // offer was recvonly there, so publishing it has to renegotiate once.
  await host.page.evaluate(() => window.__peer.publishScreen());
  const screenEvent = await waitLog(guest.page, 'media', (d) => d && d.name === 'screen' && d.kind === 'video', 45000);
  check('the host publishes a second video stream on the screen slot',
    screenEvent.data.kind === 'video', JSON.stringify(screenEvent.data));
  let screenTrack = null;
  for (let i = 0; i < 40; i++) {
    screenTrack = await guest.page.evaluate(() => {
      const stream = window.__peer.conn.media.get('screen');
      const track = stream && stream.getVideoTracks()[0];
      return track ? { muted: track.muted, readyState: track.readyState } : null;
    });
    if (screenTrack && screenTrack.readyState === 'live' && !screenTrack.muted) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  check('the screen track reaches the guest live and unmuted',
    screenTrack && screenTrack.readyState === 'live' && !screenTrack.muted,
    JSON.stringify(screenTrack));

  // Unpublish is a control message, not another negotiation.
  await host.page.evaluate(() => window.__peer.unpublish('screen'));
  await waitLog(guest.page, 'mediaended', (d) => d && d.name === 'screen');
  await guest.page.evaluate(() => window.__peer.unpublish('camera'));
  const cameraEnded = await waitLog(host.page, 'mediaended', (d) => d && d.name === 'camera');
  check('unpublish tells the other side which stream ended',
    cameraEnded.data.name === 'camera', JSON.stringify(cameraEnded.data));

  // Events: a second tab of the host's own person hears a KV write with value.
  const tab2 = await hostCtx.newPage();
  await tab2.goto(`${base}/h/peer-probe/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await tab2.waitForFunction(() => window.__peer && window.__peer.ready === true, { timeout: 45000 });
  const sub = await host.page.evaluate(() => window.__peer.watch('kv:probe'));
  check('onLocal resolves with a subscription', sub && sub.subject === 'kv:probe' && !!sub.subId, JSON.stringify(sub));

  // A different person writing the same key is not this person's event.
  await guest.page.evaluate((by) => window.__peer.kvSet('probe', { by }), OTHER);
  await new Promise((r) => setTimeout(r, 500));
  let hostLog = await logsOf(host.page);
  const foreign = hostLog.filter((e) => e.kind === 'event' && e.data && e.data.value && e.data.value.by === OTHER);
  check('another person’s KV write is not delivered', foreign.length === 0, JSON.stringify(foreign));

  await tab2.evaluate((by) => window.__peer.kvSet('probe', { by, n: 7 }), USER);
  const event = await waitLog(host.page, 'event', (d) => !!d && d.op === 'set' && d.value && d.value.n === 7);
  check('a same-person tab receives the KV event with includeValue', event.data.value.n === 7 && event.data.key === 'probe',
    JSON.stringify(event.data));

  // Close: the guest leaves; the host is told why.
  await guest.page.evaluate(() => window.__peer.closePeer('bye from guest'));
  const closed = await waitLog(host.page, 'close', (d) => d && /bye from guest/.test(String(d.reason)));
  check('closing tells the other side the reason', /bye from guest/.test(String(closed.data.reason)), JSON.stringify(closed.data));

  // A dead invite is a definite rejection with a machine-readable code.
  const bad = await guest.page.evaluate(async () => {
    try {
      await window.__peer.connect('ZZZZZZZZ');
      return null;
    } catch (err) {
      return { message: String(err.message || err), code: err.code || null };
    }
  });
  check('a dead invite rejects connect() with invalid_invite', bad && bad.code === 'invalid_invite',
    JSON.stringify(bad));

  const pageErrors = [...host.errors, ...guest.errors];
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
} catch (err) {
  steps.push({ step: 'E2E run completed', pass: false, detail: err.stack || err.message });
  console.error(err.stack || err);
} finally {
  await browser?.close().catch(() => {});
  if (running) await running.close();
  fs.rmSync(DATA, { recursive: true, force: true });
}
const report = { at: new Date().toISOString(), pass: steps.every((s) => s.pass), steps };
fs.writeFileSync(path.join(here, 'peer-e2e-results.json'), JSON.stringify(report, null, 2));
console.log(`${steps.filter((s) => s.pass).length}/${steps.length} steps passed; evidence in peer-e2e-results.json`);
if (!report.pass) process.exitCode = 1;
