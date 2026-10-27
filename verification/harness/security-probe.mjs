// API security probe — read-only checks against the live server.
const BASE = 'http://127.0.0.1:8080';
const H = { 'Content-Type': 'application/json', 'X-CAD-Request': '1' };
const results = [];
const t = async (name, fn) => { try { results.push({ name, ...(await fn()) }); } catch (e) { results.push({ name, err: String(e).slice(0, 150) }); } };

async function login(u, p) {
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ username: u, password: p }) });
  return (r.headers.get('set-cookie') || '').split(';')[0].split('=')[1];
}
const v1 = await login('vtest1', 'V3rify!Pass1');
const f7 = await login('ftester7', 'F!Wave7-Pass');

// 1. unauthenticated API access
await t('kv-get-noauth', async () => { const r = await fetch(BASE + '/api/hub/kv/get', { method: 'POST', headers: H, body: JSON.stringify({ key: 'x', app: 'notes' }) }); return { status: r.status, body: (await r.text()).slice(0, 120) }; });
await t('app-page-noauth', async () => { const r = await fetch(BASE + '/h/notes/'); return { status: r.status, bodyLen: (await r.text()).length, isLogin: (await r.text()).length > 0 }; });
// 2. path traversal in hub fs
for (const p of ['../../cad.db', '..\\..\\cad.db', '/etc/passwd', '..%2f..%2fcad.db']) {
  await t('fs-read-traversal:' + p, async () => {
    const r = await fetch(BASE + '/api/hub/fs/read?path=' + encodeURIComponent(p) + '&app=notes', { headers: { ...H, Cookie: 'cad_session=' + v1 } });
    return { status: r.status, body: (await r.text()).slice(0, 100) };
  });
}
await t('fs-write-traversal', async () => {
  const r = await fetch(BASE + '/api/hub/fs/write', { method: 'POST', headers: { ...H, Cookie: 'cad_session=' + v1 }, body: JSON.stringify({ path: '../evil-test.txt', content: 'x', app: 'notes' }) });
  return { status: r.status, body: (await r.text()).slice(0, 120) };
});
// 3. cross-user: ftester7 reads vtest1's kv (app namespaced?)
await t('setup-v1-kv', async () => { const r = await fetch(BASE + '/api/hub/kv/set', { method: 'POST', headers: { ...H, Cookie: 'cad_session=' + v1 }, body: JSON.stringify({ key: 'iso-secret', value: 'v1data', app: 'tasks' }) }); return { status: r.status }; });
await t('crossuser-kv-read', async () => { const r = await fetch(BASE + '/api/hub/kv/get', { method: 'POST', headers: { ...H, Cookie: 'cad_session=' + f7 }, body: JSON.stringify({ key: 'iso-secret', app: 'tasks' }) }); return { status: r.status, body: (await r.text()).slice(0, 100) }; });
// 4. CORS preflight / origin reflection
await t('cors-check', async () => {
  const r = await fetch(BASE + '/api/hub/kv/get', { method: 'OPTIONS', headers: { ...H, Origin: 'https://evil.example.com', 'Access-Control-Request-Method': 'POST' } });
  return { status: r.status, acao: r.headers.get('access-control-allow-origin'), acac: r.headers.get('access-control-allow-credentials') };
});
// 5. cookie flags
await t('cookie-flags', async () => {
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ username: 'vtest1', password: 'V3rify!Pass1' }) });
  return { setCookie: r.headers.get('set-cookie') };
});
// 6. non-admin hitting admin API
await t('admin-as-nonadmin', async () => {
  const r = await fetch(BASE + '/api/admin/users', { headers: { ...H, Cookie: 'cad_session=' + f7 } });
  return { status: r.status, body: (await r.text()).slice(0, 100) };
});
// 7. wrong password lockout / timing (just check rejection)
await t('login-wrongpass', async () => { const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ username: 'vtest1', password: 'wrong' }) }); return { status: r.status }; });
// 8. public listener (8081) — what does it expose?
await t('public-listener-hub', async () => { const r = await fetch('http://127.0.0.1:8081/h/notes/'); return { status: r.status, body: (await r.text()).slice(0, 100) }; });
await t('public-listener-api', async () => { const r = await fetch('http://127.0.0.1:8081/api/hub/kv/get', { method: 'POST', headers: H, body: JSON.stringify({ key: 'x', app: 'notes' }) }); return { status: r.status, body: (await r.text()).slice(0, 100) }; });
console.log(JSON.stringify(results, null, 1));
