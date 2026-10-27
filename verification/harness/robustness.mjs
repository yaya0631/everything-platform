// Robustness battery against the isolated instance on :8090
const BASE = 'http://127.0.0.1:8090';
const H = { 'Content-Type': 'application/json', 'X-CAD-Request': '1' };
const out = [];
const log = (...a) => { console.log(...a); out.push(a.join(' ')); };

const login = async (u = 'ruser', p = 'R0bust!Pass') => {
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ username: u, password: p }) });
  return (r.headers.get('set-cookie') || '').split(';')[0].split('=')[1];
};

// phase 1: user exists? create via API if the server supports signup; else report
let tok = await login().catch(() => null);
if (!tok) {
  const su = await fetch(BASE + '/api/auth/signup', { method: 'POST', headers: H, body: JSON.stringify({ username: 'ruser', password: 'R0bust!Pass' }) }).catch(e => ({ status: 0, text: async () => String(e) }));
  log('signup status', su.status);
  tok = await login();
}
log('login:', tok ? 'OK' : 'FAIL');

// write kv + file
const C = { ...H, Cookie: 'cad_session=' + tok };
let r = await fetch(BASE + '/api/hub/kv/set', { method: 'POST', headers: C, body: JSON.stringify({ key: 'robust-marker', value: 'before-kill', app: 'notes' }) });
log('kv set:', r.status);
r = await fetch(BASE + '/api/hub/fs/write', { method: 'POST', headers: C, body: JSON.stringify({ path: 'robust.txt', content: 'survive-me', app: 'notes' }) });
log('fs write route:', r.status, (await r.text()).slice(0, 80));
r = await fetch(BASE + '/api/hub/fs/read?path=robust.txt&app=notes', { headers: C });
log('fs read:', r.status, (await r.text()).slice(0, 60));

// concurrency: 30 parallel kv sets distinct keys + 30 parallel gets
const t0 = Date.now();
const w = await Promise.all(Array.from({ length: 30 }, (_, i) =>
  fetch(BASE + '/api/hub/kv/set', { method: 'POST', headers: C, body: JSON.stringify({ key: 'conc-' + i, value: 'v' + i, app: 'notes' }) }).then(x => x.status)));
log('30 parallel writes:', w.every(s => s === 200) ? 'all 200' : 'MIX: ' + [...new Set(w)].join(','), 'in', Date.now() - t0, 'ms');
const g = await Promise.all(Array.from({ length: 30 }, (_, i) =>
  fetch(BASE + '/api/hub/kv/get', { method: 'POST', headers: C, body: JSON.stringify({ key: 'conc-' + i, app: 'notes' }) }).then(async x => (await x.text()).includes('"v' + i + '"'))));
log('30 parallel reads verified:', g.filter(Boolean).length + '/30');
console.log('PHASE1_DONE');
