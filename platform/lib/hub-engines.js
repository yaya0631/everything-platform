/**
 * Local AI engines for hub apps: Tesseract OCR and Piper speech.
 *
 * Everything here runs on this PC and never reaches the internet. The two
 * engines are optional installs under data/engines (see `npm run
 * engines:install`); when a file is missing the call fails with a clear
 * `engine_missing` message instead of a fictional promise. Image generation
 * is deliberately not local on this CPU: it stays a documented cloud option
 * and is only attempted when the owner sets hubImageModel and has a key for
 * that provider.
 *
 * Call shapes:
 *   ocrImage(buffer, {language})          -> { text, confidence, language }
 *   synthesizeSpeech(text, options)       -> { wav, voice }
 *   generateImage({prompt, options})      -> { dataUrl, provider, model }
 *   transcribeSpeech(buffer, options)     -> optional whisper.cpp, explicit error
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as config from './config.js';
import * as db from './db.js';
import * as paths from './paths.js';
import { HttpError } from './http.js';
import { providerFor } from './ai.js';

const require = createRequire(import.meta.url);

export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
export const MAX_TEXT_CHARS = 5000;
export const MAX_AUDIO_BYTES = 40 * 1024 * 1024;
const ENGINE_ROOT = () => path.join(paths.DATA_DIR, 'engines');
const INSTALL_HINT = 'Run `npm run engines:install` in the platform folder on this server, then reload this page.';

const existsFile = (p) => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
};
const existsDir = (p) => {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
};
const resolveFromData = (value, fallback) => {
  const raw = String(value || fallback || '').trim();
  return path.isAbsolute(raw) ? raw : path.resolve(paths.DATA_DIR, raw);
};

// Tesseract --------------------------------------------------------------------------------

function tessdataDir() {
  return resolveFromData(config.get('hubTessdataDir'), path.join(ENGINE_ROOT(), 'tesseract'));
}
function tessCacheDir() {
  return resolveFromData(config.get('hubTessCacheDir'), path.join(ENGINE_ROOT(), 'cache'));
}
function ocrLanguages() {
  let names = [];
  try {
    names = fs.readdirSync(tessdataDir())
      .filter((f) => f.endsWith('.traineddata'))
      .map((f) => f.slice(0, -'.traineddata'.length))
      .sort();
  } catch { /* engine not installed */ }
  return names;
}
function defaultOcrLanguage() {
  const configured = String(config.get('hubOcrLanguage') || 'eng').trim();
  return /^[a-z]{3}(?:\+[a-z]{3})*$/.test(configured) ? configured : 'eng';
}
function ocrStatus() {
  const language = defaultOcrLanguage();
  const languages = ocrLanguages();
  const available = language.split('+').every((l) => languages.includes(l));
  return {
    available,
    enabled: config.get('hubOcrEnabled', true) !== false,
    language,
    languages,
    path: tessdataDir(),
    hint: available ? '' : `OCR needs ${language}.traineddata in ${tessdataDir()}. ${INSTALL_HINT}`,
  };
}

let ocrWorker = null;
let ocrWorkerLang = '';
let ocrWorkerPromise = null;
let ocrIdleTimer = null;
let ocrChain = Promise.resolve();

function scheduleOcrIdle() {
  if (ocrIdleTimer) clearTimeout(ocrIdleTimer);
  // A worker keeps a child process alive; stop it after a quiet minute so a
  // test process (and a sleeping server) can exit and idle memory is released.
  ocrIdleTimer = setTimeout(() => { void resetOcr(); }, 60_000);
  ocrIdleTimer.unref?.();
}

async function resetOcr() {
  const worker = ocrWorker;
  ocrWorker = null;
  ocrWorkerLang = '';
  ocrWorkerPromise = null;
  if (ocrIdleTimer) { clearTimeout(ocrIdleTimer); ocrIdleTimer = null; }
  if (worker) await worker.terminate().catch(() => {});
}

