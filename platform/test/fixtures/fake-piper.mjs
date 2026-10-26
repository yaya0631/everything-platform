#!/usr/bin/env node
/** A tiny Piper stand-in for tests: reads stdin, writes a valid 8 kHz WAV. */
import fs from 'node:fs';

const args = process.argv.slice(2);
const at = args.indexOf('--output_file');
const out = at >= 0 ? args[at + 1] : '';
const text = fs.readFileSync(0, 'utf8');
if (!out || !text) {
  console.error('fake-piper: need --output_file and stdin text');
  process.exit(2);
}
const samples = 800; // 0.1 s of silence at 8 kHz
const wav = Buffer.alloc(44 + samples * 2);
wav.write('RIFF', 0);
wav.writeUInt32LE(36 + samples * 2, 4);
wav.write('WAVE', 8);
wav.write('fmt ', 12);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(samples * 2, 40);
fs.writeFileSync(out, wav);
