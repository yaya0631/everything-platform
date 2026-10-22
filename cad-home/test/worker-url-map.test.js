import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../lib/shim/worker-url-map.js', import.meta.url), 'utf8');

function install(protocol = 'https:') {
  const calls = { fetch: [], sockets: [], events: [] };
  class FakeRequest {
    constructor(input, init) {
      this.url = String(input?.url ?? input);
      this.init = init;
      this.method = init?.method || 'GET';
    }
  }
  class FakeWebSocket {
    constructor(url, protocols) { calls.sockets.push([String(url), protocols]); }
  }
  class FakeEventSource {
    constructor(url, init) { calls.events.push([String(url), init]); }
  }
  const win = {
    location: { href: `${protocol}//local.example:444/h/app/` },
    URL, Request: FakeRequest,
    fetch(input, init) { calls.fetch.push([input, init]); return Promise.resolve('ok'); },
    WebSocket: FakeWebSocket,
    EventSource: FakeEventSource,
  };
  vm.runInNewContext(source, { window: win, URL, Request: FakeRequest });
  return { win, calls };
}

test('fetch keeps the canonical worker URL in app code and maps the transport to the local route', async () => {
  const { win, calls } = install();
  await win.fetch('https://team-alpha.puter.work/api/rooms?x=1', { method: 'POST' });
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.fetch[0][0].url, 'https://local.example:444/w/host/team-alpha/api/rooms?x=1');
  assert.equal(calls.fetch[0][0].method, 'POST');
});

test('WebSocket maps wss canonical hosts to the local public/private listener route', () => {
  const { win, calls } = install();
  new win.WebSocket('wss://team-alpha.puter.work/room?token=x', ['cad.v1']);
  assert.deepEqual(calls.sockets[0], ['wss://local.example:444/w/host/team-alpha/room?token=x', ['cad.v1']]);
});

test('EventSource maps the same canonical host and preserves options', () => {
  const { win, calls } = install('http:');
  const options = { withCredentials: false };
  new win.EventSource('https://team-alpha.puter.work/events', options);
  assert.equal(calls.events[0][0], 'http://local.example:444/w/host/team-alpha/events');
  assert.equal(calls.events[0][1], options);
});

test('non-worker URLs remain unchanged and worker hosts reject ports and paths in the authority', () => {
  const { win, calls } = install();
  new win.WebSocket('wss://example.org/socket');
  new win.EventSource('https://team-alpha.puter.work:9443/events');
  assert.equal(calls.sockets[0][0], 'wss://example.org/socket');
  assert.equal(calls.events[0][0], 'https://team-alpha.puter.work:9443/events');
});