async function getOcrWorker(language) {
  if (ocrWorker && ocrWorkerLang === language) return ocrWorker;
  if (ocrWorkerPromise) await ocrWorkerPromise;
  if (ocrWorker && ocrWorkerLang === language) return ocrWorker;
  ocrWorkerPromise = (async () => {
    const Tesseract = require('tesseract.js');
    fs.mkdirSync(tessCacheDir(), { recursive: true });
    const worker = await Tesseract.createWorker(language, 1, {
      langPath: tessdataDir(),
      gzip: false,
      cachePath: tessCacheDir(),
      logger: () => {},
    });
    ocrWorker = worker;
    ocrWorkerLang = language;
    return worker;
  })();
  try {
    return await ocrWorkerPromise;
  } finally {
    ocrWorkerPromise = null;
  }
}

function queueOcr(fn) {
  const run = ocrChain.then(fn, fn);
  ocrChain = run.catch(() => {});
  return run;
}

/** OCR an image buffer. `language` may be "eng", "fra" or "eng+fra". */
export async function ocrImage(buffer, { language } = {}) {
  const status = ocrStatus();
  if (!status.enabled) {
    throw new HttpError(501, 'engine_disabled', 'Local OCR was turned off in Admin → Hub → Engines.');
  }
  if (!status.available) {
    throw new HttpError(501, 'engine_missing', `Local OCR is not installed on this server. ${status.hint}`);
  }
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new HttpError(400, 'bad_image', 'Send an image (PNG, JPEG, WebP, BMP or TIFF).');
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new HttpError(413, 'image_too_large', 'That image is too large for local OCR (30 MB maximum).');
  }
  const wanted = String(language || status.language).trim();
  if (!/^[a-z]{3}(?:\+[a-z]{3})*$/.test(wanted)) {
    throw new HttpError(400, 'bad_language', 'Use a language such as eng, fra or eng+fra.');
  }
  const missing = wanted.split('+').filter((l) => !status.languages.includes(l));
  if (missing.length) {
    throw new HttpError(400, 'bad_language', `OCR has no ${missing.join(', ')} data here. Installed: ${status.languages.join(', ') || 'none'}.`);
  }

  return queueOcr(async () => {
    const worker = await getOcrWorker(wanted);
    try {
      const out = await worker.recognize(buffer);
      scheduleOcrIdle();
      const text = String(out?.data?.text || '').replace(/\u0000/g, '').trim();
      return {
        text,
        confidence: Number(out?.data?.confidence) || 0,
        language: wanted,
      };
    } catch (err) {
      await resetOcr();
      throw new HttpError(502, 'engine_failed', `Tesseract could not read that image: ${String(err?.message || err).slice(0, 300)}`);
    }
  });
}

// Piper ------------------------------------------------------------------------------------

function piperBin() {
  return resolveFromData(config.get('hubPiperBin'), path.join(ENGINE_ROOT(), 'piper', process.platform === 'win32' ? 'piper.exe' : 'piper'));
}
function piperModel() {
  return resolveFromData(config.get('hubPiperModel'), path.join(ENGINE_ROOT(), 'piper', 'en_US-ljspeech-medium.onnx'));
}
function piperVoiceConfig(model) {
  return resolveFromData(config.get('hubPiperConfig'), `${model}.json`);
}
function piperDataDir(bin) {
  return resolveFromData(config.get('hubPiperEspeak'), path.join(path.dirname(bin), 'espeak-ng-data'));
}
function piperVoices() {
  const dir = path.dirname(piperModel());
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.onnx')).sort();
  } catch { return []; }
}
function ttsStatus() {
  const bin = piperBin();
  const model = piperModel();
  const cfg = piperVoiceConfig(model);
  const available = existsFile(bin) && existsFile(model) && existsFile(cfg);
  return {
    available,
    enabled: config.get('hubTtsEnabled', true) !== false,
    voice: path.basename(model, '.onnx'),
    voices: piperVoices().map((f) => f.replace(/\.onnx$/, '')),
    path: bin,
    hint: available ? '' : `Speech needs Piper at ${bin} and a voice model at ${model}. ${INSTALL_HINT}`,
  };
}

