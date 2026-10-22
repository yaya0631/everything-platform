/**
 * Read and write .cad drawings on the server, the same way the app does in
 * app/src/io/native.js: gzip-compressed JSON { format: 'cad-drawing', ... }.
 * Plain JSON is accepted when reading.
 */
import zlib from 'node:zlib';
import { MAX_FILE } from './drive.js';

export const FORMAT = 'cad-drawing';
export const TABLES = ['layers', 'linetypes', 'textStyles', 'dimStyles'];

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** Drop malformed records so a damaged file still opens (matches native.js). */
export function validate(data) {
  data.entities = data.entities.filter((e) => e && typeof e === 'object' && typeof e.type === 'string' && finite(e.id));
  data.layers = (data.layers || []).filter((l) => l && typeof l.name === 'string');
  for (const t of ['linetypes', 'textStyles', 'dimStyles']) data[t] = (Array.isArray(data[t]) ? data[t] : []).filter((x) => x && typeof x.name === 'string');
  data.blocks = (data.blocks || []).filter((b) => b && typeof b.name === 'string' && Array.isArray(b.entities));
  data.header = data.header && typeof data.header === 'object' && !Array.isArray(data.header) ? data.header : {};
  return data;
}

export function decode(buf) {
  if (buf.length > MAX_FILE) throw new Error('That drawing is too large.');
  let bytes = buf;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = zlib.gunzipSync(bytes, { maxOutputLength: Math.max(MAX_FILE * 8, 64 * 1024 * 1024) });
  let data;
  try {
    data = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('This is not a drawing file.');
  }
  if (!data || (data.format && data.format !== FORMAT) || !Array.isArray(data.entities)) throw new Error('This is not a drawing file.');
  return validate(data);
}

export function encode(data) {
  return zlib.gzipSync(Buffer.from(JSON.stringify({ format: FORMAT, ...data })), { level: 6 });
}

/** FNV-1a over the entity id order; the app computes the same in collab/ops.js. */
export function orderDigest(ids) {
  let h = 0x811c9dc5;
  for (const id of ids) {
    const s = `${id},`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h.toString(16);
}
