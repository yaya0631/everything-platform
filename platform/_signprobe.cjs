#!/usr/bin/env node
/** Probe the persisted sign-e2e state: last worker row + its kv rows. */
const sql = require('node:sqlite');
const db = new sql.DatabaseSync('data/cad.db', { readOnly: true });
const rows = db.prepare('SELECT id,user,app,name,host_label FROM hub_workers ORDER BY id DESC LIMIT 4').all();
console.log(JSON.stringify(rows, null, 1));
const kv = db.prepare("SELECT user,key,substr(value,1,60) v FROM hub_kv WHERE key LIKE 'sigw:%' OR key LIKE 'sig:%' ORDER BY rowid DESC LIMIT 8").all();
console.log('kv rows:', JSON.stringify(kv, null, 1));
