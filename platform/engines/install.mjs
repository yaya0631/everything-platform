#!/usr/bin/env node
/**
 * Install the optional local AI engines under data/engines (gitignored):
 *
 *   npm run engines:install             Tesseract OCR + Piper speech
 *   npm run engines:install -- --check  print what is installed
 *   npm run engines:install -- --force  re-download
 *   npm run engines:install -- --langs eng,fra
 *
 * The server never downloads anything at call time. This script is the one
 * network step, run by the owner on the host. Pinned SHA-256 values make a
 * changed download fail loudly instead of silently installing something else.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const platform = path.resolve(here, '..');
const engines = path.join(platform, 'data', 'engines');
const cache = path.join(engines, '.cache');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const force = flag('--force');
const checkOnly = flag('--check');
const langs = String(value('--langs', 'eng')).split(',').map((s) => s.trim()).filter((s) => /^[a-z]{3}$/.test(s));
if (!langs.length || langs.some((l) => !/^[a-z]{3}$/.test(l))) {
  console.error('--langs takes three-letter codes such as eng,fra.');
  process.exit(2);
}

const TESSDATA = 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main';
const PINNED = {
  'eng.traineddata': {
    url: `${TESSDATA}/eng.traineddata`,
    sha256: '7D4322BD2A7749724879683FC3912CB542F19906C83BCC1A52132556427170B2',
  },
};
const PIPER = {
  version: '2023.11.14-2',
  zip: 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip',
  zipSha256: 'F3C58906402B24F3A96D92145F58ACBA6D86C9B5DB896D207F78DC80811EFCEA',
  voice: 'en_US-ljspeech-medium',
  voiceBase: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ljspeech/medium',
  voiceSha256: '6F52A751E2349ABE7A76735EB09DC1875298C77EA2342FFD2FEF79FF81B87F22',
  configSha256: '141D612CC0A95ED7EFC1CA936B845C2364967F2E9217C5DBFCF69FC4D6C65860',
};

const sha256 = (file) => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex').toUpperCase()));
});

async function download(url, file, expected) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && !force) {
    if (!expected) {
      console.log(`have ${path.relative(platform, file)} (no pinned hash)`);
      return;
    }
    const got = await sha256(file);
    if (got === expected) {
      console.log(`have ${path.relative(platform, file)} (sha256 ok)`);
      return;
    }
    console.log(`stale ${path.relative(platform, file)}; re-downloading`);
  }
  const part = `${file}.part`;
  await fsp.rm(part, { force: true });
  console.log(`download ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let seen = 0;
  const out = fs.createWriteStream(part);
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      seen += chunk.length;
      if (total) process.stdout.write(`\r  ${(seen / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`);
      if (!out.write(Buffer.from(chunk))) await new Promise((r) => out.once('drain', r));
    }
  } finally {
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    if (total) process.stdout.write('\n');
  }
  if (expected) {
    const got = await sha256(part);
    if (got !== expected) {
      await fsp.rm(part, { force: true });
      throw new Error(`sha256 mismatch for ${url}\n  expected ${expected}\n  got      ${got}`);
    }
  }
  await fsp.rename(part, file);
  console.log(`saved ${path.relative(platform, file)}`);
}

async function extractZip(zip, dest) {
  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.mkdir(dest, { recursive: true });
  const run = (cmd, a) => new Promise((resolve, reject) => {
    const p = spawn(cmd, a, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(-500)}`))));
  });
  try {
    await run('tar', ['-xf', zip, '-C', dest]);
  } catch (err) {
    if (process.platform !== 'win32') throw err;
    await run('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`]);
  }
}

function installed() {
  const tesseract = path.join(engines, 'tesseract');
  const piper = path.join(engines, 'piper');
  const ocr = langs.filter((l) => fs.existsSync(path.join(tesseract, `${l}.traineddata`)));
  const tts = fs.existsSync(path.join(piper, 'piper.exe')) && fs.existsSync(path.join(piper, `${PIPER.voice}.onnx`)) && fs.existsSync(path.join(piper, `${PIPER.voice}.onnx.json`));
  return { ocr, tts, tesseract, piper };
}

if (checkOnly) {
  const now = installed();
  console.log(`OCR:   ${now.ocr.length ? `ready (${now.ocr.join(', ')})` : 'not installed'}`);
  console.log(`Speech: ${now.tts ? `ready (${PIPER.voice})` : 'not installed'}`);
  console.log(`Paths: ${now.tesseract} ; ${now.piper}`);
  process.exit(now.ocr.length && now.tts ? 0 : 1);
}

const errors = [];
try {
  await fsp.mkdir(engines, { recursive: true });
  console.log('Tesseract OCR');
  for (const lang of langs) {
    const pinned = PINNED[`${lang}.traineddata`];
    const dest = path.join(engines, 'tesseract', `${lang}.traineddata`);
    await download(pinned?.url || `${TESSDATA}/${lang}.traineddata`, dest, pinned?.sha256 || null);
  }
} catch (err) {
  errors.push(`OCR: ${err.message}`);
}

try {
  console.log('\nPiper speech');
  const zip = path.join(cache, 'piper_windows_amd64.zip');
  await download(PIPER.zip, zip, PIPER.zipSha256);
  const tmp = path.join(cache, 'piper-extract');
  await extractZip(zip, tmp);
  const piperDir = path.join(engines, 'piper');
  await fsp.mkdir(piperDir, { recursive: true });
  // The release zip contains a top-level piper/ directory. Copy its contents
  // beside the voice model; do not wipe an existing voice.
  const nested = path.join(tmp, 'piper');
  const source = fs.existsSync(nested) ? nested : tmp;
  await fsp.cp(source, piperDir, { recursive: true, force: true });
  await download(`${PIPER.voiceBase}/${PIPER.voice}.onnx`, path.join(piperDir, `${PIPER.voice}.onnx`), PIPER.voiceSha256);
  await download(`${PIPER.voiceBase}/${PIPER.voice}.onnx.json`, path.join(piperDir, `${PIPER.voice}.onnx.json`), PIPER.configSha256);
  await fsp.rm(tmp, { recursive: true, force: true });
  await fsp.rm(zip, { force: true });
} catch (err) {
  errors.push(`Speech: ${err.message}`);
}

const now = installed();
console.log('\nInstalled:');
console.log(`  OCR:    ${now.ocr.length ? now.ocr.join(', ') : 'missing'}`);
console.log(`  Speech: ${now.tts ? PIPER.voice : 'missing'}`);
if (errors.length) {
  for (const e of errors) console.error(`FAILED ${e}`);
  process.exit(1);
}
console.log('\nRestart the platform server (or reload the page) to pick the engines up.');
