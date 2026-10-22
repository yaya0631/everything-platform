const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('data/cad.db', { readOnly: true });
for (const app of ['music-studio', 'presentation', 'pos', 'tasks', 'contacts', 'crm', 'notes', 'solitaire', 'sudoku', 'projects']) {
  const rows = db.prepare("SELECT key, length(value) AS len FROM hub_kv WHERE user='appsmoke' AND app=? ORDER BY key").all(app);
  if (rows.length) console.log(app + ' KV:', JSON.stringify(rows));
}
fs = require('node:fs');
const root = 'data/hub-users/appsmoke';
const walk = (d, rel = '') => {
  let e;
  try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const x of e) {
    if (x.isDirectory()) walk(d + '/' + x.name, rel + x.name + '/');
    else console.log('FILE', rel + x.name, fs.statSync(d + '/' + x.name).size);
  }
};
walk(root);
