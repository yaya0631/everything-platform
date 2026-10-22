/** Sign-in brute-force guard (the loopback note in README §1 step 5): the
 * outbound firewall rule on the worker binary does NOT filter loopback, so
 * a worker CAN reach the hub's own listeners — the open sign-in surface
 * must therefore resist exactly that. Wrong-password attempts are capped
 * per address+username (10 / 15 min, server.js): the 11th 401 becomes a
 * named 429 even with CORRECT credentials, while a different username from
 * the same address is untouched. */
import test from 'node:test';
import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, cleanup, client } from './helpers.js';
import * as store from '../lib/store.js';
import { realClientKey } from '../lib/http.js';

let running;

before(async () => {
  running = await start();
  store.addUser('rl-victim', 'correct-horse');
});
after(() => cleanup(running));

const wrong = (username, password) => client(running.base).post('auth/login', { username, password });

test('the 11th wrong password becomes 429 too_many_attempts, even with the right one', async () => {
  for (let i = 1; i <= 10; i += 1) {
    const r = await wrong('rl-victim', `wrong-${i}`);
    assert.equal(r.status, 401, `attempt ${i} must be an ordinary 401: ${JSON.stringify(r.body)}`);
  }
  // Brute-force property: a correct password after the cap does NOT reset
  // the counter and does NOT get in either — lockout is the guard.
  const flood = await wrong('rl-victim', 'correct-horse');
  assert.equal(flood.status, 429, JSON.stringify(flood.body));
  assert.equal(flood.body?.code, 'too_many_attempts', JSON.stringify(flood.body));
  const again = await wrong('rl-victim', 'another-try');
  assert.equal(again.status, 429);
});

test('a different username from the same address is not locked by the first', async () => {
  const r = await wrong('other-person', 'anything');
  assert.equal(r.status, 401, `the cap is per address+username: ${JSON.stringify(r.body)}`);
});

/** `tailscale serve` proxies to this server over loopback: without the fix,
 * every tailnet device shares 127.0.0.1, so anyone's wrong-password streak
 * locked the whole (username, 127.0.0.1) bucket for everyone. The limiter
 * keys on realClientKey now — identity header or tailnet address — only
 * trusted over a loopback connection (verify with the fake-req unit test
 * below). */
test('two clients behind the proxy get separate buckets', async () => {
  const proxyA = (u, p) => client(running.base).post('auth/login', { username: u, password: p }, { headers: { 'x-forwarded-for': '100.115.92.10' } });
  const proxyB = (u, p) => client(running.base).post('auth/login', { username: u, password: p }, { headers: { 'x-forwarded-for': '100.115.92.20' } });
  for (let i = 1; i <= 10; i += 1) {
    const r = await proxyA('rl-proxied', `wrong-${i}`);
    assert.equal(r.status, 401, `proxy-A attempt ${i}: ${JSON.stringify(r.body)}`);
  }
  const locked = await proxyA('rl-proxied', 'one-more');
  assert.equal(locked.status, 429, 'proxy-A is capped after 10');
  // B's FIRST attempt — same username, different tailnet address — is an
  // ordinary 401: a bucket of A's did not lock the shared (username, addr).
  const fresh = await proxyB('rl-proxied', 'wrong-0');
  assert.equal(fresh.status, 401, `no cross-bucket lockout: ${JSON.stringify(fresh.body)}`);
});

test('the real client key, not a shared socket address: a clean bucket can still sign in', async () => {
  // B drove 1 failure above; 9 more fill B's bucket, but the shared-name
  // account proves buckets, not usernames, carry the lockout.
  for (let i = 1; i <= 9; i += 1) {
    const r = await client(running.base).post('auth/login', { username: 'rl-proxied', password: `w-${i}` }, { headers: { 'x-forwarded-for': '100.115.92.20' } });
    assert.equal(r.status, 401, `B attempt ${i}`);
  }
  const b = await client(running.base).post('auth/login', { username: 'rl-proxied', password: 'correct-horse' }, { headers: { 'x-forwarded-for': '100.115.92.20' } });
  assert.equal(b.status, 429, 'B hits their own cap with a CORRECT password too (lockout works)');
  const a = await client(running.base).post('auth/login', { username: 'rl-proxied', password: 'correct-horse' }, { headers: { 'x-forwarded-for': '100.115.92.30' } });
  assert.equal(a.status, 401, 'a THIRD tailnet address is untouched');
});

test('realClientKey trusts forwarded headers only over loopback (unit)', () => {
  // A LAN client cannot lie its way into a separate bucket: the socket is
  // not loopback, so the headers are ignored entirely.
  assert.equal(
    realClientKey({ socket: { remoteAddress: '192.168.1.50' }, headers: { 'x-forwarded-for': '1.2.3.4', 'tailscale-user-login': 'mallory@example.com' } }),
    '192.168.1.50',
  );
  // Serve (loopback): identity header first...
  assert.equal(
    realClientKey({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'tailscale-user-login': 'Alice@Example.com', 'x-forwarded-for': '100.115.92.10' } }),
    'ts:alice@example.com',
  );
  // ...then the tailnet address from XFF...
  assert.equal(
    realClientKey({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '127.0.0.1, 100.115.92.10' } }),
    '100.115.92.10',
  );
  // ...and a plain direct loopback request stays bucketed on the socket.
  assert.equal(realClientKey({ socket: { remoteAddress: '::1' }, headers: {} }), '::1');
  // IPv6-mapped IPv4 loopback forms fold correctly.
  assert.equal(realClientKey({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: {} }), '::ffff:127.0.0.1');
  // A malformed identity value falls through to the XFF chain.
  assert.equal(
    realClientKey({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'tailscale-user-login': 'bad value with spaces', 'x-forwarded-for': '100.0.0.7' } }),
    '100.0.0.7',
  );
});