function pickVoice(options = {}) {
  let model = piperModel();
  const language = String(options.language || options.lang || '').toLowerCase();
  const prefix = language.split(/[-_]/)[0];
  if (!config.get('hubPiperModel') && /^[a-z]{2}$/.test(prefix)) {
    const dir = path.dirname(model);
    const found = piperVoices().find((f) => f.startsWith(`${prefix}_`));
    if (found) model = path.join(dir, found);
  }
  return model;
}

let ttsChain = Promise.resolve();
function queueTts(fn) {
  const run = ttsChain.then(fn, fn);
  ttsChain = run.catch(() => {});
  return run;
}

function runPiper(bin, args, text, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: path.dirname(bin),
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish(new Error('Piper took too long to make that speech.'));
    }, timeoutMs);
    timer.unref?.();
    child.on('error', (err) => finish(err));
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-8000); });
    child.on('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(`Piper exited ${code}${stderr ? `: ${stderr.trim().slice(-600)}` : ''}`));
    });
    // Treat the text as an argument stream, never a shell line: no quoting rules
    // and no interpolation on Windows.
    child.stdin.end(String(text), 'utf8');
  });
}

/** Synthesize speech to a WAV buffer with Piper. */
export async function synthesizeSpeech(text, options = {}) {
  const status = ttsStatus();
  if (!status.enabled) {
    throw new HttpError(501, 'engine_disabled', 'Local speech was turned off in Admin → Hub → Engines.');
  }
  if (!status.available) {
    throw new HttpError(501, 'engine_missing', `Local speech is not installed on this server. ${status.hint}`);
  }
  const clean = String(text ?? '').replace(/\u0000/g, '').trim();
  if (!clean) throw new HttpError(400, 'empty_text', 'Type some text first.');
  if (clean.length > MAX_TEXT_CHARS) {
    throw new HttpError(413, 'text_too_long', `Speech is limited to ${MAX_TEXT_CHARS} characters per call.`);
  }

  const model = pickVoice(options);
  if (!existsFile(model)) {
    throw new HttpError(501, 'engine_missing', `The requested Piper voice is not installed (${model}). ${INSTALL_HINT}`);
  }
  const cfg = piperVoiceConfig(model);
  if (!existsFile(cfg)) {
    throw new HttpError(501, 'engine_missing', `The Piper voice config is missing (${cfg}). ${INSTALL_HINT}`);
  }
  const bin = piperBin();
  const espeak = piperDataDir(bin);
  const prefix = Array.isArray(config.get('hubPiperPrefixArgs')) ? config.get('hubPiperPrefixArgs').map(String) : [];

  return queueTts(async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cad-tts-'));
    const outFile = path.join(dir, 'speech.wav');
    try {
      const args = [
        ...prefix,
        '--model', model,
        '--config', cfg,
        '--output_file', outFile,
        '--quiet',
      ];
      if (existsDir(espeak)) args.push('--espeak_data', espeak);
      try {
        await runPiper(bin, args, clean);
      } catch (err) {
        throw new HttpError(502, 'engine_failed', `Piper could not make that speech: ${String(err?.message || err).slice(0, 400)}`);
      }
      const wav = await fsp.readFile(outFile);
      if (wav.length < 44 || wav.subarray(0, 4).toString('ascii') !== 'RIFF') {
        throw new HttpError(502, 'engine_failed', 'Piper returned no playable WAV audio.');
      }
      return { wav, voice: path.basename(model, '.onnx') };
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

// Optional whisper.cpp speech-to-text -------------------------------------------------------

function whisperPaths() {
  const bin = resolveFromData(config.get('hubWhisperBin'), path.join(ENGINE_ROOT(), 'whisper', process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'));
  const model = resolveFromData(config.get('hubWhisperModel'), path.join(ENGINE_ROOT(), 'whisper', 'ggml-base.en.bin'));
  const ffmpeg = resolveFromData(config.get('hubFfmpegBin'), path.join(ENGINE_ROOT(), 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'));
  return { bin, model, ffmpeg };
}
function sttStatus() {
  const { bin, model, ffmpeg } = whisperPaths();
  const available = existsFile(bin) && existsFile(model) && existsFile(ffmpeg);
  return {
    available,
    enabled: config.get('hubSttEnabled', true) !== false,
    model: path.basename(model),
    path: bin,
    hint: available ? '' : 'Speech-to-text is optional. Install whisper.cpp, a ggml model and ffmpeg under data/engines/whisper (see README §engines), or use the video-studio transcription with a cloud provider.',
  };
}

/**
 * Speech-to-text is deliberately optional. The adapter is kept honest: it
 * refuses with an installation message until the three binaries exist, and
 * never invents a transcript.
 */
export async function transcribeSpeech(buffer) {
  const status = sttStatus();
  if (!status.enabled) throw new HttpError(501, 'engine_disabled', 'Local speech-to-text was turned off in Admin → Hub → Engines.');
  if (!status.available) throw new HttpError(501, 'engine_missing', status.hint);
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new HttpError(400, 'bad_audio', 'Send an audio or video file.');
  if (buffer.length > MAX_AUDIO_BYTES) throw new HttpError(413, 'audio_too_large', 'That file is too large for local transcription (40 MB maximum).');
  throw new HttpError(501, 'engine_missing', 'The whisper.cpp adapter is not enabled yet on this server. Use the documented cloud option or install it as described in README §engines.');
}

// Image generation — cloud only, and only when the owner configures it ----------------------

function imageSettings() {
  const chosen = String(config.get('hubImageModel') || '').trim();
  const i = chosen.indexOf(':');
  if (i <= 0) return { model: null, provider: null, providerCfg: null };
  const providerId = chosen.slice(0, i);
  const model = chosen.slice(i + 1);
  const providerCfg = providerFor(providerId);
  return { model, provider: providerId, providerCfg };
}
function imageStatus() {
  const { model, provider, providerCfg } = imageSettings();
  const available = !!(model && providerCfg && (providerCfg.enabled || providerCfg.kind === 'test'));
  return {
    available,
    cloud: true,
    provider: provider || '',
    model: model || '',
    hint: available
      ? ''
      : 'Image generation is cloud-only on this server. Set an image model in Admin → Hub → Engines (for example openai:gpt-image-1) and add that provider’s key in Admin → AI. No Stable Diffusion runs on this CPU.',
  };
}

function imageDataUrl(buffer, mime = 'image/png') {
  return `data:${mime || 'image/png'};base64,${buffer.toString('base64')}`;
}

async function fetchImageUrl(url) {
  if (!/^https?:\/\//i.test(String(url))) throw new HttpError(502, 'bad_image', 'The image provider returned an unusable image address.');
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new HttpError(502, 'bad_image', `The image provider returned an image link that answered ${res.status}.`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length || buf.length > 25 * 1024 * 1024) throw new HttpError(502, 'bad_image', 'The image provider returned an empty or oversized image.');
  return imageDataUrl(buf, (res.headers.get('content-type') || 'image/png').split(';')[0]);
}

/** Cloud image generation through the provider's OpenAI-compatible endpoint. */
export async function generateImage({ prompt, options = {} } = {}) {
  const status = imageStatus();
  if (!status.available) throw new HttpError(501, 'engine_missing', status.hint);
  const clean = String(prompt ?? '').trim();
  if (!clean) throw new HttpError(400, 'empty_prompt', 'Describe the image you want.');
  if (clean.length > 4000) throw new HttpError(413, 'prompt_too_long', 'Image prompts are limited to 4000 characters.');
  const { model, providerCfg } = imageSettings();
  const size = /^\d{2,5}x\d{2,5}$/.test(String(options.size || '')) ? String(options.size) : '1024x1024';
  const body = { model, prompt: clean, n: 1, size };
  const headers = { 'Content-Type': 'application/json' };
  if (providerCfg.apiKey) headers.Authorization = `Bearer ${providerCfg.apiKey}`;
  const url = `${providerCfg.baseUrl}/images/generations`;

  const call = async (withFormat) => {
    const payload = withFormat ? { ...body, response_format: 'b64_json' } : body;
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(120_000) });
    } catch (err) {
      throw new HttpError(502, 'provider_unreachable', `Could not reach ${providerCfg.label}: ${String(err?.message || err).slice(0, 200)}`);
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      const message = String(data?.error?.message || data?.message || text || '').slice(0, 500);
      if (withFormat && res.status === 400 && /response_format|response format|unknown.*parameter/i.test(message)) return 'retry';
      throw new HttpError(502, 'provider_error', `${providerCfg.label} could not make that image: ${message || `HTTP ${res.status}`}`);
    }
    return data;
  };

  let data = await call(true);
  if (data === 'retry') data = await call(false);
  const first = Array.isArray(data?.data) ? data.data[0] : null;
  if (first?.b64_json) {
    const buf = Buffer.from(String(first.b64_json), 'base64');
    if (!buf.length) throw new HttpError(502, 'bad_image', 'The image provider returned an empty image.');
    return { dataUrl: imageDataUrl(buf), provider: status.provider, model };
  }
  if (first?.url) {
    return { dataUrl: await fetchImageUrl(first.url), provider: status.provider, model };
  }
  throw new HttpError(502, 'bad_image', 'The image provider returned no image.');
}

// Status + honest unsupported kinds ---------------------------------------------------------

export function engineStatus() {
  const stt = sttStatus();
  return {
    ocr: ocrStatus(),
    tts: ttsStatus(),
    image: imageStatus(),
    stt,
    txt2vid: {
      available: false,
      cloud: false,
      hint: 'Text-to-video has no provider on this server. The app stays local; use a cloud video tool outside CAD if you need it.',
    },
    installHint: INSTALL_HINT,
  };
}

/** Old names still used by hub-ai.js callers: keep the 501 envelope stable. */
export function engineError(kind, status = 501) {
  const e = engineStatus();
  const msg = kind === 'img2txt' ? e.ocr.hint
    : kind === 'txt2speech' ? e.tts.hint
      : kind === 'txt2img' ? e.image.hint
        : kind === 'speech2txt' ? e.stt.hint
          : e.txt2vid.hint;
  const entry = kind === 'img2txt' ? e.ocr
    : kind === 'txt2speech' ? e.tts
      : kind === 'txt2img' ? e.image
        : kind === 'speech2txt' ? e.stt
          : e.txt2vid;
  const code = entry?.enabled === false ? 'engine_disabled' : 'engine_missing';
  return new HttpError(status, code, msg || 'That engine is not available on this server.');
}

/** Append a row to ai_usage for an engine call (never throws). */
export function logEngine({ user, app, provider, model, input = 0, output = 0, ms = 0, status = 'ok', error = null }) {
  try {
    db.run(
      'INSERT INTO ai_usage(at, user, source, provider, model, input_tokens, output_tokens, ms, status, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      Date.now(), user || null, `hub:${app || '?'}`, provider, String(model || '').slice(0, 120),
      Math.max(0, Math.round(input)) || 0, Math.max(0, Math.round(output)) || 0, Math.max(0, Math.round(ms)),
      status, error == null ? null : String(error).slice(0, 300),
    );
  } catch { /* usage logging must never break a call */ }
}

/** Stop the OCR worker; registered as a server shutdown hook. */
export async function shutdownEngines() {
  await resetOcr();
}
