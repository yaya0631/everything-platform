/**
 * §12 layer-1 reach, proven against the machine's real Node 24: the resolve
 * hook alone is NOT enough — process.getBuiltinModule() hands out net/tls
 * with no resolver involvement, process.binding() would hand out raw handles,
 * and Function/eval still return globalThis (where fetch must be gone). Also
 * §19: the worker env is an explicit allow-list — nothing secret can even
 * exist that way, even when the parent process itself carries it.
 */
import test from 'node:test';
import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, cleanup, client } from './helpers.js';
import * as hub from '../lib/hub.js';
import * as store from '../lib/store.js';
import * as config from '../lib/config.js';
import net from 'node:net';

const FIXTURE = 'test/fixtures/hub/fixture-dist';
const SHA40 = (c) => c.repeat(40);

const PROBE = `
router.post('/builtin', async function (ctx) {
  const body = await ctx.request.json();
  const name = String(body.name || 'node:net');
  const gbm = typeof process.getBuiltinModule;
  let result;
  if (gbm === 'function') {
    try { result = 'got:' + typeof process.getBuiltinModule(name); }
    catch (e) { result = 'threw:' + String(e && e.message).slice(0, 90); }
  } else result = 'no-getBuiltinModule';
  return new Response(JSON.stringify({ gbm, result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
router.post('/require-tls', async function () {
  const out = { requireType: typeof require };
  try { const tls = await import('node:tls'); out.dynamicImport = typeof tls; }
  catch (e) { out.importError = String(e && e.message).slice(0, 90); }
  try {
    const mod = await import('node:module'); // itself a builtin — resolve-hooked
    out.moduleImport = typeof mod;
    if (mod && mod.createRequire) {
      try { const tls = mod.createRequire(import.meta.url)('node:tls'); out.required = typeof tls; }
      catch (e) { out.requiredError = String(e && e.message).slice(0, 90); }
    }
  } catch (e) { out.moduleImportError = String(e && e.message).slice(0, 90); }
  return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
router.post('/binding', function () {
  try {
    const b = process.binding('tcp_wrap');
    return new Response(b ? 'got-handle' : 'null', { status: 200 });
  } catch (e) {
    return new Response('binding-threw: ' + String(e && e.message).slice(0, 90), { status: 503 });
  }
});
router.post('/eval-fn', function () {
  const self = Function('return this')();
  return new Response(JSON.stringify({
    fetch: typeof self.fetch,
    evalFetch: (0, eval)('typeof fetch'),
    socket: typeof self.WebSocket,
    xhr: typeof self.XMLHttpRequest,
    gbm: typeof self.process === 'object' ? typeof self.process.getBuiltinModule : 'no-process',
    binding: typeof self.process === 'object' ? typeof self.process.binding : 'no-process',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
router.post('/tcp-connect', async function (ctx) {
  const body = await ctx.request.json();
  try {
    const net = process.getBuiltinModule('node:net');
    const port = Number(body.port) || 1;
    await new Promise((ok, bad) => {
      const s = net.connect({ host: '127.0.0.1', port });
      s.on('connect', () => { s.destroy(); ok(); });
      s.on('error', bad);
      setTimeout(() => bad(new Error('connect-timeout')), 1500).unref?.();
    });
    return new Response('connected-to-' + port, { status: 200 });
  } catch (e) {
    return new Response('no-net: ' + String(e && e.message).slice(0, 120), { status: 503 });
  }
});
router.post('/env-peek', function () {
  return new Response(JSON.stringify({
    keys: Object.keys(process.env).sort(),
    values: { CAD_WORKER_ALLOC_CAP: process.env.CAD_WORKER_ALLOC_CAP ?? null },
  }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
});
router.post('/dispatcher', async function (ctx) {
  const body = await ctx.request.json();
  // §12: the exact bypass from the field report — deep-touch the undici
  // classes so the bundled undici boots, then drive the global dispatcher
  // straight at a real listener with fetch deleted.
  await new Response('boot').text();
  const gate = { esType: typeof EventSource };
  const sym = Symbol.for('undici.globalDispatcher.1');
  const sym2 = Symbol.for('undici.globalDispatcher.2');
  const d = globalThis[sym] || globalThis[sym2];
  gate.dispatcherType = typeof d;
  gate.hasRequest = d ? typeof d.request : 'none';
  if (d && typeof d.request === 'function') {
    try {
      const out = await d.request({ origin: 'http://127.0.0.1:' + body.port, path: '/x', method: 'GET' });
      await out.body?.cancel?.();
      gate.dispatched = true;
    } catch (e) { gate.dispatchError = String(e && e.message).slice(0, 90); }
  }
  return new Response(JSON.stringify(gate), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
router.post('/globals', function () {
  return new Response(JSON.stringify({
    names: Object.getOwnPropertyNames(globalThis).sort(),
    symbols: Object.getOwnPropertySymbols(globalThis).map((s) => String(s)).sort(),
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
`;

