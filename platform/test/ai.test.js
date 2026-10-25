import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { start, cleanup, client } from './helpers.js';

let running, mock, mockUrl, db;
const seen = [];
let c;

function sse(res, events) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`);
  res.end();
}

before(async () => {
  mock = http.createServer(async (req, res) => {
    let body = '';
    for await (const ch of req) body += ch;
    seen.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'gpt-test' }, { id: 'gpt-other' }] }));
    if (req.url === '/anthropic/v1/models?limit=1000') return res.end(JSON.stringify({ data: [{ id: 'claude-test', display_name: 'Claude Test' }] }));
    if (req.url === '/v1/chat/completions') {
      const b = JSON.parse(body);
      if (b.model === 'bad-key') {
        res.writeHead(401);
        return res.end(JSON.stringify({ error: { message: 'no' } }));
      }
      if (b.model === 'no-tools' && b.tools) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: { message: 'This model does not support tools' } }));
      }
      // A model that prints its call as DeepSeek DSML text instead of tool_calls.
      if (b.model === 'dsml') {
        return sse(res, [
          { choices: [{ delta: { content: 'I will build it.\n< | DSML' } }] },
          { choices: [{ delta: { content: ' | calls>\n< | DSML | invoke name="run_script">\n< | DSML | parameter name="script" string="true">const x = 1 < 2;' } }] },
          { choices: [{ delta: { content: '\n</ | DSML | parameter>\n</ | DSML | invoke>\n</ | DSML | calls>\n' } }] },
          { choices: [], usage: { prompt_tokens: 5, completion_tokens: 9 } },
          '[DONE]',
        ]);
      }
      // A model that prints a conventional call as text, split across chunks.
      if (b.model === 'call-text') {
        return sse(res, [
          { choices: [{ delta: { content: 'I will add the poster layers.\nCa' } }] },
          {
            choices: [{
              delta: {
                content: 'll propose_plan(steps=[{"action":"op.add_fill_layer","args":{"color":"#2d0e06","name":"Dark Base","opacity":100},"note":"Base"},{"action":"op.add_text","args":{"color":"#ffffff","text":"SOLSTICE","size":150},"note":"Title"}], summary="A dark base and a title.", title="Sunset poster")\n',
              },
            }],
          },
          { choices: [], usage: { prompt_tokens: 7, completion_tokens: 12 } },
          '[DONE]',
        ]);
      }
      return sse(res, [
        { choices: [{ delta: { content: 'Hel' } }] },
        { choices: [{ delta: { content: 'lo' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'add_entities', arguments: '{"entit' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ies":[]}' } }] } }] },
        { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } },
        '[DONE]',
      ]);
    }
    if (req.url === '/anthropic/v1/messages') {
      return sse(res, [
        { type: 'message_start', message: { usage: { input_tokens: 20, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Sure.' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'drawing_info' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"a":' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '1}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', usage: { output_tokens: 9 } },
        { type: 'message_stop' },
      ]);
    }
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  mockUrl = `http://127.0.0.1:${mock.address().port}`;
  running = await start();
  db = await import('../lib/db.js');
  const store = await import('../lib/store.js');
  store.addUser('alex', 'alex-password');
  c = client(running.base);
  await c.login('alex', 'alex-password');
});
after(async () => {
  mock.close();
  await cleanup(running);
});

async function chat(body) {
  const res = await c.call('POST', 'ai/chat', { json: body, raw: true });
  assert.equal(res.status, 200);
  return (await res.text())
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
}

test('admin sets keys (masked), fetches models and enables them', async () => {
  assert.deepEqual((await c.get('ai/models')).body, []);
  const r = await c.put('admin/ai/providers/openai', { apiKey: 'sk-test-123456', baseUrl: `${mockUrl}/v1` });
  assert.equal(r.body.apiKey, '••••3456');
  await c.put('admin/ai/providers/anthropic', { apiKey: 'ak-test-abcdef', baseUrl: `${mockUrl}/anthropic/v1` });
  const info = (await c.get('admin/ai')).body;
  assert.ok(info.providers.every((p) => !p.apiKey || p.apiKey.startsWith('••••')));
  assert.ok(!JSON.stringify(info).includes('sk-test-123456'));
  const found = (await c.post('admin/ai/providers/openai/models')).body.models;
  assert.deepEqual(found.map((m) => m.id), ['openai:gpt-test', 'openai:gpt-other']);
  assert.equal(seen.at(-1).headers.authorization, 'Bearer sk-test-123456');
  const test1 = (await c.post('admin/ai/providers/anthropic/test')).body;
  assert.equal(test1.ok, true);
  assert.equal(seen.at(-1).headers['x-api-key'], 'ak-test-abcdef');
  await c.put('admin/ai/models', {
    models: [
      { id: 'openai:gpt-test', label: 'GPT Test', enabled: true },
      { id: 'openai:gpt-other', enabled: false },
      { id: 'openai:bad-key', enabled: true },
      { id: 'openai:no-tools', enabled: true },
      { id: 'anthropic:claude-test', label: 'Claude Test', enabled: true },
    ],
  });
  const list = (await c.get('ai/models')).body;
  assert.deepEqual(list.map((m) => m.id), ['openai:gpt-test', 'openai:bad-key', 'openai:no-tools', 'anthropic:claude-test']);
});

