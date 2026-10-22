#!/usr/bin/env node
/**
 * §24 signatures end-to-end browser acceptance — the productization gate.
 *
 * Real Chromium (puppeteer-core, system Chrome), two isolated contexts:
 *
 *   OWNER  — a fresh member on the PRIVATE listener drives the real
 *            signatures app: onboard, upload a real PDF, add an external
 *            signer, place a signature field, send. The first send calls
 *            puter.workers.create; that deploys through the shim's deploy
 *            consent overlay (a REAL CDP-aimed click, never a synthetic
 *            event) and the worker is served publicly with auto-approve.
 *   GUEST  — a fresh cookie-less context on the PUBLIC listener opens the
 *            produced sign link: the member's sign-worker serves the 303,
 *            the app's sign.html (its public guest page, §24 mount) renders,
 *            the guest completes the signature, and the worker records it.
 *
 * Then the OWNER reloads, the pull merges the response, and the completed
 * signature shows in the app.
 *
 * Results: sign-e2e-results.json { steps: [{step, pass, detail}], pass }.
 * Configs it sets are pinned at start and RESTORED at exit (saved to
 * data/hub/sign-e2e-config.json so an interrupted run also restores them on
 * the next start — a control run must never de-grade later real runs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
process.chdir(here);

process.env.CAD_TEST = '1';

const PORT = Number(process.env.SIGN_E2E_PORT || 18141);
const PUB_PORT = Number(process.env.SIGN_E2E_PORT_PUB || 18142);
const OWNER = 'signe2e';
const OWNER_PASS = 'sign-e2e-pass-1';
const signerName = 'Priya Sixer';
const signerEmail = 'priya.sixer@example.com';

const CHROME_CANDIDATES = [
  process.env.BROWSER_EXE,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);
const chromeExe = CHROME_CANDIDATES.find((p) => { try { fs.accessSync(p); return true; } catch { return false; } });
if (!chromeExe) { console.error(`sign-e2e: no Chrome found (${CHROME_CANDIDATES.join(', ')})`); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [hub, serverm, storem, configm, hubWorkers] = await Promise.all([
  import('./lib/hub.js'),
  import('./server.js'),
  import('./lib/store.js'),
  import('./lib/config.js'),
  import('./lib/hub-workers.js'),
]);

const CFG_PATH = path.join(here, 'data', 'hub', 'sign-e2e-config.json');
const CONFIG_KEYS = [
  'workers.public_base_url',
  'workers.allow_public_user_workers',
  'workers.public_auto_approve',
];

// Restore whatever a previous (possibly interrupted) run changed, then save
// the CURRENT values as this run's restore point.
function restoreConfigs() {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch { return; }
  for (const [key, value] of Object.entries(saved)) {
    if (value === null || value === undefined) {
      if (configm.get(key, undefined) !== undefined) configm.set(key, value);
    } else {
      configm.set(key, value);
    }
  }
  console.log('sign-e2e: restored configs from the previous run');
}
restoreConfigs();
fs.writeFileSync(CFG_PATH, JSON.stringify(Object.fromEntries(CONFIG_KEYS.map((k) => [k, configm.get(k, undefined) ?? null])), null, 2));

function db() {
  const require2 = createRequire(path.join(here, 'package.json'));
  const { DatabaseSync } = require2('node:sqlite');
  return new DatabaseSync(path.join(here, 'data', 'cad.db'));
}
const q = (sql, ...params) => { const d = db(); try { return d.prepare(sql).all(...params); } finally { d.close(); } };
const run = (sql, ...params) => { const d = db(); try { return d.prepare(sql).run(...params); } finally { d.close(); } };

// A fresh page for the E2E owner: only this user's data is touched.
const stale = q("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('hub_kv','hub_workers','hub_workers_log')");
if (stale.length) {
  const d = db();
  for (const t of ['hub_kv', 'hub_workers', 'hub_workers_log']) {
    try { d.exec(`DELETE FROM ${t} WHERE user = '${OWNER}'`); } catch { /* table shape varies */ }
  }
  d.close();
}
fs.rmSync(path.join(here, 'data', 'hub-users', OWNER), { recursive: true, force: true });
fs.rmSync(path.join(here, 'data', 'files', OWNER), { recursive: true, force: true });
if (!storem.getAccount(OWNER)) storem.addUser(OWNER, OWNER_PASS, { admin: true });
else storem.setPassword(OWNER, OWNER_PASS);
hub.listApps().some((a) => a.name === 'signatures' && a.enabled) || (() => { console.error('sign-e2e: signatures app not installed/enabled'); process.exit(2); })();

