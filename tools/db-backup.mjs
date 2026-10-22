#!/usr/bin/env node
/**
 * Safe database snapshot: `node tools/db-backup.mjs` writes
 * data\backups\cad-<stamp>.db using SQLite's VACUUM INTO (one consistent
 * copy of every committed page). It may run WHILE the server is up — the
 * server's WAL keeps readers consistent; the copy is a plain file with no
 * sidecar state. Copying data\ by hand instead is only safe after a clean
 * server stop (see README).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const dbFile = path.join(ROOT, 'data', 'cad.db');
const outDir = path.resolve(process.argv[2] ?? path.join(ROOT, 'data', 'backups'));
const stamp = new Date().toISOString().replace(/[-:T]/g, '').replace(/\..*$/, '').slice(0, 14);
const target = path.join(outDir, `cad-${stamp}.db`);

if (!fs.existsSync(dbFile)) {
  console.error(`db-backup: there is no database at ${dbFile} yet (did the server ever run?).`);
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

// Keep node:sqlite's experimental warning quiet the way lib/db.js does.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w?.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
  if (w?.name === 'DeprecationWarning' && process.noDeprecation) return;
  process.stderr.write(`(node:${process.pid}) ${w?.name || 'Warning'}: ${w?.message ?? w}\n`);
});
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(dbFile, { readOnly: true });
try {
  // Single-quote the target per SQLite string-literal rules (' → '').
  const sqlTarget = target.replace(/\\/g, '/').replace(/'/g, "''");
  db.exec(`VACUUM INTO '${sqlTarget}'`);
} finally {
  db.close();
}
const size = fs.statSync(target).size;
console.log(`db-backup: wrote ${target} (${size.toLocaleString()} bytes)`);