test('OpenAI-style stream: text, tool call assembled from pieces, usage logged', async () => {
  const tools = [{ name: 'add_entities', description: 'Add', parameters: { type: 'object', properties: { entities: { type: 'array' } } } }];
  const events = await chat({
    model: 'openai:gpt-test',
    messages: [
      { role: 'system', content: 'You draw.' },
      { role: 'user', content: 'Draw' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'x1', name: 'drawing_info', arguments: {} }] },
      { role: 'tool', tool_call_id: 'x1', content: '{"units":"mm"}' },
    ],
    tools,
  });
  assert.deepEqual(
    events.filter((e) => e.type === 'text').map((e) => e.delta),
    ['Hel', 'lo'],
  );
  assert.deepEqual(events.find((e) => e.type === 'tool_call'), { type: 'tool_call', id: 'call_1', name: 'add_entities', arguments: { entities: [] } });
  assert.deepEqual(events.find((e) => e.type === 'usage'), { type: 'usage', input: 11, output: 7 });
  assert.equal(events.at(-1).type, 'done');
  const sent = seen.at(-1).body;
  assert.equal(sent.stream_options.include_usage, true);
  assert.equal(sent.max_tokens, 4096);
  assert.equal(sent.tools[0].type, 'function');
  assert.equal(sent.messages[2].tool_calls[0].function.arguments, '{}');
  assert.equal(sent.messages[3].role, 'tool');
  const row = db.get("SELECT * FROM ai_usage WHERE model = 'gpt-test' ORDER BY id DESC");
  assert.equal(row.input_tokens, 11);
  assert.equal(row.output_tokens, 7);
  assert.equal(row.user, 'alex');
  assert.equal(row.source, 'cad');
});

test('Anthropic stream: system field, tool_use and tool_result blocks', async () => {
  const events = await chat({
    model: 'anthropic:claude-test',
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Checking', tool_calls: [{ id: 't1', name: 'drawing_info', arguments: {} }] },
      { role: 'tool', tool_call_id: 't1', content: 'ok' },
    ],
    tools: [{ name: 'drawing_info', parameters: { type: 'object', properties: {} } }],
  });
  assert.equal(events.find((e) => e.type === 'text').delta, 'Sure.');
  assert.deepEqual(events.find((e) => e.type === 'tool_call'), { type: 'tool_call', id: 'tu_1', name: 'drawing_info', arguments: { a: 1 } });
  assert.deepEqual(events.find((e) => e.type === 'usage'), { type: 'usage', input: 20, output: 9 });
  const sent = seen.at(-1);
  assert.equal(sent.headers['anthropic-version'], '2023-06-01');
  assert.equal(sent.body.system, 'Be brief.');
  assert.equal(sent.body.messages[1].content[1].type, 'tool_use');
  assert.equal(sent.body.messages[2].content[0].type, 'tool_result');
  assert.equal(sent.body.tools[0].input_schema.type, 'object');
});

