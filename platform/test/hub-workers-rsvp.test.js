/** Step 5b — §15 replay gate for the calendar's RSVP + booking worker.
 * Deploys the UPSTREAM source (test/fixtures/upstream/rsvp-worker.js) with
 * rsvp-links.js's three deploy-time substitutions —
 *   __RSVP_ADMIN_SECRET_HASH__  <- sha256(admin secret)  (secret never stored)
 *   __RSVP_WORKER_VERSION__     <- '30'
 *   __RSVP_PAGE_URL__           <- <listener>/rsvp.html (absolute)
 * as person1's per-user worker under the `cal-person1` name (exec supports
 * the `cal-<user>` bare-name pattern), then walks the upstream RSVP
 * scenarios end to end: Bearer-secret admin guard, sync issuing raw tokens
 * but storing hashes only, the #w&t&s fragment one-click GETs, the JSON
 * API (GET/POST/PUT), reissue and revoke, event-ended 410, the suggestion
 * cap and its idempotent re-suggestion. (The booking half exists in the
 * file — not driven here; it is gated with the calendar productization.) */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, cleanup, client } from './helpers.js';
import * as hub from '../lib/hub.js';
import * as store from '../lib/store.js';
import * as config from '../lib/config.js';

const RAW_SOURCE = path.join('test', 'fixtures', 'upstream', 'rsvp-worker.js');
const WORKER_VERSION = '30'; // rsvp-links.js: export const RSVP_WORKER_VERSION = '30'

const ADMIN_SECRET = randomBytes(24).toString('hex'); // the raw secret never stored anywhere
const SECRET_HASH = createHash('sha256').update(ADMIN_SECRET).digest('hex');

let running;
let hostC;
let base;

/** Call the worker through the exec route (the same surface the calendar
 * shim uses; the caller's host header supplies the worker's own origin). */