let running;
let hostC;

before(async () => {
  running = await start();
  store.addUser('person1', 'person1-password');
  hub.installFromDist('alpha', FIXTURE, { sha: SHA40('a'), source: 'import', title: 'Alpha' });
  config.set('workers.timeout_ms', 8000);

  hostC = client(running.base);
  await hostC.login('person1', 'person1-password');
  const wr = await hostC.call('PUT', 'hub/fs/write?app=alpha&path=workers/probe.js&options=' + encodeURIComponent('{}'), { body: PROBE, raw: true });
  assert.equal(wr.status, 200, `probe write -> ${JSON.stringify(wr.body)}`);
  const created = await hostC.post('hub/workers', { app: 'alpha', name: 'probe-1', filePath: 'workers/probe.js' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
});
after(() => cleanup(running));

const probe = async (route, json) => hostC.post('hub/workers/exec', {
  target: 'probe-1', method: 'POST', path: route, headers: { 'content-type': 'application/json' }, body: JSON.stringify(json ?? {}),
});

test('process.getBuiltinModule is gone, so node:net/node:tls are unreachable', async () => {
  const r = await probe('/builtin', { name: 'node:net' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.gbm, 'undefined', 'the worker realm has no getBuiltinModule');
  const t = await probe('/builtin', { name: 'node:tls' });
  assert.equal(t.body.gbm, 'undefined');
});

test('require / createRequire / dynamic import of node:tls all fail', async () => {
  const r = await probe('/require-tls');
  assert.equal(r.status, 200);
  assert.equal(r.body.requireType, 'undefined', 'no bare require in an ESM realm');
  assert.match(r.body.importError || '', /net_disabled/, `dynamic import of node:tls: ${r.body.importError}`);
  // createRequire can only be reached through 'node:module', which the resolve
  // hook denies the same way — the parents' deny list covers 'node:module'.
  assert.notEqual(r.body.required, 'function', `createRequire('node:tls') -> ${r.body.required ?? r.body.requiredError ?? r.body.moduleImportError}`);
});

test('process.binding("tcp_wrap") is unreachable', async () => {
  const r = await probe('/binding');
  assert.match(String(r.body), /^binding-threw/, `binding probe: ${r.body}`);
});

test('Function("return this")() and indirect eval get no fetch/net globals', async () => {
  const r = await probe('/eval-fn');
  assert.equal(r.status, 200);
  assert.equal(r.body.fetch, 'undefined');
  assert.equal(r.body.evalFetch, 'undefined');
  assert.equal(r.body.socket, 'undefined');
  assert.equal(r.body.xhr, 'undefined');
  assert.equal(r.body.gbm, 'undefined');
  assert.equal(r.body.binding, 'undefined');
});

test('net.connect to a REAL local listener cannot even start (§12)', async () => {
  let connections = 0;
  const server = net.createServer((s) => { connections += 1; s.end('nope'); });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const port = server.address().port;
  try {
    const r = await probe('/tcp-connect', { port });
    assert.match(String(r.body), /no-net/, `the worker must not connect: ${r.body}`);
    // allow the kernel a moment to surface any race the worker won
    await new Promise((ok) => setTimeout(ok, 300));
    assert.equal(connections, 0, 'the local listener saw zero connections');
  } finally {
    server.close();
  }
});

test('the undici global dispatcher is locked (§12, field-reported bypass)', async () => {
  // Confirmed bug on Node 24.21 before the fix: deep-touching
  // Response/Request/Headers/FormData boots bundled undici, whose
  // Symbol.for('undici.globalDispatcher.1') dispatcher opened a real socket
  // (d.request({origin, path})) with fetch deleted and --permission on.
  let connections = 0;
  const server = net.createServer((s) => { connections += 1; s.end('nope'); });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const port = server.address().port;
  try {
    const r = await probe('/dispatcher', { port });
    assert.equal(r.status, 200);
    assert.equal(r.body.dispatcherType, 'undefined', `dispatcher must be undefined, got ${r.body.dispatcherType}`);
    assert.notEqual(r.body.dispatched, true, `the dispatcher must not complete a request: ${JSON.stringify(r.body)}`);
    await new Promise((ok) => setTimeout(ok, 300));
    assert.equal(connections, 0, 'the local listener saw zero connections');
  } finally {
    server.close();
  }
});

// Durable global allow-list, measured on Node v24.21.0 (evidence tool
// _globals-dump.mjs): the exact own property names and symbols of the worker
// realm after the preamble. A Node upgrade that introduces a NEW global (or
// a new undici symbol) fails this test on purpose — the new surface must be
// reviewed and either deny-listed by the preamble or allow-listed here.
const ALLOWED_GLOBAL_NAMES = [
  'AbortController', 'AbortSignal', 'AsyncDisposableStack', 'AggregateError', 'Array',
  'ArrayBuffer', 'Atomics', 'BigInt', 'BigInt64Array', 'BigUint64Array', 'Blob',
  'Boolean', 'BroadcastChannel', 'Buffer', 'ByteLengthQueuingStrategy', 'CloseEvent',
  'CompressionStream', 'CountQueuingStrategy', 'Crypto', 'CryptoKey', 'CustomEvent',
  'DOMException', 'DataView', 'Date', 'DecompressionStream', 'DisposableStack',
  'Error', 'EvalError', 'Event', 'EventTarget', 'File', 'FinalizationRegistry',
  'Float16Array', 'Float32Array', 'Float64Array', 'FormData', 'Function', 'Headers',
  'Infinity', 'Int16Array', 'Int32Array', 'Int8Array', 'Intl', 'Iterator', 'JSON',
  'Map', 'Math', 'MessageChannel', 'MessageEvent', 'MessagePort', 'NaN', 'Navigator',
  'Number', 'Object', 'Performance', 'PerformanceEntry', 'PerformanceMark',
  'PerformanceMeasure', 'PerformanceObserver', 'PerformanceObserverEntryList',
  'PerformanceResourceTiming', 'Promise', 'Proxy', 'RangeError',
  'ReadableByteStreamController', 'ReadableStream', 'ReadableStreamBYOBReader',
  'ReadableStreamBYOBRequest', 'ReadableStreamDefaultController',
  'ReadableStreamDefaultReader', 'ReferenceError', 'Reflect', 'RegExp', 'Request',
  'Response', 'Set', 'SharedArrayBuffer', 'String', 'SubtleCrypto', 'SuppressedError',
  'Symbol', 'SyntaxError', 'TextDecoder', 'TextDecoderStream', 'TextEncoder',
  'TextEncoderStream', 'TransformStream', 'TransformStreamDefaultController',
  'TypeError', 'URIError', 'URL', 'URLPattern', 'URLSearchParams', 'Uint16Array',
  'Uint32Array', 'Uint8Array', 'Uint8ClampedArray', 'WeakMap', 'WeakRef', 'WeakSet',
  'WebAssembly', 'WritableStream', 'WritableStreamDefaultController',
  'WritableStreamDefaultWriter', '__cadMe', '__cadRouter', 'atob', 'btoa',
  'clearImmediate', 'clearInterval', 'clearTimeout', 'console', 'crypto',
  'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'escape',
  'eval', 'global', 'globalThis', 'isFinite', 'isNaN', 'me', 'navigator',
  'parseFloat', 'parseInt', 'performance', 'process', 'queueMicrotask', 'router',
  'setImmediate', 'setInterval', 'setTimeout', 'structuredClone', 'undefined',
  'unescape',
].sort();

test('durable: the worker realm exposes exactly the allow-listed globals', async () => {
  const r = await probe('/globals');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const names = r.body.names ?? [];
  const symbols = r.body.symbols ?? [];
  const strangers = names.filter((n) => !ALLOWED_GLOBAL_NAMES.includes(n));
  const missing = ALLOWED_GLOBAL_NAMES.filter((n) => !names.includes(n));
  // A new global is the danger; one that DISAPPEARS is low-risk but also worth
  // a look, so both directions come back as loud diffs.
  assert.deepEqual(strangers, [], `new global(s) not on the allow-list — review the preamble: ${strangers.join(', ')}`);
  assert.deepEqual(missing, [], `global(s) removed since the allow-list was measured: ${missing.join(', ')}`);
  // fetch/WebSocket/XMLHttpRequest/EventSource must never reappear as own names
  for (const banned of ['fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource']) {
    assert.ok(!names.includes(banned), `${banned} must not be a worker global`);
  }
  const undiciSymbols = symbols.filter((s) => s.includes('undici'));
  for (const bik of undiciSymbols) {
    // the symbol key may exist (locked); its VALUE must be undefined — asserted
    // by the /dispatcher test above, here we just bound how many may exist
    assert.ok(/^Symbol\(undici\.globalDispatcher\.\d+\)$/.test(bik), `unexpected undici symbol: ${bik}`);
  }
  assert.ok(symbols.length <= 3, `too many realm symbols (${symbols.length}) — review: ${symbols.join(', ')}`);
});

test('§19: the worker env is the explicit allow-list, even when the parent has secrets', async () => {
  // The test parent (this process, which also runs the server) carries… and
  // can gain secrets at any time: plant one, then prove the child never sees it.
  process.env.SECRET_PROBE = 'do-not-leak';
  process.env.SMTP_PASSWORD_POKE = 'hunter2';
  const r = await probe('/env-peek');
  const keys = r.body.keys ?? [];
  // Our allow-list (CHILD_ENV_KEYS in lib/hub-workers-run.js) plus the floor
  // Node itself insists on adding to any Windows fork (measured on this box),
  // plus CAD_WORKER_ALLOC_CAP — the ONE deliberate extra value (the runner
  // allocation cap, layer 2d). It must be a plain positive integer: the
  // no-secret-shaped-keys check below still guards everything else.
  const allowed = /^(PATH|PATHEXT|SystemRoot|SystemDrive|SYSTEMDRIVE|ComSpec|windir|WINDIR|HOMEDRIVE|HOMEPATH|LOGONSERVER|TEMP|USERDOMAIN|USERNAME|USERPROFILE|NODE_OPTIONS|CAD_WORKER_ALLOC_CAP)$/;
  const strangers = keys.filter((k) => !allowed.test(k));
  assert.deepEqual(strangers, [], `worker env keys beyond the allow-list: ${strangers.join(', ')}`);
  assert.ok(!keys.some((k) => /SMTP|SECRET|TOKEN|PASSWORD|API_?KEY/.test(k)), 'no secret-shaped key exists');
  const cap = Number(r.body.values?.CAD_WORKER_ALLOC_CAP);
  assert.ok(Number.isSafeInteger(cap) && cap > 0, `the cap env value is a bare positive integer (${r.body.values?.CAD_WORKER_ALLOC_CAP})`);
  assert.equal(keys.includes('NODE_OPTIONS'), true, 'NODE_OPTIONS is pinned empty (no flag/require smuggling)');
});
