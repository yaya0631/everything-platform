/**
 * Safety snapshots of live drawings: data/history/<owner>/<sha1(path)>/<time>.cad.
 * Taken when a live room opens, every 30 minutes of activity, and before a
 * restore. The newest 30 per drawing are kept.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import * as db from './db.js';
import * as store from './store.js';
import { HISTORY_DIR } from './paths.js';

export const KEEP = 30;

const dirFor = (owner, ownerRel) => path.join(owner, crypto.createHash('sha1').update(process.platform === 'win32' ? ownerRel.toLowerCase() : ownerRel).digest('hex'));

/** Save bytes as a snapshot. Returns the history row id. */
export async function snapshotBytes(owner, ownerRel, bytes, reason, by) {
  const rel = path.join(dirFor(owner, ownerRel), `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}.cad`);
  const full = path.join(HISTORY_DIR, rel);
  await fsp.mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
  await fsp.writeFile(full, bytes, { mode: 0o600 });
  const id = Number(db.run('INSERT INTO history(owner, path, file, created, size, reason, by) VALUES (?, ?, ?, ?, ?, ?, ?)', owner, ownerRel, rel.split(path.sep).join('/'), Date.now(), bytes.length, reason, by || null).lastInsertRowid);
  await trim(owner, ownerRel);
  return id;
}

/** Copy the file on disk, if there is one. */
export async function snapshotFile(owner, ownerRel, full, reason, by) {
  let bytes;
  try {
    bytes = await fsp.readFile(full);
  } catch {
    return null;
  }
  return snapshotBytes(owner, ownerRel, bytes, reason, by);
}

async function trim(owner, ownerRel) {
  const old = db.all('SELECT id, file FROM history WHERE owner = ? AND path = ? ORDER BY created DESC, id DESC LIMIT -1 OFFSET ?', owner, ownerRel, KEEP);
  for (const row of old) {
    db.run('DELETE FROM history WHERE id = ?', row.id);
    await fsp.rm(path.join(HISTORY_DIR, row.file), { force: true });
  }
}

export function list(owner, ownerRel) {
  return db.all('SELECT id, created, size, reason, by FROM history WHERE owner = ? AND path = ? ORDER BY created DESC, id DESC', owner, ownerRel).map((r) => ({ ...r, byName: r.by ? store.displayName(r.by) : null }));
}

export function find(owner, ownerRel, id) {
  const row = db.get('SELECT * FROM history WHERE id = ? AND owner = ? AND path = ?', Number(id), owner, ownerRel);
  return row ? { ...row, full: path.join(HISTORY_DIR, row.file) } : null;
}

export async function read(row) {
  return fsp.readFile(row.full);
}

// Removing an account removes its snapshots.
store.onRemoveUser((name) => {
  fs.rmSync(path.join(HISTORY_DIR, name), { recursive: true, force: true });
});
