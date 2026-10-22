/**
 * The hub AI bridge: model aliasing, message normalization, the plain
 * ChatResponse shape, and the streamed NDJSON chunk protocol — against the
 * built-in test provider (CAD_TEST=1), so no network happens anywhere.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';
import * as config from '../lib/config.js';
import * as hubAi from '../lib/hub-ai.js';
import { HttpError } from '../lib/http.js';

/** A fake HTTP response collecting NDJSON lines and headers. */
function fakeRes() {
  const lines = [];
  let head = null;
  return {
    lines,
    writeHead: (status, headers) => { head = { status, headers }; },
    get status() { return head?.status; },
    get contentType() { return head?.headers['Content-Type']; },
    write: (s) => lines.push(s.replace(/\n$/, '')),
    end: (d) => { if (d) lines.push(d); },
    writableEnded: false,
  };
}

test('resolveModel: local ids pass, aliases map, default catches the rest', () => {
  config.set('hubAiDefaultModel', 'test:demo');
  config.set('hubAiAliases', JSON.stringify({ 'gpt-4o': 'test:demo' }));
  assert.equal(hubAi.resolveModel('ollama:llama3.1'), 'ollama:llama3.1');
  assert.equal(hubAi.resolveModel('gpt-4o'), 'test:demo');
  assert.equal(hubAi.resolveModel('claude-sonnet-4'), 'test:demo'); // unaliased → default
  assert.equal(hubAi.resolveModel(undefined), 'test:demo');

  config.set('hubAiDefaultModel', null);
  assert.throws(() => hubAi.resolveModel('some-future-model'), (e) => e instanceof HttpError && e.code === 'no_default_model');
  config.set('hubAiAliases', null);
});

test('normalizeMessages: prompt strings, message arrays and image blocks', async () => {
  config.set('hubAiDefaultModel', 'test:demo');
  // String call shape → resolves like a messages-array call.
  const answer = await hubAi.chat({ res: fakeRes(), user: 'u', app: 'a', body: { prompt: 'hello' } });
  assert.match(answer.message.content, /^test-reply: hello/);
  // Bad role rejected.
  await assert.rejects(
    () => hubAi.chat({ res: fakeRes(), user: 'u', app: 'a', body: { messages: [{ role: 'wizard', content: 'x' }] } }),
    (e) => e.code === 'bad_request',
  );
  // No prompt at all rejected.
  await assert.rejects(() => hubAi.chat({ res: fakeRes(), user: 'u', app: 'a', body: {} }), (e) => e.code === 'bad_request');
});

test('test provider inside ai.core: canned reply, chunked', async () => {
  const answer = await hubAi.chat({ res: fakeRes(), user: 'person1', app: 'alpha', body: { prompt: 'who are you' } });
  // Non-stream: the puter ChatResponse shape.
  assert.equal(answer.message.role, 'assistant');
  assert.match(answer.message.content, /^test-reply: who are you$/);
  assert.equal(String(answer), answer.message.content); // toString()
  assert.ok(answer.usage.output_tokens > 0);
});

test('streaming: 200 NDJSON with typed chunks ending in a final message', async () => {
  const res = fakeRes();
  await hubAi.chat({ res, user: 'person1', app: 'alpha', body: { prompt: 'say hi', stream: true } });
  assert.equal(res.status, 200);
  assert.match(res.contentType, /x-ndjson/);
  const events = res.lines.map((l) => JSON.parse(l));
  assert.ok(events.some((e) => e.type === 'text' && e.text));
  const last = events[events.length - 1];
  assert.equal(last.message.role, 'assistant');
  assert.match(last.message.content, /^test-reply: say hi$/);
});

test('vision reaches the provider: media attaches to the last user turn', async () => {
  const res = fakeRes();
  const dataUri = 'data:image/png;base64,iVBORw0KGgo=';
  const answer = await hubAi.chat({
    res, user: 'person1', app: 'alpha',
    body: { prompt: 'what is this', media: [dataUri] },
  });
  assert.match(answer.message.content, /\[saw 1 image\]/);
});

test('bad calls stream a typed error event and end the stream', async () => {
  // With no default model and no matching alias, the stream starts and must
  // deliver the failure as a typed event rather than an HTTP error status.
  config.set('hubAiDefaultModel', null);
  const res = fakeRes();
  await hubAi.chat({ res, user: 'person1', app: 'alpha', body: { messages: [{ role: 'user', content: 'x' }], model: 'some-future-model', stream: true } });
  assert.equal(res.status, 200);
  const events = res.lines.map((l) => JSON.parse(l));
  assert.equal(events[0].type, 'error');
  assert.equal(events[0].code, 'no_default_model');
});

test('promised engines answer with their install hint and a stable code', () => {
  for (const kind of ['txt2img', 'img2txt', 'txt2speech', 'speech2txt', 'txt2vid']) {
    const res = fakeRes();
    hubAi.sendEngineError(res, kind, 501);
    const body = JSON.parse(res.lines[0]);
    assert.equal(res.status, 501);
    assert.equal(body.code, 'engine_missing');
    assert.match(body.message, /README|Admin/);
  }
});
