import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// Sets CAD_DATA_DIR to a per-file temp dir BEFORE any db import (never the real data).
import { DATA } from './helpers.js';
void DATA;

// The db integrity gate runs at open() against data/cad.db inside the test's
// own CAD_DATA_DIR (helpers sets that before this import). Each test closes
// the module handle so the following open() re-runs the gate.
async function freshDbModule() {
  const db = await import('../lib/db.js');
  db.close();
  return db;
}

test('a clean database opens normally and passes the gate', async () => {
  const db = await freshDbModule();
  db.open();
  assert.ok(fs.existsSync(path.join(process.env.CAD_DATA_DIR, 'cad.db')), 'db file exists');
  db.close();
});

test('a malformed database file refuses to open, after backing the bytes up', async () => {
  const db = await freshDbModule();
  db.open(); // create a healthy db first
  db.close();
  // Corrupt the main file: overwrite enough of the header/pages that neither
  // the open nor the integrity check can pass. SQLite notices page-level
  // damage (the cf record links stay intact - nothing in the file is valid).
  const file = path.join(process.env.CAD_DATA_DIR, 'cad.db');
  const bytes = fs.readFileSync(file);
  bytes.writeInt32LE(0x00DEAD00, 16);
  for (let i = 96; i < 4096; i++) bytes[i] = (i * 7) & 0xff; // flatten page 1
  fs.writeFileSync(file, bytes);
  let caught = null;
  try { db.open(); } catch (e) { caught = e; }
  assert.ok(caught && /cannot be opened|failed its integrity check|malformed/i.test(caught.message),
    `the gate must refuse a malformed db (got: ${caught ? caught.message.slice(0, 90) : 'no throw'})`);
  const dirs = fs.readdirSync(process.env.CAD_DATA_DIR).filter((d) => d.startsWith('_dbrecover-'));
  assert.equal(dirs.length, 1, 'exactly one recover copy was made');
  const backup = path.join(process.env.CAD_DATA_DIR, dirs[0], 'cad.db');
  assert.ok(fs.existsSync(backup), 'the byte copy of cad.db exists in the recover dir');
  assert.equal(fs.statSync(backup).size, fs.statSync(file).size, 'the copy is full-size');
  // The gate must make another backup on the next refusal, never delete data.
  fs.unlinkSync(backup);
});

test('a healthy database (re)opens after the corrupt file is replaced', async () => {
  const db = await freshDbModule();
  fs.rmSync(path.join(process.env.CAD_DATA_DIR, 'cad.db'), { force: true });
  db.open(); // fresh db
  assert.ok(fs.existsSync(path.join(process.env.CAD_DATA_DIR, 'cad.db')), 'db file created again');
  assert.equal(db.get('SELECT 1 x').x, 1, 'the db is usable');
  db.close();
});
