/**
 * Local engines: honest missing-errors, the real OCR and Piper paths, the
 * fake-binary seam (so the suite never needs an 85 MB download), and the
 * authenticated HTTP routes the shim calls.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { start, cleanup, client } from './helpers.js';
import * as config from '../lib/config.js';
import * as store from '../lib/store.js';
import * as hub from '../lib/hub.js';
import * as engines from '../lib/hub-engines.js';

const HERE = path.resolve('.');
const REAL_TESS = path.join(HERE, 'data', 'engines', 'tesseract', 'eng.traineddata');
const REAL_PIPER = path.join(HERE, 'data', 'engines', 'piper', 'piper.exe');
const REAL_TTS_MODEL = path.join(HERE, 'data', 'engines', 'piper', 'en_US-ljspeech-medium.onnx');
const REAL_TTS_CFG = `${REAL_TTS_MODEL}.json`;
const OCR_IMAGE = path.join(HERE, 'test', 'fixtures', 'ocr-text.png');
const FIXTURE = path.join(HERE, 'test', 'fixtures', 'hub', 'fixture-dist');
const HAS_OCR = fs.existsSync(REAL_TESS) && fs.existsSync(OCR_IMAGE);
const HAS_TTS = fs.existsSync(REAL_PIPER) && fs.existsSync(REAL_TTS_MODEL) && fs.existsSync(REAL_TTS_CFG) && process.platform === 'win32';

let running;
let c;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-engines-test-'));
const saved = {};

function saveConfig(keys) {
  for (const k of keys) saved[k] = config.get(k);
}
function restoreConfig() {
  for (const [k, v] of Object.entries(saved)) config.set(k, v ?? null);
}

before(async () => {
  running = await start();
  store.addUser('engperson', 'engperson-password');
  hub.installFromDist('enginetest', FIXTURE, { sha: 'e'.repeat(40), source: 'import', title: 'Engine test' });
  c = client(running.base);
  await c.login('engperson', 'engperson-password');
  saveConfig(['hubTessdataDir', 'hubTessCacheDir', 'hubOcrEnabled', 'hubTtsEnabled', 'hubPiperBin', 'hubPiperModel', 'hubPiperConfig', 'hubPiperEspeak', 'hubPiperPrefixArgs', 'hubImageModel', 'ai.providers']);
});

after(async () => {
  await engines.shutdownEngines();
  restoreConfig();
  await cleanup(running);
  fs.rmSync(temp, { recursive: true, force: true });
});

test('a fresh host reports the engines missing and refuses without pretending', async () => {
  config.set('hubTessdataDir', path.join(temp, 'no-tesseract'));
  config.set('hubPiperBin', path.join(temp, 'no-piper.exe'));
  config.set('hubPiperModel', path.join(temp, 'no-voice.onnx'));
  const status = engines.engineStatus();
  assert.equal(status.ocr.available, false);
  assert.equal(status.tts.available, false);
  await assert.rejects(() => engines.ocrImage(Buffer.from([1, 2, 3])), (e) => e.code === 'engine_missing' && /engines:install/.test(`${e.message}`));
  await assert.rejects(() => engines.synthesizeSpeech('hello'), (e) => e.code === 'engine_missing');
  await assert.rejects(() => engines.generateImage({ prompt: 'a cat' }), (e) => e.code === 'engine_missing' && /cloud-only/.test(e.message));
});

test('OCR through the authenticated HTTP route returns text and confidence', { skip: HAS_OCR ? false : 'real Tesseract data is not installed on this host' }, async () => {
  config.set('hubTessdataDir', path.dirname(REAL_TESS));
  config.set('hubTessCacheDir', path.join(temp, 'tess-cache'));
  const image = `data:image/png;base64,${fs.readFileSync(OCR_IMAGE).toString('base64')}`;
  const r = await c.post('hub/ai/img2txt', { app: 'enginetest', image });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /LOCAL OCR WORKS/i);
  assert.ok(r.body.confidence > 50);
  // A second call reuses the worker and still works.
  const again = await c.post('hub/ai/img2txt', { app: 'enginetest', image });
  assert.equal(again.status, 200);
  assert.match(again.body.text, /LOCAL OCR WORKS/i);
});

test('OCR rejects a non-data URL and a missing app without touching the engine', async () => {
  const bad = await c.post('hub/ai/img2txt', { app: 'enginetest', image: 'https://example.test/x.png' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'bad_image');
  const noApp = await c.post('hub/ai/img2txt', { image: 'data:image/png;base64,AAAA' });
  assert.equal(noApp.status, 404);
});

test('Piper speech runs through the same adapter with a test binary', async () => {
  const dir = fs.mkdtempSync(path.join(temp, 'voice-'));
  const model = path.join(dir, 'en_US-ljspeech-medium.onnx');
  const cfg = `${model}.json`;
  fs.writeFileSync(model, 'dummy');
  fs.writeFileSync(cfg, '{}');
  config.set('hubPiperBin', process.execPath);
  config.set('hubPiperModel', model);
  config.set('hubPiperConfig', cfg);
  config.set('hubPiperEspeak', path.join(dir, 'missing-espeak'));
  config.set('hubPiperPrefixArgs', [path.join(HERE, 'test', 'fixtures', 'fake-piper.mjs')]);
  const out = await engines.synthesizeSpeech('Hello from the test.');
  assert.equal(out.wav.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.ok(out.wav.length > 44);
  assert.equal(out.voice, 'en_US-ljspeech-medium');

  const r = await c.call('POST', 'hub/ai/txt2speech', { json: { app: 'enginetest', text: 'Hello through HTTP.' }, raw: true });
  if (r.status !== 200) assert.fail(await r.text());
  assert.match(r.headers.get('content-type') || '', /audio\/wav/);
  const bytes = Buffer.from(await r.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF');
});

test('the unanswered generators say exactly why and where to look', async () => {
  const img = await c.post('hub/ai/txt2img', { app: 'enginetest', prompt: 'a cat' });
  assert.equal(img.status, 501);
  assert.equal(img.body.code, 'engine_missing');
  assert.match(img.body.message, /cloud-only|Admin/);
  const stt = await c.post('hub/ai/speech2txt', { app: 'enginetest', audio: 'data:audio/wav;base64,UklGRg==' });
  assert.equal(stt.status, 501);
  assert.equal(stt.body.code, 'engine_missing');
  assert.match(stt.body.message, /whisper|README/);
  const vid = await c.post('hub/ai/txt2vid', { app: 'enginetest' });
  assert.equal(vid.status, 501);
  assert.equal(vid.body.code, 'engine_missing');
});

test('engineError names a disabled engine, not every unsupported kind', () => {
  const prev = config.get('hubOcrEnabled');
  try {
    config.set('hubOcrEnabled', false);
    assert.equal(engines.engineError('img2txt').code, 'engine_disabled');
    config.set('hubOcrEnabled', true);
    assert.equal(engines.engineError('img2txt').code, 'engine_missing');
    assert.equal(engines.engineError('txt2img').code, 'engine_missing');
    assert.equal(engines.engineError('txt2vid').code, 'engine_missing');
    assert.equal(engines.engineError('speech2txt').code, 'engine_missing');
  } finally {
    config.set('hubOcrEnabled', prev ?? null);
  }
});

test('the real Piper binary makes playable speech', { skip: HAS_TTS ? false : 'Piper is not installed on this host' }, async () => {
  config.set('hubPiperBin', REAL_PIPER);
  config.set('hubPiperModel', REAL_TTS_MODEL);
  config.set('hubPiperConfig', REAL_TTS_CFG);
  config.set('hubPiperEspeak', path.join(HERE, 'data', 'engines', 'piper', 'espeak-ng-data'));
  config.set('hubPiperPrefixArgs', null);
  const out = await engines.synthesizeSpeech('Local speech works.');
  assert.equal(out.wav.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.ok(out.wav.length > 1000);
});

test('cloud image generation is off until the owner configures a provider, then speaks the standard image API', async () => {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ url: req.url, body });
      if (calls.length === 1) {
        // Prove the adapter retries without response_format when a provider
        // (several do) rejects that OpenAI field rather than failing the call.
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unknown parameter: response_format' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ b64_json: Buffer.from('fake-png-bytes').toString('base64') }] }));
    });
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    config.set('hubImageModel', 'openai:test-image-1');
    config.set('ai.providers', { openai: { apiKey: 'test-key', baseUrl: base } });
    assert.equal(engines.engineStatus().image.available, true);
    const out = await engines.generateImage({ prompt: 'a watercolor cat', options: { size: '512x512' } });
    assert.match(out.dataUrl, /^data:image\/png;base64,/);
    assert.equal(out.provider, 'openai');
    assert.equal(out.model, 'test-image-1');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, '/images/generations');
    assert.equal(calls[0].body.model, 'test-image-1');
    assert.equal(calls[0].body.response_format, 'b64_json');
    assert.equal(calls[0].body.size, '512x512');
    assert.equal(calls[1].body.response_format, undefined);
    assert.equal(calls[1].body.prompt, 'a watercolor cat');
  } finally {
    await new Promise((resolve) => srv.close(resolve));
    config.set('hubImageModel', null);
    config.set('ai.providers', saved['ai.providers'] ?? null);
  }
});
