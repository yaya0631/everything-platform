/**
 * JSON state readers tolerate a UTF-8 BOM. A state file re-saved by PowerShell
 * (build-state.json, a settings export) carries EF BB BF; without the strip
 * every read would throw and, for build state, silently cause a full rebuild.
 */
import fs from 'node:fs';

/** The first 3 bytes of a UTF-8 BOM as a JS string check. */
export function hasBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff;
}

export function stripBom(text) {
  return hasBom(text) ? text.slice(1) : text;
}

export function readJsonFile(file) {
  return JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
}