async function exec(route, { method = 'GET', headers = {}, body = null } = {}) {
  const r = await hostC.post('hub/workers/exec', {
    target: 'cal-person1',
    method,
    path: route,
    headers,
    ...(body !== null ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  return r;
}

const bearer = (route, { method = 'POST', body = null, as = ADMIN_SECRET } = {}) =>
  exec(route, {
    method,
    headers: { authorization: `Bearer ${as}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: body !== null ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined } : {}),
  });

const guestJson = (route, { method = 'GET', body = null, extra = {} } = {}) =>
  exec(route, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...extra },
    ...(body !== null ? { body: JSON.stringify(body) } : {}),
  });

const EMAIL = 'guest@example.com';
const EMAIL2 = 'friend@example.com';
const ORGANIZER = 'boss@example.com';

before(async () => {
  running = await start();
  base = running.base.replace(/\/$/, '');
  hostC = client(running.base);
  store.addUser('person1', 'person1-password');
  hub.installFromDist('alpha', 'test/fixtures/hub/fixture-dist', { sha: 'a'.repeat(40), source: 'import', title: 'Alpha' });
  config.set('workers.timeout_ms', 12000);
  await hostC.login('person1', 'person1-password');
  const source = fs.readFileSync(RAW_SOURCE, 'utf8')
    .replace('__RSVP_ADMIN_SECRET_HASH__', SECRET_HASH)
    .replace('__RSVP_WORKER_VERSION__', WORKER_VERSION)
    .replace('__RSVP_PAGE_URL__', `${base}/rsvp.html`);
  const wr = await hostC.call('PUT', 'hub/fs/write?app=alpha&path=workers/rsvp.js&options=' + encodeURIComponent('{}'), { body: source, raw: true });
  assert.equal(wr.status, 200, JSON.stringify(wr.body));
  const created = await hostC.post('hub/workers', { app: 'alpha', name: 'cal-person1', filePath: 'workers/rsvp.js' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
});
after(() => cleanup(running));

function newEvent(over = {}) {
  return {
    id: `evt${randomBytes(6).toString('hex')}`,
    title: 'Replay sync test',
    start: Date.now() + 86400000,
    end: Date.now() + 90000000,
    allDay: false,
    location: 'The hall',
    description: 'potluck',
    organizerName: 'Boss',
    organizerEmail: ORGANIZER,
    tz: 'UTC',
    hour12: false,
    ...over,
  };
}

/** Fragment of a redirect Location as { w, t, s } (URLSearchParams-decoded). */
function fragmentOf(location) {
  const frag = String(location || '').split('#')[1] || '';
  return Object.fromEntries(new URLSearchParams(frag));
}

test('admin guard: Bearer-secret only; a wrong secret and no secret both 401', async () => {
  const none = await exec('/admin/ping');
  assert.equal(none.status, 401);
  assert.equal(none.body.error, 'unauthorized');
  // A secret GUARANTEED to differ (the naive "drop last char, append 0" mutation
  // equals the real secret whenever the random secret happens to end in 0 —
  // a 1-in-16 flake the suite hit twice on 2026-10-22). Flip the first char
  // instead: deterministic, always different, same shape.
  const wrongSecret = ADMIN_SECRET[0] === '0' ? `1${ADMIN_SECRET.slice(1)}` : `0${ADMIN_SECRET.slice(1)}`;
  const bad = await bearer('/admin/ping', { method: 'GET', as: wrongSecret });
  assert.equal(bad.status, 401);
  const good = await bearer('/admin/ping', { method: 'GET' });
  assert.equal(good.status, 200, JSON.stringify(good.body));
  assert.equal(good.body.ok, true);
  assert.equal(good.body.version, WORKER_VERSION);
  assert.equal(good.body.runtime, null); // no upstream preamble here — truthful null, not a fake string
});

// Scenario 1: the base event; one-click uses it directly (upstream shape).
const EV1 = newEvent();
let tok1;
let tok2;

test('sync: raw tokens returned ONCE, membership mapped without hashes', async () => {
  const noAuth = await exec('/admin/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: EV1, guests: [] }) });
  assert.equal(noAuth.status, 401);
  const badId = await bearer('/admin/sync', { body: { event: newEvent({ id: 'bad id!' }), guests: [] } });
  assert.equal(badId.status, 400, JSON.stringify(badId.body));
  const r = await bearer('/admin/sync', { body: { event: EV1, guests: [{ email: EMAIL, name: 'Gee One' }, { email: EMAIL2, name: '' }] } });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  tok1 = r.body.links[EMAIL];
  tok2 = r.body.links[EMAIL2];
  assert.match(tok1, /^[0-9a-f]{40}$/, 'a link token is 40 hex chars (160-bit)');
  assert.match(tok2, /^[0-9a-f]{40}$/, 'a link token is 40 hex chars (160-bit)');
  assert.ok(!String(r.body).includes(ADMIN_SECRET));
  const g1 = r.body.guests[EMAIL];
  assert.equal(g1.status, 'needs-action');
  assert.equal(g1.name, 'Gee One');
  assert.ok(!('tokenHash' in g1), `the hash never rides the app's read: ${JSON.stringify(g1)}`);
});

test('invite: GET /api/rsvp/<token> shows the sanitized event, needs-action; unknown token 404s', async () => {
  const unknown = await guestJson('/api/rsvp/deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error, 'not_found');
  const r = await guestJson(`/api/rsvp/${tok1}`);
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.event.title, EV1.title);
  assert.equal(typeof r.body.event.when, 'string');
  assert.equal(r.body.event.organizer, EV1.organizerName);
  assert.equal(r.body.guest.email, EMAIL);
  assert.equal(r.body.guest.name, 'Gee One');
  assert.equal(r.body.response.status, 'needs-action');
  assert.deepEqual(r.body.allowedStatuses, ['accepted', 'declined', 'tentative']);
  assert.deepEqual(r.body.suggestions, []);
  // The token itself stays out of the payload entirely.
  assert.ok(!JSON.stringify(r.body).includes(tok1), 'no token echo');
});

test('answer: POST sets it, GET reflects it, PUT replaces it, bad status 400s', async () => {
  const r = await guestJson(`/api/rsvp/${tok1}`, { method: 'POST', body: { status: 'accepted', comment: 'bringing pie' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.response.status, 'accepted');
  assert.equal(r.body.response.comment, 'bringing pie');
  const get = await guestJson(`/api/rsvp/${tok1}`);
  assert.equal(get.body.response.status, 'accepted');
  assert.ok(get.body.response.respondedAt > 0);
  const put = await guestJson(`/api/rsvp/${tok1}`, { method: 'PUT', body: { status: 'tentative', comment: '' } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.response.status, 'tentative');
  const refused = await guestJson(`/api/rsvp/${tok1}`, { method: 'POST', body: { status: 'perhaps' } });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, 'invalid_status');
  assert.deepEqual(refused.body.allowedStatuses, ['accepted', 'declined', 'tentative']);
});

test('one-click: GET records the answer and redirects with #w&t&s; prefetchers never record', async () => {
  // A normal browser click: the answer is recorded FIRST, then the redirect.
  const r = await exec(`/rsvp/${tok2}/accept`, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120' } });
  assert.equal(r.status, 303, JSON.stringify(r.body));
  const frag = fragmentOf(r.headers.get('location'));
  assert.match(String(r.headers.get('location') || ''), /^http:\/\/[^#]+\/rsvp\.html#/, `redirect to PAGE_URL: ${r.headers.get('location')}`);
  assert.equal(frag.t, tok2, 'the token travels in the fragment');
  assert.equal(frag.s, '1', 'the saved flag shows on the page');
  assert.ok(frag.w, 'the worker origin rides along');
  const after = await guestJson(`/api/rsvp/${tok2}`);
  assert.equal(after.body.response.status, 'accepted');
  // An email scanner must NEVER answer on the guest's behalf.
  const scan = await exec(`/rsvp/${tok2}/decline`, { headers: { 'user-agent': 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com)' } });
  assert.equal(scan.status, 303);
  assert.ok(!/s=1/.test(String(scan.headers.get('location') || '')),
    `no saved flag for a scanner: ${scan.headers.get('location')}`);
  const still = await guestJson(`/api/rsvp/${tok2}`);
  assert.equal(still.body.response.status, 'accepted', 'the scanner\'s decline was not recorded');
  // An explicit prefetch purpose header is equally refused.
  const pre = await exec(`/rsvp/${tok2}/decline`, { headers: { 'user-agent': 'Mozilla/5.0 Chrome/120', 'sec-purpose': 'prefetch' } });
  assert.equal(pre.status, 303);
  const still2 = await guestJson(`/api/rsvp/${tok2}`);
  assert.equal(still2.body.response.status, 'accepted');
  // The plain link always just redirects without answering.
  const plain = await exec(`/rsvp/${tok2}`, { headers: { 'user-agent': 'Mozilla/5.0 Chrome/120' } });
  assert.equal(plain.status, 303);
  assert.ok(!/s=1/.test(String(plain.headers.get('location') || '')));
  assert.equal((await guestJson(`/api/rsvp/${tok2}`)).body.response.status, 'accepted');
});

test('sync again: same guests keep their tokens; reissue mints a replacement and kills the old', async () => {
  const keep = await bearer('/admin/sync', { body: { event: EV1, guests: [{ email: EMAIL, name: 'Gee One' }] } });
  assert.equal(keep.status, 200);
  assert.equal(keep.body.links[EMAIL], undefined, 'a known guest gets NO new link — links ride only fresh tokens');
  assert.equal((await guestJson(`/api/rsvp/${tok1}`)).status, 200, 'their original token still works, proving the hash stayed stored');
  // The dropped guest's capability and answer die with the entry.
  assert.equal(keep.body.guests[EMAIL2], undefined);
  const rev = await bearer('/admin/sync', { body: { event: EV1, guests: [{ email: EMAIL, name: 'Gee One' }], reissue: [EMAIL] } });
  const old = tok1;
  tok1 = rev.body.links[EMAIL];
  assert.equal(rev.status, 200);
  assert.match(tok1, /^[0-9a-f]{40}$/);
  assert.notEqual(tok1, old, 'reissue mints a NEW token');
  assert.equal((await guestJson(`/api/rsvp/${old}`)).status, 404, 'the old token is dead');
  // Bringing EMAIL2 back REISSUES too — the old tok2 was dropped with the guest.
  const back = await bearer('/admin/sync', { body: { event: EV1, guests: [{ email: EMAIL, name: 'Gee One' }, { email: EMAIL2, name: 'Friend' }] } });
  tok2 = back.body.links[EMAIL2];
  assert.match(tok2, /^[0-9a-f]{40}$/);
  assert.equal((await guestJson(`/api/rsvp/${tok2}`)).status, 200);
});

test('event ended: the API answers 410 event_ended on writes, not reads', async () => {
  const past = newEvent({ expiresAt: Date.now() - 1000 });
  const r = await bearer('/admin/sync', { body: { event: past, guests: [{ email: EMAIL, name: '' }] } });
  const tok = r.body.links[EMAIL];
  const read = await guestJson(`/api/rsvp/${tok}`);
  assert.equal(read.status, 200);
  assert.equal(read.body.event.ended, true);
  const write = await guestJson(`/api/rsvp/${tok}`, { method: 'POST', body: { status: 'accepted' } });
  assert.equal(write.status, 410);
  assert.equal(write.body.error, 'event_ended');
  const suggest = await guestJson(`/api/rsvp/${tok}/guests`, { method: 'POST', body: { email: 'someone@example.com' } });
  assert.equal(suggest.status, 410);
  // ACleanup: drop the ended event entirely.
  await bearer('/admin/revoke', { body: { eventId: past.id } });
});

// Suggestions: capped at 10 pending per event, idempotent per address,
// filtered per guest, settled by membership, and dismissible.
const SUG_EV = newEvent();

test('suggestions: queue, idempotent re-suggest, cap at 10, invalid/already-invited cases', async () => {
  const r = await bearer('/admin/sync', { body: { event: SUG_EV, guests: [{ email: EMAIL, name: '' }, { email: EMAIL2, name: '' }] } });
  tok1 = r.body.links[EMAIL];
  tok2 = r.body.links[EMAIL2];

  const bad = await guestJson(`/api/rsvp/${tok1}/guests`, { method: 'POST', body: { email: 'not-an-email' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid_email');
  const org = await guestJson(`/api/rsvp/${tok1}/guests`, { method: 'POST', body: { email: ORGANIZER } });
  assert.equal(org.status, 409);
  assert.equal(org.body.error, 'already_invited');
  const member = await guestJson(`/api/rsvp/${tok1}/guests`, { method: 'POST', body: { email: EMAIL2 } });
  assert.equal(member.status, 409);

  const first = await guestJson(`/api/rsvp/${tok1}/guests`, { method: 'POST', body: { email: 'newbie@example.com', name: 'Newbie' } });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const at = first.body.suggestion.at;
  // Re-suggesting the same address (even BY THE OTHER GUEST) updates the one
  // entry and keeps the original `at` — no duplicate stacking, no re-notice.
  const again = await guestJson(`/api/rsvp/${tok2}/guests`, { method: 'POST', body: { email: 'newbie@example.com', name: 'Newbie R.' } });
  assert.equal(again.status, 200);
  assert.equal(again.body.suggestion.at, at, 'the original timestamp is kept');
  assert.equal(again.body.suggestion.name, 'Newbie R.');

  for (let i = 0; i < 10; i += 1) {
    const s = await guestJson(`/api/rsvp/${tok1}/guests`, { method: 'POST', body: { email: `sug${i}@example.com` } });
    if (i < 9) assert.equal(s.status, 200, `#${i}: ${JSON.stringify(s.body)}`);
  }
  const capped = await guestJson(`/api/rsvp/${tok1}/guests`, { method: 'POST', body: { email: 'sug10@example.com' } });
  assert.equal(capped.status, 429, JSON.stringify(capped.body));
  assert.equal(capped.body.error, 'suggestion_limit');
});

test('invitations ride along ONLY the asker\'s own suggestions', async () => {
  const forG1 = await guestJson(`/api/rsvp/${tok1}`);
  const forG2 = await guestJson(`/api/rsvp/${tok2}`);
  const g1Sug = forG1.body.suggestions.map((s) => s.email);
  const g2Sug = forG2.body.suggestions.map((s) => s.email);
  // 'newbie' was re-suggested LAST by g2 (the entry's `by` is the latest
  // suggester), so it shows under g2's invitation only.
  assert.ok(g2Sug.includes('newbie@example.com'), `g2 (last suggester) sees it: ${g2Sug.join(',')}`);
  assert.ok(!g1Sug.includes('newbie@example.com'), 'g1 no longer owns that proposal');
  assert.ok(g1Sug.includes('sug0@example.com'), `g1's own proposals ride along: ${g1Sug.join(',')}`);
  // Whom other guests proposed is nobody's business but the organizer's.
  assert.deepEqual(forG2.body.suggestions.filter((s) => s.email === 'sug0@example.com'), []);
});

test('responses pull: every synced event, suggestion list pending only, no hashes anywhere', async () => {
  const pull = await bearer('/admin/responses', { method: 'GET' });
  assert.equal(pull.status, 200);
  assert.ok(!JSON.stringify(pull.body).includes(ADMIN_SECRET));
  const ev = pull.body.events[SUG_EV.id];
  assert.ok(ev, `the event is listed: ${Object.keys(pull.body.events).join(',')}`);
  assert.ok(!('tokenHash' in ev), 'no hashes at the event level');
  assert.equal(typeof ev.guests[EMAIL].status, 'string');
  assert.ok(ev.guests[EMAIL].tokenHash === undefined);
  const sugEmails = ev.suggestions.map((s) => s.email);
  assert.ok(sugEmails.includes('newbie@example.com'), sugEmails.join(','));
  // One pull covers BOTH live events synced under this account (per-minute
  // cost); the earlier `event ended` fixture was revoked, so 2 remain.
  assert.ok(Object.keys(pull.body.events).length >= 2, JSON.stringify(Object.keys(pull.body.events)));
});

test('dismiss: idempotent, and the gone suggestion stops riding along', async () => {
  const badId = await bearer('/admin/suggestions/dismiss', { body: { eventId: 'bad id!', email: 'x@example.com' } });
  assert.equal(badId.status, 400);
  const d1 = await bearer('/admin/suggestions/dismiss', { body: { eventId: SUG_EV.id, email: 'newbie@example.com' } });
  assert.equal(d1.status, 200);
  assert.equal(d1.body.ok, true);
  const d2 = await bearer('/admin/suggestions/dismiss', { body: { eventId: SUG_EV.id, email: 'newbie@example.com' } });
  assert.equal(d2.body.ok, true, 'dismissing what is already gone is ok:true');
  const forG1 = await guestJson(`/api/rsvp/${tok1}`);
  assert.ok(!forG1.body.suggestions.some((s) => s.email === 'newbie@example.com'));
});

test('revoke: the event, every token, and every answer die together', async () => {
  const bad = await bearer('/admin/revoke', { body: { eventId: 'bad id!' } });
  assert.equal(bad.status, 400);
  const r = await bearer('/admin/revoke', { body: { eventId: SUG_EV.id } });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal((await guestJson(`/api/rsvp/${tok1}`)).status, 404, 'the guest\'s token is dead');
  assert.equal((await guestJson(`/api/rsvp/${tok2}`)).status, 404);
  const pull = await bearer('/admin/responses', { method: 'GET' });
  assert.equal(pull.body.events[SUG_EV.id], undefined, 'the event left the account list');
});
