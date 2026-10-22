/**
 * DXF module worker. Keeps parsing and writing of large files off the main
 * thread.
 *
 * Messages in:
 *   { id, op: 'parse', buffer: ArrayBuffer | Uint8Array | string, opts? }
 *   { id, op: 'write', drawing, opts? }
 *     Callbacks cannot cross the worker boundary, so for dimensions pass
 *     opts.dimBlocks ({ [entityId]: Entity[] }) and for hatch patterns pass
 *     opts.hatchPatterns ({ [name]: PatternLine[] }).
 *
 * Messages out:
 *   { id, ok: true, result }   parse: { drawing, warnings, stats }
 *                              write: { text, warnings }
 *   { id, ok: false, error }
 */
import { parseDxf } from './reader.js';
import { writeDxf } from './writer.js';

/** Handle one request and return the reply message. */
export function handleMessage(data) {
  const id = data?.id;
  try {
    if (data?.op === 'parse') {
      return { id, ok: true, result: parseDxf(data.buffer, data.opts || {}) };
    }
    if (data?.op === 'write') {
      const warnings = [];
      const opts = { ...(data.opts || {}), warnings };
      delete opts.dimensionEntities;
      delete opts.hatchPattern;
      const text = writeDxf(data.drawing, opts);
      return { id, ok: true, result: { text, warnings } };
    }
    return { id, ok: false, error: `Unknown operation '${data?.op}'` };
  } catch (err) {
    return { id, ok: false, error: err?.message ?? String(err) };
  }
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
  self.onmessage = (ev) => {
    self.postMessage(handleMessage(ev.data));
  };
}
