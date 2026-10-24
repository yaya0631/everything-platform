import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import WebSocket from 'ws';
import { before, after } from 'node:test';
import { start, cleanup, client } from './helpers.js';
import * as hub from '../lib/hub.js';
import * as store from '../lib/store.js';

const FIXTURE = 'test/fixtures/hub/fixture-dist';
let running;
let person;

before(async () => {
  running = await start();
  store.addUser('person1', 'person1-password');
  hub.installFromDist('alpha', FIXTURE, { sha: 'a'.repeat(40), source: 'import', title: 'Alpha' });
  person = client(running.base);
  await person.login('person1', 'person1-password');
});

after(() => cleanup(running));

test('hub net bridge carries local TCP bytes and rejects public hosts', async () => {
  const tcp = net.createServer((socket) => socket.on('data', (data) => socket.end(Buffer.from(data).toString().toUpperCase())));
  await new Promise((resolve) => tcp.listen(0, '127.0.0.1', resolve));
  const port = tcp.address().port;
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${running.privatePort}/api/hub/net?app=alpha&host=127.0.0.1&port=${port}`, {
      headers: { Cookie: person.cookie, Origin: running.base },
    });
    const messages = [];
    await new Promise((resolve, reject) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        messages.push(msg);
        if (msg.type === 'open') ws.send(JSON.stringify({ type: 'write', data: Buffer.from('hello').toString('base64') }));
        if (msg.type === 'data') resolve();
      });
      ws.on('error', reject);
    });
    assert.equal(Buffer.from(messages.find((m) => m.type === 'data').data, 'base64').toString(), 'HELLO');
    ws.close();

    const denied = await new Promise((resolve) => {
      const ws2 = new WebSocket(`ws://127.0.0.1:${running.privatePort}/api/hub/net?app=alpha&host=example.com&port=80`, {
        headers: { Cookie: person.cookie, Origin: running.base },
      });
      ws2.on('unexpected-response', (_req, res) => resolve(res.statusCode));
      ws2.on('error', () => resolve(403));
    });
    assert.equal(denied, 403);
  } finally {
    await new Promise((resolve) => tcp.close(resolve));
  }
});