test('clear errors: refused key, model without tools, model not enabled', async () => {
  const bad = await chat({ model: 'openai:bad-key', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(bad.at(-1).type, 'error');
  assert.equal(bad.at(-1).code, 'bad_key');
  assert.match(bad.at(-1).message, /Admin → AI/);
  const nt = await chat({ model: 'openai:no-tools', messages: [{ role: 'user', content: 'x' }], tools: [{ name: 'a', parameters: {} }] });
  assert.equal(nt.at(-1).code, 'tools_unsupported');
  const off = await chat({ model: 'openai:gpt-other', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(off.at(-1).code, 'bad_model');
  const usage = (await c.get('admin/ai/usage?days=30')).body;
  assert.ok(usage.totals.calls >= 4);
  assert.ok(usage.byModel.some((m) => m.key === 'openai:gpt-test'));
  const csv = await c.call('GET', 'admin/ai/usage.csv', { raw: true });
  assert.match(await csv.text(), /^time,user,source,provider,model/);
});

test('Groq, Google AI Studio and OpenRouter work like the other OpenAI-style providers', async () => {
  const info = (await c.get('admin/ai')).body;
  const labels = Object.fromEntries(info.providers.map((p) => [p.id, p.label]));
  assert.equal(labels.groq, 'Groq');
  assert.equal(labels.google, 'Google AI Studio (Gemini)');
  assert.equal(labels.openrouter, 'OpenRouter');

  // Groq: key + model listing through the mock OpenAI endpoint.
  assert.equal((await c.put('admin/ai/providers/groq', { apiKey: 'gsk-test-9999', baseUrl: `${mockUrl}/v1` })).status, 200);
  assert.deepEqual((await c.post('admin/ai/providers/groq/models')).body.models.map((m) => m.id), ['groq:gpt-test', 'groq:gpt-other']);
  assert.equal(seen.at(-1).headers.authorization, 'Bearer gsk-test-9999');

  // Google AI Studio: its OpenAI-compatible endpoint needs no extra handling.
  assert.equal((await c.put('admin/ai/providers/google', { apiKey: 'AIza-google-test', baseUrl: `${mockUrl}/v1` })).status, 200);
  assert.deepEqual((await c.post('admin/ai/providers/google/models')).body.models.map((m) => m.id), ['google:gpt-test', 'google:gpt-other']);

  // OpenRouter: same.
  assert.equal((await c.put('admin/ai/providers/openrouter', { apiKey: 'sk-or-test-9999', baseUrl: `${mockUrl}/v1` })).status, 200);
  assert.deepEqual((await c.post('admin/ai/providers/openrouter/models')).body.models.map((m) => m.id), ['openrouter:gpt-test', 'openrouter:gpt-other']);
  assert.equal((await c.post('admin/ai/providers/openrouter/test')).status, 200);

  // Enable a Groq model and stream through it like any other provider.
  const all = (await c.get('admin/ai')).body.models.filter((m) => !m.id.startsWith('groq:'));
  await c.put('admin/ai/models', { models: [...all, { id: 'groq:gpt-test', label: 'Groq Test', enabled: true }] });
  const picker = (await c.get('ai/models')).body.find((m) => m.id === 'groq:gpt-test');
  assert.equal(picker.providerLabel, 'Groq');
  const events = await chat({ model: 'groq:gpt-test', messages: [{ role: 'user', content: 'Hi' }] });
  assert.deepEqual(events.filter((e) => e.type === 'text').map((e) => e.delta), ['Hel', 'lo']);
  assert.equal(events.at(-1).type, 'done');

  // Unknown provider ids are still rejected.
  assert.equal((await c.put('admin/ai/providers/nope', { apiKey: 'x' })).status, 404);
  assert.equal((await c.post('admin/ai/providers/nope/models')).status, 404);
  assert.equal((await chat({ model: 'nope:some-model', messages: [{ role: 'user', content: 'x' }]})).find((e) => e.type === 'error')?.code, 'bad_model');
});

test('textual DSML tool calls run as real tool calls, never as chat text', async () => {
  const all = (await c.get('admin/ai')).body.models;
  await c.put('admin/ai/models', { models: [...all, { id: 'openai:dsml', enabled: true }] });
  const events = await chat({
    model: 'openai:dsml',
    messages: [{ role: 'user', content: 'Build it' }],
    tools: [{ name: 'run_script', description: 'Run', parameters: { type: 'object', properties: { script: { type: 'string' } } } }],
  });
  assert.deepEqual(events.filter((e) => e.type === 'text').map((e) => e.delta), ['I will build it.\n']);
  assert.deepEqual(events.find((e) => e.type === 'tool_call'), {
    type: 'tool_call', id: 'call_text_0', name: 'run_script', arguments: { script: 'const x = 1 < 2;\n' },
  });
  assert.equal(events.at(-1).type, 'done');
});

test('conventional textual calls run as real tool calls, even when split across chunks', async () => {
  const all = (await c.get('admin/ai')).body.models;
  await c.put('admin/ai/models', { models: [...all, { id: 'openai:call-text', enabled: true }] });
  const events = await chat({
    model: 'openai:call-text',
    messages: [{ role: 'user', content: 'Make a poster' }],
    tools: [{ name: 'propose_plan', description: 'Plan', parameters: { type: 'object', properties: { steps: { type: 'array' } } } }],
  });
  assert.deepEqual(events.filter((e) => e.type === 'text').map((e) => e.delta), ['I will add the poster layers.\n']);
  assert.deepEqual(events.find((e) => e.type === 'tool_call'), {
    type: 'tool_call',
    id: 'call_text_0',
    name: 'propose_plan',
    arguments: {
      steps: [
        { action: 'op.add_fill_layer', args: { color: '#2d0e06', name: 'Dark Base', opacity: 100 }, note: 'Base' },
        { action: 'op.add_text', args: { color: '#ffffff', text: 'SOLSTICE', size: 150 }, note: 'Title' },
      ],
      summary: 'A dark base and a title.',
      title: 'Sunset poster',
    },
  });
  assert.equal(events.some((e) => e.type === 'text' && e.delta.includes('propose_plan')), false);
  assert.equal(events.at(-1).type, 'done');
});

test('a sentence that mentions a call is left as prose', async () => {
  const { parseTextToolCalls } = await import('../lib/ai.js');
  assert.equal(parseTextToolCalls('Call me later', ['propose_plan']), null);
  assert.deepEqual(parseTextToolCalls('Call propose_plan(steps=[], title="x")', ['propose_plan']).calls[0].arguments, {
    steps: [],
    title: 'x',
  });
});