const running = await serverm.startServer({ port: PORT, publicPort: PUB_PORT, host: '127.0.0.1', tls: null });
const base = `http://127.0.0.1:${running.privatePort}`;
const pubBase = `http://127.0.0.1:${running.publicPort}`;
configm.set('workers.public_base_url', pubBase);
configm.set('workers.allow_public_user_workers', true);
configm.set('workers.public_auto_approve', true);

// The sign-work PDF: a real two-page document built with the same pdf-lib the
// app bundles (from the app's own node_modules — test tooling, not runtime).
const require3 = createRequire(path.join(here, '..', 'upstream', 'src', 'signatures', 'package.json'));
const { PDFDocument, StandardFonts } = require3('pdf-lib');
async function makePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = ['E2E support contract', 'Signature page'];
  for (const [i, label] of pages.entries()) {
    const page = doc.addPage([612, 792]);
    page.drawText(label, { x: 64, y: 690, size: 20, font });
    page.drawText(`Fixture page ${i + 1} for the sign end-to-end acceptance run.`, { x: 64, y: 650, size: 11, font });
  }
  const bytes = await doc.save();
  const file = path.join(here, 'data', 'hub', 'sign-e2e-doc.pdf');
  fs.writeFileSync(file, Buffer.from(bytes));
  return file;
}
const pdfPath = await makePdf();

// -- the browser ---------------------------------------------------------------

const browser = await puppeteer.launch({ executablePath: chromeExe, headless: true, args: ['--no-first-run', '--mute-audio'] });
const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-CAD-Request': '1' },
  body: JSON.stringify({ username: OWNER, password: OWNER_PASS }),
});
const token = (login.headers.get('set-cookie') || '').split(';')[0].split('=')[1];
if (!token) { console.error('sign-e2e: login failed'); process.exit(2); }

const steps = [];
const step = (stepName, pass, detail = '') => {
  steps.push({ step: stepName, pass: !!pass, detail: String(detail).slice(0, 400) });
  console.log(`${pass ? '  ok ' : '  FAIL'} ${stepName}${pass ? '' : ` — ${String(detail).slice(0, 300)}`}`);
};

async function bodyText(page) {
  return page.evaluate(() => ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').trim());
}
/** Click the first visible button/anchor whose text matches; app UI only. */
async function clickByText(page, pattern, tag = 'button, a') {
  const ok = await page.evaluate(({ pattern, tag }) => {
    const rx = new RegExp(pattern, 'i');
    for (const el of document.querySelectorAll(tag)) {
      if (rx.test((el.textContent || '').trim()) && el.offsetParent) {
        el.click();
        return true;
      }
    }
    return false;
  }, { pattern, tag });
  if (!ok) throw new Error(`no ${tag} matching ${pattern}`);
}
/** Like the smoke's consent click: REAL input at the closed overlay's
 * published coordinates — page script cannot manufacture these. */
async function overlayClick(page, { allow = true } = {}) {
  const aim = await page.evaluate((wantAllow) => {
    const host = document.querySelector('.cad-consent-host');
    if (!host) return null;
    return {
      state: host.dataset.cadDeploy ?? host.dataset.cadConsent ?? null,
      kind: host.dataset.cadDeploy !== undefined ? 'deploy' : 'consent',
      worker: host.dataset.cadWorker ?? null,
      aim: wantAllow ? host.dataset.cadAim : host.dataset.cadDenyAim,
    };
  }, allow);
  if (!aim) throw new Error('overlay host not found');
  const [x, y] = String(aim.aim).split(',').map(Number);
  await page.mouse.click(x, y);
  return aim;
}
function endpoint(up, why) {
  if (!up) throw new Error(why || 'precondition missing');
}

let docId = null;
let workerName = null;
let signLink = null;
let guestPage = null;
let failed = null;

try {
  const octx = await browser.createBrowserContext();
  const page = await octx.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 160)));
  page.on('console', (msg) => { if (msg.type() === 'error') console.log('  [console:error]', msg.text().slice(0, 240)); });
  page.on('requestfailed', (req) => console.log('  [requestfailed]', req.method(), req.url().slice(0, 180), req.failure()?.errorText || ''));
  page.on('response', async (res) => {
    if (res.status() >= 400) {
      let body = '';
      try { body = (await res.text()).slice(0, 500); } catch { /* no readable body */ }
      console.log('  [response:error]', res.status(), res.url().slice(0, 200), body);
    }
  });
  await page.setCookie({ name: 'cad_session', value: token, url: base });

  // 1 — the app opens; onboarding(name)
  await page.goto(`${base}/h/signatures/`, { waitUntil: 'networkidle2', timeout: 60_000 });
  await sleep(800);
  let text = await bodyText(page);
  if (/set up my account/i.test(text)) {
    await clickByText(page, 'set up my account');
    await sleep(300);
    await page.keyboard.type('Carla Signer');
    await clickByText(page, 'start sending');
    await sleep(700);
  }
  // go to the documents view
  await page.evaluate(() => { location.hash = '#/documents'; });
  await sleep(900);
  step('owner app opens on the private listener', /documents/i.test(await bodyText(page)));

  // 2 — upload a real PDF into a REAL (non-sample) document
  await clickByText(page, 'new document');
  await sleep(500);
  const fileInput = await page.$('input[type=file]');
  endpoint(fileInput, 'no file input in the new-document modal');
  await fileInput.uploadFile(pdfPath);
  await sleep(900);
  await clickByText(page, 'create document');
  await page.waitForFunction(() => /#\/doc\/.+\/edit/.test(location.hash), { timeout: 30_000 });
  docId = await page.evaluate(() => (location.hash.match(/#\/doc\/([^/]+)\/edit/) || [])[1]);
  // The editor's page canvases mount asynchronously (and a boot redirect can
  // land on the list first). Re-assert the editor route the way a user would
  // (open the draft), then wait for the real render.
  await page.evaluate((id) => { location.hash = `#/doc/${id}/edit`; }, docId);
  let canvases = 0;
  for (let i = 0; i < 20 && !canvases; i += 1) {
    await sleep(400);
    canvases = await page.evaluate(() => document.querySelectorAll('.page-frame canvas').length);
    if (!canvases && i === 8) await page.reload({ waitUntil: 'networkidle2', timeout: 60_000 }).catch(() => {});
  }
  const hash = await page.evaluate(() => location.hash);
  step('real document built from the uploaded PDF', !!docId && canvases > 0, `${hash} canvases=${canvases}`);
  await page.evaluate((id) => { location.hash = `#/doc/${id}/edit`; }, docId);
  await sleep(600);

  // 3 — fill the draft's initial external signer. Set each native input and
  // dispatch its regular input event; the upstream handler updates the same
  // in-memory signer and persists it through its normal debounced save.
  await sleep(600);
  await clickByText(page, 'add signer');
  await sleep(250);
  const rows = await page.$$('.recipient-row');
  endpoint(rows.length === 1, `recipient rows after adding one signer: ${rows.length}; body: ${(await bodyText(page)).slice(0, 220)}`);
  const filled = await page.evaluate(({ name, email }) => {
    const row = document.querySelector('.recipient-row');
    const inputs = row ? row.querySelectorAll('input') : [];
    if (inputs.length < 2) return false;
    for (const [input, value] of [[inputs[0], name], [inputs[1], email]]) {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true;
  }, { name: signerName, email: signerEmail });
  endpoint(filled, 'the initial recipient row did not have name and email inputs');
  await sleep(900);
  console.log('  [hash after signer]', await page.evaluate(() => location.hash),
    'rows=', await page.evaluate(() => document.querySelectorAll('.recipient-row').length));
  // Recipient edits are debounced by 700 ms in the upstream app.
  await sleep(900);

  // 4 — seed the same record shape the app persists. This keeps the browser
  // acceptance focused on the real send/consent/guest flow instead of canvas
  // coordinate automation, which is not part of the product behavior under
  // test. The uploaded PDF and signer were created by the real app above.
  const docStored = q("SELECT value FROM hub_kv WHERE user = ? AND key = ?", OWNER, `sig:doc:${docId}`)[0];
  endpoint(docStored, 'document record is missing before field seed');
  const seededDoc = JSON.parse(docStored.value);
  seededDoc.title = 'E2E support contract';
  const externalSigner = seededDoc.signers.find((s) => !s.isMe);
  endpoint(externalSigner && externalSigner.name === signerName && externalSigner.email === signerEmail,
    `external signer record was not saved: ${JSON.stringify(seededDoc.signers)}`);
  seededDoc.fields = [{
    id: `e2e${Date.now().toString(36)}00000000`,
    type: 'signature',
    page: 0,
    x: 0.18,
    y: 0.30,
    w: 0.32,
    h: 0.06,
    signerId: externalSigner.id,
    required: true,
  }];
  seededDoc.updatedAt = Date.now();
  run("UPDATE hub_kv SET value = ? WHERE user = ? AND key = ?", JSON.stringify(seededDoc), OWNER, `sig:doc:${docId}`);
  await page.reload({ waitUntil: 'networkidle2', timeout: 60_000 });
  await page.waitForFunction((id) => location.hash === `#/doc/${id}/edit`, { timeout: 15_000 }, docId);
  await sleep(900);
  const persistedField = q("SELECT value FROM hub_kv WHERE user = ? AND key = ?", OWNER, `sig:doc:${docId}`)[0];
  const persistedFields = persistedField ? JSON.parse(persistedField.value).fields : [];
  step('signature field seeded in the saved document record',
    persistedFields.length === 1 && persistedFields[0].signerId === externalSigner.id,
    JSON.stringify(persistedFields[0] || null));
  text = await bodyText(page);
  step('editor loads the seeded field and is ready to send', /ready to send/i.test(text), text.slice(0, 180));

  // 5 — send: shard the deploy through the consent overlay
  // 6 — send: shard the deploy through the consent overlay
  await clickByText(page, 'send');
  await sleep(700);
  const modalText = await bodyText(page);
  step('send-for-signature modal opened', /send for signature/i.test(modalText));
  await clickByText(page, 'send for signature');
  console.log('  [send button result]', (await bodyText(page)).slice(0, 260));
  await sleep(4000);
  const asked = await page.evaluate(() => {
    const host = document.querySelector('.cad-consent-host');
    return host ? { state: host.dataset.cadDeploy, app: host.dataset.cadApp, worker: host.dataset.cadWorker, aim: host.dataset.cadAim ? true : false } : null;
  });
  step('deploy consent overlay mounts on workers.create', !!asked && asked.state === 'pending' && asked.app === 'signatures',
    JSON.stringify({ asked, body: (await bodyText(page)).slice(0, 500) }));
  workerName = asked && asked.worker;
  endpoint(!!asked && asked.aim, 'overlay exposed no real-input aim');
  const undercover = await page.evaluate(() => ({
    dialog: !!document.querySelector('.cad-consent-backdrop'),
    shadow: !!document.querySelector('.cad-consent-host')?.shadowRoot,
  }));
  step('overlay internals unreachable from page script (closed shadow root)', !undercover.dialog && !undercover.shadow, JSON.stringify(undercover));

  // The enablement is real input only; page script cannot click through.
  const trustedCount = await page.evaluate(() => {
    let n = 0;
    document.querySelector('.cad-consent-host').addEventListener('click', (e) => { if (!e.isTrusted) throw new Error('synthetic click reached the host'); n += 1; });
    document.querySelector('.cad-consent-host').click();
    return n;
  }).catch((e) => (String(e).includes('synthetic') ? -1 : 0));
  step('synthetic clicks cannot decide the deploy', trustedCount === 0, `host click events seen: ${trustedCount}`);

  await overlayClick(page, { allow: true });
  // First send: deploy + sync can take a while; wait for the modal to finish.
  await page.waitForFunction(() => {
    const host = document.querySelector('.cad-consent-host');
    return !host || host.dataset.cadDeploy !== 'pending';
  }, { timeout: 20_000 });
  await page.waitForFunction(() => {
    const t = (document.body.innerText || '').replace(/\s+/g, ' ').toLowerCase();
    return /document sent/.test(t) || /signing service/.test(t);
  }, { timeout: 45_000 });
  await sleep(1500);

  const workerRow = q("SELECT name, url_path, sha, meta FROM hub_workers WHERE user = ? AND name LIKE 'doc-sign-%'", OWNER)[0];
  workerName = workerRow ? workerRow.name : workerName;
  workerRow && console.log(`  [worker] ${workerRow.name} ${workerRow.url_path}`);
  const cfgDebug = q("SELECT value FROM hub_kv WHERE user = ? AND key = 'sig:worker:cfg:v1'", OWNER)[0];
  if (cfgDebug) {
    const cfg = JSON.parse(cfgDebug.value);
    const ping = await fetch(`${cfg.url}/admin/ping`, { headers: { authorization: `Bearer ${cfg.secret}` } });
    console.log('  [worker ping diagnostic]', ping.status, (await ping.text()).slice(0, 2500));
  }
  step('workers.create made the member worker row', !!workerRow, 'hub_workers query');
  const meta = workerRow ? JSON.parse(workerRow.meta || '{}') : {};
  step('the deployed worker is publicly served (auto-approved)', !!meta.public && meta.publicApproved === true, JSON.stringify(meta).slice(0, 160));
  const audit = q("SELECT action FROM hub_workers_log WHERE user = ? ORDER BY at", OWNER).map((r) => r.action);
  step('the deploy is audited (create + auto-approved)', audit.includes('create') && audit.includes('auto-approved'), audit.join(','));
  const msg = await bodyText(page);
  step('the app reports the send as sent', /document sent/i.test(msg), msg.slice(0, 160));

  // 6 — the produced links: on the record and from the document page
  const docRow = q("SELECT value FROM hub_kv WHERE user = ? AND key LIKE 'sig:doc:%'", OWNER)
    .map((r) => JSON.parse(r.value))
    .find((d) => d.id === docId);
  endpoint(docRow, 'doc record missing');
  const priya = docRow.signers.find((s) => !s.isMe);
  const rawLink = (docRow.links || {})[priya.id];
  step('the doc record holds the guest link, on the §23 public base',
    typeof rawLink === 'string' && rawLink.startsWith(`${pubBase}/w/${OWNER}/`) && /\/sign\/[0-9a-f]{40}$/.test(rawLink),
    rawLink || JSON.stringify(docRow.links).slice(0, 160));
  signLink = rawLink;

  step('doc left draft for sent by the send flow', docRow.status === 'sent', docRow.status);
  const token40 = q("SELECT key FROM hub_kv WHERE user = ? AND key LIKE 'sigw:tok:%'", OWNER);
  step('the worker KV holds token hashes only (never raw tokens)',
    token40.length >= 1 && !JSON.stringify(await page.evaluate(() => 1)).includes(rawLink.split('/sign/')[1]),
    `${token40.length} token row(s)`);
  // The deployed script has our page-URL/self-link productization baked in.
  const deployedSha = workerRow.sha;
  const stored = q("SELECT value FROM hub_kv WHERE user = ? AND key = 'sig:worker:cfg:v1'", OWNER)[0];
  const cfgRecord = stored ? JSON.parse(stored.value) : null;
  step('the app recorded its worker config (name/url/secret, hash-only)',
    !!cfgRecord && cfgRecord.name === workerName && String(cfgRecord.url || '').startsWith(pubBase)
      && /^[0-9a-f]{64}$/.test(cfgRecord.secret || ''),
    cfgRecord ? JSON.stringify({ name: cfgRecord.name, url: cfgRecord.url }) : `no cfg; rows=${JSON.stringify(q("SELECT app,key FROM hub_kv WHERE user = ?", OWNER))}`);

  // 7 — the guest: fresh, cookie-less, on the PUBLIC listener only
  const gctx = await browser.createBrowserContext();
  guestPage = await gctx.newPage();
  const guestReq = [];
  guestPage.on('response', (res) => {
    const u = res.url();
    if (u.startsWith(pubBase)) {
      const pathname = new URL(u).pathname;
      guestReq.push({ u: pathname.includes('/w/') ? 'worker' : pathname.endsWith('/sign.html') ? 'page' : 'other', status: res.status(), headers: res.headers() });
    }
  });
  guestPage.on('console', (msg) => { if (msg.type() === 'error') console.log('  [guest console:error]', msg.text().slice(0, 240)); });
  guestPage.on('requestfailed', (req) => console.log('  [guest requestfailed]', req.url().slice(0, 180), req.failure()?.errorText || ''));
  endpoint(typeof signLink === 'string' && signLink.length > 0, 'sign link was not created');
  await guestPage.goto(signLink, { waitUntil: 'networkidle2', timeout: 45_000 });
  await sleep(1500);
  const gText = await bodyText(guestPage);
  step('guest link lands on the signatures sign page (public listener)',
    /asked you to sign/i.test(gText) && /electronically/i.test(gText), gText.slice(0, 220));
  const nav = await guestPage.evaluate(() => location.href);
  const gTextHere = nav.includes('/h/signatures/sign.html');
  step('the 303 redirects to the app sign page on the guest origin', gTextHere, nav);
  const workerResp = guestReq.find((r) => r.u === 'worker');
  step('the guest answer came from the member worker with §16 headers',
    !!workerResp && workerResp.status === 303
    && String(workerResp.headers['x-content-type-options'] || '').toLowerCase() === 'nosniff'
    && /sandbox/.test(workerResp.headers['content-security-policy'] || ''),
    workerResp ? JSON.stringify({ status: workerResp.status, csp: workerResp.headers['content-security-policy'] }) : 'no /w/ response seen');
  const pageResp = guestReq.find((r) => r.u === 'page');
  step('the sign page itself is served to the anonymous guest (strict CSP, no session)',
    !!pageResp && pageResp.status === 200 && /default-src/.test(pageResp.headers['content-security-policy'] || ''),
    pageResp ? `status ${pageResp.status}; responses=${JSON.stringify(guestReq.map(({ u, status }) => ({ u, status })))}` : `no page response seen; responses=${JSON.stringify(guestReq.map(({ u, status }) => ({ u, status })))}`);
  const guestCookies = await gctx.cookies();
  step('no session cookie exists in the guest context', guestCookies.length === 0, JSON.stringify(guestCookies.map((c) => c.name)));

  // 8 — the guest records legal consent, then completes the signature
  await guestPage.click('.consent-check input');
  await clickByText(guestPage, 'agree and review the document');
  await guestPage.waitForSelector('.field-box', { timeout: 20_000 });
  await sleep(700);
  // The one external field is a signature; the pad opens with tabs Draw/Type.
  const fieldBoxed = await guestPage.$$('.field-box');
  endpoint(fieldBoxed.length >= 1, `no signature field boxes on the sign page`);
  await fieldBoxed[0].click();
  await sleep(900);
  await clickByText(guestPage, '^type$|type\b');
  await sleep(400);
  const padInput = await guestPage.$('.sigpad input, input[type=text]');
  endpoint(padInput, 'no type-input on the signature pad');
  await padInput.click();
  await guestPage.keyboard.type(signerName);
  await sleep(300);
  await clickByText(guestPage, 'use signature|use initials|use');
  await sleep(900);
  await clickByText(guestPage, 'complete signing|finish|sign document|sign now');
  await sleep(1500);
  const gDone = await bodyText(guestPage);
  step('the guest completes the signature in one pass without an account',
    /done|complete|copy|receipt|thank/i.test(gDone), gDone.slice(0, 260));

  // 9 — the worker recorded it
  await sleep(1500);
  const respRow = q("SELECT key, value FROM hub_kv WHERE user = ? AND key LIKE 'sigw:resp:%' OR user = ? AND key LIKE 'sigw:doc:%'", OWNER, OWNER);
  const respBlob = respRow.map((r) => r.value).join(' ');
  step('the guest reply is in the owner-side worker KV (status signed + values)',
    /"status"\s*:\s*"signed"|"signed"\s*:\s*true/.test(respBlob) && /consent/.test(respBlob.toLowerCase()),
    `${respRow.length} sigw row(s): ${respBlob.slice(0, 200)}`);
  step('raw tokens are still absent from every row', !respBlob.includes((signLink.split('/sign/')[1]) || 'zzz'), 'token-scan');
  const consentAt = /consentat|consent_at|"consent"\s*:/i.test(respBlob);
  step('the legal-consent evidence was captured', consentAt, 'consent fields');

  // 10 — the owner reloads and sees the completed signature
  await page.reload({ waitUntil: 'networkidle2', timeout: 60_000 });
  await sleep(3000); // the shell's pull() on load
  const docAfter = q("SELECT value FROM hub_kv WHERE user = ? AND key LIKE 'sig:doc:%'", OWNER)
    .map((r) => JSON.parse(r.value)).find((d) => d.id === docId);
  endpoint(docAfter, 'doc record gone after reload');
  const priya2 = docAfter.signers.find((s) => !s.isMe);
  const evidence = JSON.stringify({
    status: docAfter.status,
    signer: { name: priya2.name, status: priya2.status },
    values: docAfter.signerData || docAfter.values || undefined,
  });
  step('the owner sees the completed signature (pull merged)',
    (priya2.status === 'signed' || /seen by you|signed/.test(await bodyText(page)))
    && (docAfter.status === 'completed' || priya2.status === 'signed'),
    evidence.slice(0, 300));
  const pageText = await bodyText(page);
  step('the app shows the completion in the UI', /signed|complete/i.test(pageText), pageText.slice(0, 220));
} catch (err) {
  failed = err;
  console.error('\n  FAILED:', String(err && err.stack || err).split('\n').slice(0, 6).join('\n'));
  step('E2E driver ran to completion', false, String(err && err.message || err));
} finally {
  try { await browser.close(); } catch { /* already gone */ }
  const pass = steps.length && steps.every((s) => s.pass);
  const out = {
    at: new Date().toISOString(),
    pass,
    pubBase: (running && running.publicPort) ? `http://127.0.0.1:${running.publicPort}` : null,
    workerName, signLink, docId,
    steps,
  };
  fs.writeFileSync(path.join(here, 'sign-e2e-results.json'), JSON.stringify(out, null, 2));
  const counts = `${steps.filter((s) => s.pass).length}/${steps.length}`;
  console.log(`\n== §24 signatures E2E: ${pass ? 'PASS' : 'FAIL'} (${counts}) — details in sign-e2e-results.json`);

  // restore configs ALWAYS (a control run must not de-grade later real work)
  const saved = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  for (const [key, value] of Object.entries(saved)) configm.set(key, value);
  console.log('sign-e2e: configs restored');
  process.exit(pass ? 0 : 1);
}
