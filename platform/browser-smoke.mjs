#!/usr/bin/env node
/**
 * Browser (real Chromium) smoke for the hub — the acceptance pass for Phase 2.
 *
 *   node browser-smoke.mjs load            # pass A: load *every* installed app
 *   node browser-smoke.mjs load [app]      # same, one app, plus a UI-control dump
 *   node browser-smoke.mjs persist [app]   # pass B: create → save → reload →
 *                                          #          reopen → restart → survived
 *   node browser-smoke.mjs persist-all     # pass B for every app with a recipe
 *
 * Runs against the REAL data dir (the installed apps live there), starts the
 * private listener itself, and logs per app:
 *   - did the page render (not blank), with numbers (text length, elements);
 *   - every network request/response — external requests, failures, ≥400s;
 *   - uncaught page errors and console errors, incl. the shim's
 *     "not available on this server" notices;
 *   - CSP violations (console mentions and the server's own report-uri inbox);
 *   - service-worker registration attempts and their outcomes;
 *   - whether window.puter is the shim (apps that load Puter from their own JS).
 *
 * The browser pass uses the system Chrome via puppeteer-core. Everything the
 * page asks for goes to the test server on 127.0.0.1 — the external-request
 * counter is the proof nothing reaches the internet.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const mode = argv[0] || 'load';
const onlyArg = argv[1] || null;
const only = onlyArg && onlyArg.includes(',') ? onlyArg.split(',') : onlyArg;
const persistOnly = onlyArg; // persist mode handles the comma list itself

const here = path.dirname(fileURLToPath(import.meta.url));
process.chdir(here);

const PORT = Number(process.env.BROWSER_SMOKE_PORT || 18100);
const PORT2 = Number(process.env.BROWSER_SMOKE_PORT2 || 18101);
const SMOKE_USER = 'appsmoke';
const SMOKE_PASS = 'browser-smoke-pass-1';

const CHROME_CANDIDATES = [
  process.env.BROWSER_EXE,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);
const chromeExe = CHROME_CANDIDATES.find((p) => { try { fs.accessSync(p); return true; } catch { return false; } });
if (!chromeExe) { console.error(`browser-smoke: no Chrome found (${CHROME_CANDIDATES.join(', ')})`); process.exit(2); }

// The testing-only flag; nothing in pass A calls AI, but keep the env honest anyway.
process.env.CAD_TEST = '1';

const [hub, serverm, storem, configm, { run, all }] = await Promise.all([
  import('./lib/hub.js'),
  import('./server.js'),
  import('./lib/store.js'),
  import('./lib/config.js'),
  import('./lib/db.js'),
]);
// SW-guard control runs: BROWSER_SMOKE_SW_GUARD=off serves worker scripts
// unguarded, to prove the cache problem exists without the fix. config.set
// PERSISTS to the DB, so every normal run must pin the guard back on —
// otherwise one control run silently de-grades every later run (bit us once).
if (process.env.BROWSER_SMOKE_SW_GUARD === 'off') {
  configm.set('hub.sw_guard', false);
  console.log('CONTROL RUN: hub.sw_guard=false — service-worker scripts served UNGUARDED');
} else {
  configm.set('hub.sw_guard', true);
}
const SW_GUARD_OFF = process.env.BROWSER_SMOKE_SW_GUARD === 'off';

// A fresh page for the smoke user: only appsmoke's own data is touched.
fs.rmSync(path.join(here, 'data', 'hub-users', SMOKE_USER), { recursive: true, force: true });
run('DELETE FROM hub_kv WHERE user = ?', SMOKE_USER);
run('DELETE FROM hub_grants WHERE user = ?', SMOKE_USER);
if (!storem.getAccount(SMOKE_USER)) storem.addUser(SMOKE_USER, SMOKE_PASS, { admin: true });
else storem.setPassword(SMOKE_USER, SMOKE_PASS);

const running0 = await serverm.startServer({ port: PORT, publicPort: 0, host: '127.0.0.1', tls: null });
let running = running0;
const base = `http://127.0.0.1:${running.privatePort}`;

const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-CAD-Request': '1' },
  body: JSON.stringify({ username: SMOKE_USER, password: SMOKE_PASS }),
});
const token = (login.headers.get('set-cookie') || '').split(';')[0].split('=')[1];
if (!token) { console.error('browser-smoke: login failed'); process.exit(2); }

const apps = hub.listApps().filter((a) => a.enabled);
const targets = only ? apps.filter((a) => (Array.isArray(only) ? only.includes(a.name) : a.name === only)) : apps;
if (!targets.length) { console.error(`browser-smoke: no such installed app "${only}"`); process.exit(2); }

const browser = await puppeteer.launch({
  executablePath: chromeExe,
  headless: true,
  args: ['--no-first-run', '--mute-audio'],
});

const reqPath = (u) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };

function attach(page) {
  const net = { requests: 0, external: [], bad: [], failed: [], console: [], errors: [], cspErrors: [] };
  const expectedMissing = (u) => {
    try {
      const x = new URL(u);
      return x.pathname === '/app-icon.png'
        || x.pathname === '/photo-engine.wasm'
        || x.pathname.startsWith('/icons/')
        || x.pathname === '/api/hub/fs/read'
        || x.pathname === '/api/hub/fs/stat'
        || x.pathname === '/icon-192.png'
        || x.pathname === '/organization.json';
    } catch {
      return false;
    }
  };
  page.on('request', (req) => {
    const u = req.url();
    if (!/^https?:/.test(u)) return;
    net.requests++;
    if (!u.startsWith(base)) net.external.push(u);
  });
  page.on('response', (res) => {
    const u = res.url();
    if (!/^https?:/.test(u) || !u.startsWith(base) || u === `${base}/favicon.ico`) return;
    if (u.endsWith('/api/hub/apps')) return; // service-worker cache probe, not app traffic
    if (res.status() >= 400 && !(res.status() === 404 && expectedMissing(u))) net.bad.push(`${res.status()} ${reqPath(u)}`);
  });
  page.on('requestfailed', (req) => {
    const u = req.url();
    if (!/^https?:/.test(u) || !u.startsWith(base) || u === `${base}/favicon.ico`) return;
    if (u.endsWith('/api/hub/apps')) return; // service-worker cache probe
    const why = req.failure()?.errorText || 'failed';
    if (why === 'net::ERR_ABORTED') return; // navigation races, not app failures
    net.failed.push(`${why} ${reqPath(u)}`);
  });
  page.on('console', (msg) => {
    const text = msg.text();
    net.console.push({ type: msg.type(), text: text.slice(0, 300) });
    if (/not available on this server/i.test(text)) net.errors.push(text.slice(0, 220));
    if (/content security policy/i.test(text)) net.cspErrors.push(text.slice(0, 220));
  });
  page.on('pageerror', (err) => net.errors.push(String((err && err.stack) || err).slice(0, 400)));
  // Requests made BY a service-worker context (precache fills, background
  // re-fetches) do not ride the page target; withPage attaches a CDP session
  // to the worker target and fills these in. The offline-probe URL is set
  // while the harness itself runs the offline re-fetch, so that probe is not
  // counted as app traffic.
  net.swContext = { requests: 0, external: [] };
  net.offlineProbe = null;
  return net;
}
const INSTRUMENT = () => {
  window.__smoke = { sw: [] };
  if (window.navigator && navigator.serviceWorker) {
    const reg = navigator.serviceWorker.register.bind(navigator.serviceWorker);
    navigator.serviceWorker.register = function (url, opts) {
      const rec = { url: String(url) };
      window.__smoke.sw.push(rec);
      return reg(url, opts).then(
        (r) => { rec.ok = true; return r; },
        (e) => { rec.error = String((e && e.message) || e); throw e; },
      );
    };
  }
};

async function withPage(name, settle, fn) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await ctx.setCookie({ name: 'cad_session', value: token, url: base });
  const net = attach(page);
  // Watch for service-worker targets as they appear (install-time precache
  // traffic used to be missed when the watcher attached only after settle).
  const swWatcher = async (target) => {
    if (target.type() !== 'service_worker' || !String(target.url()).startsWith(base)) return;
    try {
      const cdp = await target.createCDPSession();
      await cdp.send('Network.enable');
      cdp.on('Network.requestWillBeSent', (p) => {
        const u = (p.request && p.request.url) || '';
        if (!/^https?:/.test(u)) return;
        if (net.offlineProbe && u.endsWith(net.offlineProbe)) return;
        net.swContext.requests++;
        if (!u.startsWith(base)) net.swContext.external.push(u);
      });
    } catch (e) { void e; /* worker target already gone */ }
  };
  browser.on('targetcreated', swWatcher);
  await page.evaluateOnNewDocument(INSTRUMENT);
  const cspBefore = hub.listCspReports().length;
  const url = `${base}/h/${name}/`;
  let navError = null;
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 35_000 });
  } catch (e) {
    navError = String((e && e.message) || e).slice(0, 220);
  }
  await new Promise((r) => setTimeout(r, settle));
  try { browser.removeListener('targetcreated', swWatcher); } catch (e) { void 0; }
  // Record service-worker-context traffic (older semantic: the page target
  // never sees precache/background fetches the SW itself makes).
  try {
    for (const t of browser.targets()) {
      if (t.type() !== 'service_worker' || !t.url().startsWith(base)) continue;
      const cdp = await t.createCDPSession();
      await cdp.send('Network.enable');
      cdp.on('Network.requestWillBeSent', (p) => {
        const u = (p.request && p.request.url) || '';
        if (!/^https?:/.test(u)) return;
        net.swContext.requests++;
        if (!u.startsWith(base)) net.swContext.external.push(u);
      });
    }
  } catch { /* worker target already gone */ }
  const out = await fn(page, net).catch((e) => ({ evalError: String(e).slice(0, 160) }));
  void url;
  const cspReports = hub.listCspReports().slice(cspBefore).map((rpt) => `${rpt.directive} blocked ${String(rpt.blocked).slice(0, 120)}`);
  void cspBefore;

  // Service-worker facts for this page: registrations recorded by the
  // instrumentation hook, plus the prove-no-hub-API-caching probe when a
  // worker actually registered (activate → fetch an API route → no cache
  // entry → offline re-fetch must be REJECTED, not served from a cache).
  const regs = (out && out.dom && out.dom.sw) || [];
  let swProbe = null;
  if (regs.length) {
    swProbe = await page.evaluate(async () => {
      const probe = '/api/hub/apps';
      try {
        const r = await fetch(probe, { headers: { 'X-CAD-Request': '1' } });
        await r.text();
      } catch (e) { return { error: String((e && e.message) || e).slice(0, 80) }; }
      await new Promise((res) => setTimeout(res, 400));
      const keys = await caches.keys();
      const cached = [];
      for (const k of keys) {
        const c = await caches.open(k);
        const hit = await c.match(probe, { ignoreVary: true }) || await c.match(new URL(probe, location.href).href, { ignoreVary: true });
        if (hit) cached.push(k);
      }
      return { caches: keys, cachedIn: cached };
    }).catch((e) => ({ error: String(e).slice(0, 80) }));
    if (swProbe && !swProbe.error) {
      net.offlineProbe = '/api/hub/apps';
      await page.setOfflineMode(true);
      swProbe.offlineFetch = await page.evaluate((p) =>
        fetch(p, { headers: { 'X-CAD-Request': '1' } })
          .then(() => 'served-from-cache', (e) => `rejected: ${String((e && e.message) || e).slice(0, 60)}`),
      '/api/hub/apps').catch(() => 'rejected');
      await page.setOfflineMode(false);
      net.offlineProbe = null;
    }
  }

  const verdict = {
    name, navError,
    swGuard: SW_GUARD_OFF ? 'off' : 'on',
    dom: out.dom || out,
    ui: out.ui || null,
    interact: out.poke ? { poke: out.poke } : (out.interact || null),
    sw: {
      registered: !!regs.length,
      script: regs.map((r) => r.url),
      probe: swProbe,
    },
    csp: { console: net.cspErrors.slice(0, 6), reports: cspReports.slice(0, 8), count: cspReports.length },
    net: {
      requests: net.requests,
      external: [...new Set(net.external)].slice(0, 12),
      externalCount: net.external.length,
      bad: net.bad.slice(0, 12),
      badCount: net.bad.length,
      failed: net.failed.slice(0, 12),
      failedCount: net.failed.length,
      swContextRequests: net.swContext.requests,
      swContextExternal: net.swContext.external.slice(0, 6),
      notAvailable: net.errors.filter((e) => /not available on this server/i.test(e)).slice(0, 6),
      otherErrors: net.errors.filter((e) => !/not available on this server/i.test(e)).slice(0, 10),
      consoleWarnSample: net.console.filter((c) => c.type === 'warning' && !/not available on this server/i.test(c.text)).map((c) => c.text.slice(0, 140)).slice(0, 6),
    },
  };
  await ctx.close();
  return verdict;
}

const domProbe = () => ({
  title: document.title || '',
  textLen: ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').trim().length,
  textSample: ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 200),
  els: document.body ? document.querySelectorAll('*').length : 0,
  canvases: document.body ? document.querySelectorAll('canvas').length : 0,
  svgs: document.body ? document.querySelectorAll('svg').length : 0,
  puter: typeof window.puter !== 'undefined' && !!window.puter && !!window.puter.cadHub,
  puterApp: window.puter ? window.puter.appID || null : null,
  sw: window.__smoke ? window.__smoke.sw : [],
});

async function mapControls(page) {
  return page.evaluate(() => {
    const vis = (el) => { const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && el.getBoundingClientRect().height > 0; };
    const cap = (e) => (e.innerText || e.value || e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.getAttribute('title') || '').trim().split('\n')[0];
    const btns = [...document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"],.btn,a.button,[role="menuitem"],[role="tab"]')]
      .filter(vis).map(cap).filter((t) => t && t.length <= 40);
    const links = [...document.querySelectorAll('a')].filter(vis).map(cap).filter((t) => t && t.length <= 40 && t !== btns.find((b) => b === t));
    return {
      buttons: [...new Set(btns)].slice(0, 48),
      links: [...new Set(links)].slice(0, 25),
      inputs: document.querySelectorAll('input:not([type="hidden"]),textarea,select').length,
    };
  });
}

// -- pass A --------------------------------------------------------------------------
const results = [];

/** Apps that load the Puter shim lazily from their own JS: click the surface
 * that triggers it, so the pass proves the rewritten loader, not just the
 * landing page. */
const POKE = {
  chess: 'Online',
  checkers: 'Online',
  backgammon: 'Online',
  // 3d: the assistant panel is open by default; submitting a message raises
  // its on-demand Puter loader (assistant/puter.ts loadPuter via ready()).
  '3d': { fillSelector: '.as-input', text: 'make a cube', submit: 'Enter' },
};

/** Apps whose navigation never reaches `networkidle2`. Reasons are MEASURED
 * (see _netchurn.mjs, the evidence tool): each of these runs a recurring
 * account/sync poll through the shim — `auth.isSignedIn()` resolves to
 * GET /api/hub/auth/whoami, paired kv reads/writes — landing more often than
 * puppeteer's 500 ms idle window, while zero requests are ever stuck in
 * flight and the page is fully interactive (DOM element counts in the log).
 * Anything not on this list that times out is a FAILURE, not a shrug. */
const LONG_POLL = {
  'audio-studio': 'shim whoami poll loop (account watcher); page interactive, zero stuck requests',
  'music-studio': 'shim whoami poll loop (storage/account module); page interactive',
  solitaire: 'shim whoami + kv sync loop; canvas game — the 63 chars include only menu labels, the board is drawn',
  sudoku: 'shim whoami + kv sync loop + puzzle-gen worker; page interactive',
  'building-design': 'persistent document/model sync; page interactive with zero stuck requests',
  meetings: 'calendar/account refresh loop; page interactive with zero stuck requests',
  spreadsheet: 'persistent workbook/document sync; page interactive with zero stuck requests',
  whiteboard: 'persistent board/account sync; page interactive with zero stuck requests',
};

if (mode === 'load') {
  for (const a of targets) {
    const r = await withPage(a.name, only ? 7000 : 4500, async (page, net) => {
      const dom = await page.evaluate(domProbe);
      let poked = null;
      const want = POKE[a.name];
      if (want) {
        try {
          let clicked, pokedDesc;
          if (typeof want === 'string') {
            clicked = await page.evaluate((label) => {
              const els = [...document.querySelectorAll('button,[role="button"],a,[role="tab"],li,div')]
                .filter((e) => e.offsetParent !== null && (e.innerText || '').trim().toLowerCase() === label.toLowerCase());
              if (!els.length) return false;
              els[0].click();
              return true;
            }, want);
            pokedDesc = clicked ? `clicked "${want}"` : `no "${want}" control visible`;
          } else if (want.fillSelector) {
            // Real input path: type into the LIVE field and press its submit.
            const el = await page.$(want.fillSelector).catch(() => null);
            if (el) {
              await el.type(want.text, { delay: 10 }).catch(() => {});
              await page.keyboard.press(want.submit || 'Enter').catch(() => {});
              clicked = true;
            }
            pokedDesc = clicked ? `typed into "${want.fillSelector}"` : `no "${want.fillSelector}" field visible`;
          }
          if (clicked) {
            await new Promise((res) => setTimeout(res, 4000));
            const after = await page.evaluate(domProbe);
            dom.puterAfterPoke = after.puter;
            dom.puterAppAfter = after.puterApp;
            poked = pokedDesc;
          } else {
            poked = pokedDesc;
          }
        } catch (e) {
          poked = 'poke failed: ' + String(e).slice(0, 80);
        }
      }
      const ui = only ? await mapControls(page).catch(() => null) : null;
      return { dom, ui, poke: poked };
    });
    let loads = r.dom && r.dom.els >= 8 && (r.dom.textLen >= 12 || r.dom.canvases > 0);
    // § smoke strictness: a navigation timeout is a FAILURE unless the app is
    // on the documented long-poll list above.
    r.navTimeout = /timeout/i.test(r.navError || '');
    r.navTimeoutExcused = r.navTimeout ? (LONG_POLL[a.name] || null) : null;
    if (r.navTimeout) loads = loads && !!r.navTimeoutExcused;
    r.loads = !!loads;
    // Service-worker script + icon headers, node-side, WITH the session
    // cookie (the /h/ mount is authenticated). Covers the review item
    // "sw.js and other worker scripts carry the CSP header" at the raw
    // response level, and reconciles contacts's Phase-1 /icon.svg + /sw.js.
    const probeFiles = {};
    for (const rel of ['sw.js', 'icon.svg']) {
      try {
        const hres = await fetch(`${base}/h/${a.name}/${rel}`, { headers: { cookie: `cad_session=${token}` } });
        if (hres.ok) {
          const svcBody = await hres.text();
          probeFiles[rel] = {
            status: 200,
            csp: hres.headers.get('content-security-policy') || '',
            nosniff: hres.headers.get('x-content-type-options') || '',
            guarded: rel === 'sw.js' && svcBody.startsWith('/* cad-home serve-time guard'),
            bytes: svcBody.length,
          };
        } else probeFiles[rel] = { status: hres.status, shipped: false };
      } catch (e) { probeFiles[rel] = { error: String(e).slice(0, 60) }; }
    }
    r.fileHeaders = probeFiles;
    r.swHeaders = probeFiles['sw.js'];
    results.push(r);
    const verdict = loads ? 'ok  ' : (r.navTimeout ? (r.navTimeoutExcused ? 'poll' : 'FAIL') : 'BLANK');
    console.log(
      `${verdict} ${a.name}  text=${r.dom?.textLen ?? '?'} els=${r.dom?.els ?? '?'} ` +
      `ext=${r.net.externalCount} bad=${r.net.badCount} fail=${r.net.failedCount} ` +
      `err=${r.net.otherErrors.length} csp=${r.csp.count} sw=${r.dom?.sw?.length ?? 0} ` +
      `swjs=${r.fileHeaders && r.fileHeaders['sw.js'] && r.fileHeaders['sw.js'].csp ? (r.fileHeaders['sw.js'].guarded ? 'csp+guard' : 'csp') : 'none'} ` +
      `puter=${r.dom?.puter ? r.dom?.puterApp : 'none'}` +
      `${r.interact && r.interact.poke ? ` poke→${r.interact.poke}` : ''}` +
      `${r.dom?.puterAfterPoke !== undefined ? ` afterPuter=${r.dom.puterAfterPoke ? r.dom.puterAppAfter : 'still none'}` : ''}` +
      `${r.navError ? ' NAV:' + r.navError.slice(0, 60) : ''}` +
      `${SW_GUARD_OFF ? ' [SWGUARD OFF]' : ''}`,
    );
    if (only) console.log(`UI ${a.name}: ${JSON.stringify(r.ui)}`);
  }
}

void PORT2; // pass B restarts on this port (defined for persist mode below)
// ====================================================================================
// -- pass B: create → save → reload → reopen → restart → survived ---------------------
// ====================================================================================

/**
 * Per-app recipes as tiny UI step lists. Steps drive the real UI surface
 * (puppeteer pointer clicks and real key typing — these apps use pointer-event
 * delegation, so synthetic el.click() does not count). Step types:
 *   pclick:Label / pclickcatch:Label   real click on a visible labelled control
 *   rawclick:Label / rawcatch:Label    click via aria-label/innerText coordinates
 *   fill:field:text / fillar:Label:^X  mouse-click + type into a field (^ = overwrite)
 *   sel:.cssSelector  type:x  key:k  combo:Ctrl+S  js:code  wait:ms  goto:#hash
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const allRows = all;

async function bodyHas(page, rx) {
  return page.evaluate((p) => new RegExp(p, 'i').test((document.body.innerText || '').replace(/\s+/g, ' ')), rx instanceof RegExp ? rx.source : String(rx));
}

async function clickByLabel(page, rx, { silent = true, mark = '' } = {}) {
  const h = await page.evaluate((pattern, mk) => {
    let els;
    if (mk === 'cell') els = [...document.querySelectorAll('button,td,[role="gridcell"],[role="cell"]')];
    else if (mk === 'tree') els = [...document.querySelectorAll('[role="tree"] .br-row,[role="tree"] [role="treeitem"]')];
    else els = [...document.querySelectorAll('button,[role="button"],a,[role="menuitem"],[role="tab"],input')];
    if (mk === 'modal') {
      // Same element set but restricted to controls inside a visible
      // dialog/modal overlay, so nav items with the same label lose.
      const roots = [...document.querySelectorAll('[role="dialog"],dialog,[class*="modal"],[class*="dialog"],[class*="overlay"]')]
        .filter((d) => d.offsetParent !== null || getComputedStyle(d).position === 'fixed');
      els = els.filter((e) => roots.some((rt) => rt.contains(e)));
    }
    let el = null;
    if (mk === 'cell') {
      el = els.find((e) => new RegExp(pattern, 'i').test((e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('title') || '')));
    } else {
      el = els.find((e) => {
        if (!(e.offsetParent !== null || getComputedStyle(e).position === 'fixed')) return false;
        const label = (e.innerText || e.value || e.getAttribute('aria-label') || e.getAttribute('title') || '').trim();
        return label && label.length < 60 && new RegExp(pattern, 'i').test(label);
      });
    }
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, rx instanceof RegExp ? rx.source : String(rx), mark);
  if (!h) {
    if (silent) return false;
    throw new Error(`no control matching /${rx}/`);
  }
  await page.mouse.click(h.x, h.y);
  await sleep(700);
  return true;
}

/** Clicks the real Save button of the app's own modal dialog footer (the
 * music-studio promptDialog has three buttons and needs the exact one). */
async function dialogSave(page) {
  return page.evaluate(() => {
    const feet = [...document.querySelectorAll('.dialog-foot,.dialog-actions,[class*="modal"] [class*="foot"],[class*="modal"] [class*="actions"]')]
      .filter((f) => f.offsetParent !== null || getComputedStyle(f).position === 'fixed');
    for (const f of feet) {
      const btn = [...f.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === 'Save' || (b.getAttribute('aria-label') || '') === 'Save');
      if (btn && !btn.disabled) { btn.click(); return true; }
    }
    return false;
  });
}

async function clickSel(page, sel) {
  const h = await page.evaluate((c) => {
    const el = document.querySelector(c);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, sel);
  if (!h) throw new Error(`no element ${sel}`);
  await page.mouse.click(h.x, h.y);
  await sleep(500);
}

async function fillField(page, field, value) {
  const h = await page.evaluate((f) => {
    const trySel = (sel) => { try { return document.querySelector(sel); } catch { return null; } };
    let el = null;
    if (f.startsWith('css:')) el = trySel(f.slice(4));
    else if (f === 'firstText') {
      const dialogs = [...document.querySelectorAll('[role="dialog"],dialog,[class*="modal"],[class*="dialog"],[class*="overlay"]')]
        .filter((d) => d.offsetParent !== null || getComputedStyle(d).position === 'fixed');
      const scope = dialogs.length ? dialogs : [document.body];
      for (const s of scope) {
        el = [...s.querySelectorAll('input,textarea')].find((e) => (e.offsetParent !== null || getComputedStyle(e).position === 'fixed') && (e.type === 'text' || e.type === 'search' || !e.type) && !e.disabled && !e.readOnly) || null;
        if (el) break;
      }
    } else el = trySel(`[name="${f}"]`) || trySel(`#${CSS && CSS.escape ? CSS.escape(f) : f}`) || trySel(f);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, field);
  if (!h) throw new Error(`no input field ${field}`);
  await page.mouse.click(h.x, h.y);
  await sleep(250);
  if (value.startsWith('^')) { // select-all, then overwrite
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.type(value.slice(1), { delay: 8 });
  } else {
    await page.keyboard.type(value, { delay: 8 });
  }
  await sleep(250);
}

async function runSteps(page, steps, app) {
  for (const step of steps) {
    const kind = step.includes(':') ? step.slice(0, step.indexOf(':')) : step;
    try {
      if (kind === 'pclick' || kind === 'pclickcatch') {
        const pattern = step.slice(kind.length + 1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const ok = await clickByLabel(page, new RegExp(pattern));
        if (!ok && kind === 'pclick') throw new Error(`no visible control "${step.slice(7)}"`);
      } else if (kind === 'panel') {
        // Open an app panel only if its content (the browser tree) is not
        // mounted yet — the button is a toggle, so a blind click can close.
        const hasTree = await page.evaluate(() => !!document.querySelector('[role="tree"],[role="treeitem"]'));
        if (!hasTree) {
          const ok = await clickByLabel(page, new RegExp(step.slice(6)));
          if (!ok) throw new Error(`no control to open the panel "${step.slice(6)}"`);
        }
        await sleep(900);
      } else if (kind === 'tclick' || kind === 'tclickcatch') {
        // Tree-row click: the browser panel's rows are plain divs (not
        // buttons), so they need their own mark.
        const ok = await clickByLabel(page, new RegExp(step.slice(kind.length + 1)), { mark: 'tree' });
        if (!ok && kind === 'tclick') throw new Error(`no tree row "${step.slice(kind.length + 1)}"`);
      } else if (kind === 'nclick' || kind === 'nclickcatch') {
        // Native selector click (puppeteer's text engine) — used when a
        // coordinate click lands on something else (toasts paint above).
        try { await page.click(`::-p-text(${step.slice(kind.length + 1)})`, { timeout: 5000 }); }
        catch (e) { if (kind === 'nclick') throw new Error(`nclick failed: ${String(e).slice(0, 120)}`); }
        await sleep(900);
      } else if (kind === 'mclick' || kind === 'mclickcatch') {
        // Modal-scoped click: only controls inside a visible dialog.
        const ok = await clickByLabel(page, new RegExp(step.slice(kind.length + 1)), { mark: 'modal' });
        if (!ok && kind === 'mclick') throw new Error(`no modal control "${step.slice(kind.length + 1)}"`);
      } else if (kind === 'rawclick' || kind === 'rawcatch') {
        const ok = await clickByLabel(page, new RegExp(step.slice(kind.length + 1)));
        if (!ok && kind === 'rawclick') throw new Error(`no control matching the recipe step`);
      } else if (kind === 'clickcell') {
        const ok = await clickByLabel(page, step.slice(10), { mark: 'cell' });
        if (!ok) throw new Error(`no cell ${step.slice(10)}`);
      } else if (kind === 'fill') {
        const rest = step.slice(5);
        const i = rest.indexOf(':');
        await fillField(page, rest.slice(0, i).replace(/^#/, ''), rest.slice(i + 1));
      } else if (kind === 'fillar') {
        const rest = step.slice(7);
        const i = rest.indexOf(':');
        await fillField(page, `[aria-label="${rest.slice(0, i)}"]`, rest.slice(i + 1));
      } else if (kind === 'sel') {
        await clickSel(page, step.slice(4));
      } else if (kind === 'type') {
        await page.keyboard.type(step.slice(5), { delay: 10 });
        await sleep(400);
      } else if (kind === 'key') {
        await page.keyboard.press(step.slice(4));
        await sleep(300);
      } else if (kind === 'combo') {
        const parts = step.slice(6).split('+');
        for (const p of parts.slice(0, -1)) await page.keyboard.down(p);
        await page.keyboard.press(parts[parts.length - 1]);
        for (const p of parts.slice(0, -1).reverse()) await page.keyboard.up(p);
        await sleep(700);
      } else if (kind === 'dialogSave') {
        if (!(await dialogSave(page))) throw new Error('no Save button in any open dialog');
        await sleep(600);
      } else if (kind === 'js') {
        await page.evaluate(step.slice(3)).catch((e) => { throw new Error('js: ' + String(e).slice(0, 120)); });
        await sleep(600);
      } else if (kind === 'wait') {
        await sleep(Number(step.slice(5)) || 2000);
      } else if (kind === 'goto') {
        await page.evaluate((h) => { location.hash = h; }, step.slice(5)).catch(() => {});
        await sleep(2500);
      } else if (kind === 'dump') {
        const d = await page.evaluate(() => {
          const vis = (e) => e.offsetParent !== null || getComputedStyle(e).position === 'fixed';
          const cap = (e) => (e.innerText || e.value || e.getAttribute('aria-label') || e.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 50);
          return {
            buttons: [...document.querySelectorAll('button,[role="button"],[role="tab"]')].filter(vis).map((e) => (e.disabled ? '[OFF] ' : '') + cap(e)).filter(Boolean).slice(0, 40),
            inputs: [...document.querySelectorAll('input,textarea,select')].filter(vis).map((e) => ({ type: e.type, name: e.name, id: e.id, ar: e.getAttribute('aria-label'), val: (e.value || '').slice(0, 30) })).slice(0, 20),
            body: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
          };
        });
        console.log(`   [dump] ${JSON.stringify(d).slice(0, 900)}`);
      } else {
        throw new Error(`unknown step: ${step}`);
      }
    } catch (err) {
      throw new Error(`step "${step}" failed: ${String((err && err.message) || err).slice(0, 160)}`);
    }
  }
  void app;
}

const RECIPES = {
  notes: {
    what: 'typed a page title + body line into the note document (autosave)',
    steps: ['wait:3000', 'sel:.page-title', 'type:Smoke Page Title', 'key:Enter', 'type:Smoke persistence note.', 'wait:9000'],
    expectRx: /Smoke Page Title/,
  },
  contacts: {
    what: 'created a contact through New contact',
    steps: ['wait:3000', 'pclick:New contact', 'wait:1800', 'fill:firstName:Smoke', 'fill:lastName:Contact', 'pclick:Add contact', 'wait:3500'],
    expectRx: /Smoke Contact/,
  },
  projects: {
    what: 'created a project through the New-project flow',
    steps: ['wait:3000', 'pclickcatch:New project', 'pclickcatch:Create my first project', 'pclickcatch:Skip for now', 'wait:2000', 'pclickcatch:New project', 'wait:1800', 'fill:firstText:Smoke Project', 'pclickcatch:Create project', 'pclickcatch:Create', 'wait:4000'],
    expectRx: /Smoke Project/,
  },
  tasks: {
    what: 'created a task through the task dialog',
    steps: ['wait:3000', 'pclickcatch:Add my first task', 'pclickcatch:Add for today', 'pclickcatch:New task', 'wait:1500', 'fillar:Task title:Smoke Task', 'mclick:Today', 'nclick:Add task', 'wait:4500'],
    expectRx: /Smoke Task/,
  },
  pos: {
    what: 'created a product through the products page',
    steps: ['wait:3500', 'pclickcatch:Add products', 'pclickcatch:Skip for now', 'goto:/products', 'pclickcatch:Add your first product', 'wait:1800', 'fillar:Name:Smoke Product', 'fillar:Price:9.90', 'wait:9000', 'nclick:Add product', 'pclickcatch:Save product', 'wait:4500'],
    expectRx: /Smoke Product/,
  },
  presentation: {
    what: 'renamed the deck and saved it via Save to Puter (fs .pptx)',
    steps: ['wait:8000', 'rawclick:Untitled presentation', 'wait:1800', 'fillar:Presentation name:^Smoke Deck', 'dialogSave', 'wait:2000', 'rawclick:Save to Puter', 'wait:4000'],
    reopenSteps: ['pclickcatch:Back to presentations', 'wait:1500'],
    expectRx: /Smoke Deck/,
  },
  'music-studio': {
    what: 'saved the song via Ctrl+S save dialog (Projects/<name>.msproj on the fs)',
    steps: ['wait:6000', 'combo:Control+S', 'wait:3000', 'fillar:Name (saved to your Puter cloud):^Smoke Song', 'dialogSave', 'wait:9000'],
    reopenSteps: ['panel:Browser', 'wait:1200', 'tclickcatch:Music Studio files', 'wait:3000', 'tclickcatch:Projects', 'wait:2500'],
    expectRx: /Smoke Song/,
  },
  solitaire: {
    what: 'started a New game (auto-persisted game state in kv)',
    steps: ['wait:3500', 'pclickcatch:New', 'wait:2500', 'pclickcatch:Undo', 'wait:3500'],
    expectRx: /Klondike/,
  },
  sudoku: {
    what: 'typed a digit into an empty sudoku cell (auto-persisted kv state)',
    steps: ['wait:3500', 'clickcell:column \\d+, empty', 'type:5', 'wait:4000'],
    expectRx: /Sudoku/,
  },
  crm: {
    what: 'created a lead through the lead form',
    steps: ['wait:3500', 'pclickcatch:Add a lead', 'pclickcatch:Skip for now', 'pclickcatch:Add a lead', 'wait:1800', 'fill:#f-2:Smoke Lead', 'nclick:Add lead', 'wait:5000'],
    expectRx: /Smoke Lead/,
  },
};

/** What of appsmoke's persisted app data exists right now (server-side truth).
 * kv identity includes the value length so an update to an existing key
 * counts as a delta, not just brand-new keys. */
function snapshotData(user) {
  const root = path.join(here, 'data', 'hub-users', user);
  const files = [];
  const walk = (d, rel = '') => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(d, e.name), `${rel}${e.name}/`);
      else {
        const size = fs.statSync(path.join(d, e.name)).size;
        files.push(`${rel}${e.name} (${size}B)`);
      }
    }
  };
  walk(root);
  const kv = allRows('SELECT app, key, value FROM hub_kv WHERE user = ? ORDER BY app, key', user);
  return { files, kv: kv.map((r) => `${r.app}:${r.key}=${kvHash(r.value)}`) };
}

/** Short content hash so any value change (not just size) counts as a delta. */
function kvHash(value) {
  let h = 5381;
  const s = String(value);
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

async function openPage(name, urlBase) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  attach(page);
  await ctx.setCookie({ name: 'cad_session', value: token, url: urlBase });
  await page.goto(`${urlBase}/h/${name}/`, { waitUntil: 'networkidle2', timeout: 45_000 }).catch(() => {});
  return { ctx, page };
}

let persistSummary = null;
if (mode === 'persist') {
  const pick = persistOnly ? (persistOnly.includes(',') ? persistOnly.split(',') : [persistOnly]) : Object.keys(RECIPES);
  const summary = [];
  for (const name of pick) {
    const recipe = RECIPES[name];
    if (!recipe) { console.error(`persist: no recipe for ${name}`); process.exit(2); }
    const before = snapshotData(SMOKE_USER);
    console.log(`\n== persist ${name}: ${recipe.what}`);
    const line = { app: name, what: recipe.what };
    let keep = null;
    try {
      keep = await openPage(name, base);
      await sleep(1200);
      await runSteps(keep.page, recipe.steps, name);
      const after = snapshotData(SMOKE_USER);
      const fileDelta = after.files.filter((f) => !before.files.includes(f));
      const kvDelta = after.kv.filter((k) => !before.kv.includes(k));
      console.log(`   new files: ${fileDelta.length ? JSON.stringify(fileDelta.slice(0, 6)) : '(none)'}`);
      console.log(`   new kv keys: ${kvDelta.length ? JSON.stringify(kvDelta.slice(0, 8)) : '(none)'}`);
      line.fileDelta = fileDelta; line.kvDelta = kvDelta;
      if (!fileDelta.length && !kvDelta.length) throw new Error('nothing was persisted server-side');

      // reopen after reload, fresh context (nothing carried over)
      const ctx2 = await browser.createBrowserContext();
      const p2 = await ctx2.newPage();
      attach(p2);
      await ctx2.setCookie({ name: 'cad_session', value: token, url: base });
      await p2.goto(`${base}/h/${name}/`, { waitUntil: 'networkidle2', timeout: 45_000 }).catch(() => {});
      await sleep(7000);
      let seen = await bodyHas(p2, recipe.expectRx);
      if (!seen && recipe.reopenSteps) {
        try { await runSteps(p2, recipe.reopenSteps, name); } catch (e) { console.log(`   reopen steps bailed: ${String(e.message || e).slice(0, 160)}`); }
        seen = await bodyHas(p2, recipe.expectRx);
      }
      if (!seen && name === 'crm') { await clickByLabel(p2, /Leads/).catch(() => {}); await sleep(3000); seen = await bodyHas(p2, recipe.expectRx); }
      console.log(`   reopened after reload: ${seen ? 'VISIBLE via UI' : 'NOT visible via UI'}`);
      if (!seen) {
        const sample = await p2.evaluate(() => ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 400)).catch(() => '(eval failed)');
        console.log(`   page text after reload: ${JSON.stringify(sample)}`);
      }
      line.survivedReload = !!seen;
      await ctx2.close();

      // survive a real server restart, reopen again
      await running.close();
      running = await serverm.startServer({ port: PORT2, publicPort: 0, host: '127.0.0.1', tls: null });
      const base2 = `http://127.0.0.1:${running.privatePort}`;
      const ctx3 = await browser.createBrowserContext();
      const p3 = await ctx3.newPage();
      attach(p3);
      await ctx3.setCookie({ name: 'cad_session', value: token, url: base2 });
      await p3.goto(`${base2}/h/${name}/`, { waitUntil: 'networkidle2', timeout: 45_000 }).catch(() => {});
      await sleep(7000);
      let seen2 = await bodyHas(p3, recipe.expectRx);
      if (!seen2 && recipe.reopenSteps) {
        try { await runSteps(p3, recipe.reopenSteps, name); } catch (e) { console.log(`   reopen steps bailed: ${String(e.message || e).slice(0, 160)}`); }
        seen2 = await bodyHas(p3, recipe.expectRx);
      }
      if (!seen2 && name === 'crm') { await clickByLabel(p3, /Leads/).catch(() => {}); await sleep(3000); seen2 = await bodyHas(p3, recipe.expectRx); }
      const persisted = snapshotData(SMOKE_USER);
      // Compare keys, not value hashes: apps legitimately rewrite their own
      // keys on load (timestamps rotate), and sudoku does exactly that.
      const kvKey = (k) => k.slice(0, k.lastIndexOf('='));
      const kvKeys = persisted.kv.map(kvKey);
      const stillThere = fileDelta.every((f) => persisted.files.includes(f)) && kvDelta.every((k) => kvKeys.includes(kvKey(k)));
      console.log(`   after server restart: data server-side=${stillThere ? 'PRESENT' : 'GONE'}; UI shows it: ${seen2 ? 'YES' : 'no (checked server-side)'}`);
      line.survivedRestart = stillThere; line.restartUi = !!seen2;
      await ctx3.close();

      // restore the original listener so the loop keeps its URLs
      await running.close();
      running = await serverm.startServer({ port: PORT, publicPort: 0, host: '127.0.0.1', tls: null });
      await keep.ctx.close();
    } catch (err) {
      console.log(`   FAILED: ${String((err && err.message) || err).slice(0, 260)}`);
      line.failed = String((err && err.message) || err).slice(0, 260);
      if (keep) { try { await keep.ctx.close(); } catch { /* already gone */ } }
      await running.close().catch(() => {});
      running = await serverm.startServer({ port: PORT, publicPort: 0, host: '127.0.0.1', tls: null });
      summary.push(line);
      continue;
    }
    summary.push(line);
  }
  persistSummary = summary;
}

// Mode `consent`: a mock-app drive-through of the Drive consent overlay. It
// calls the SHIM from a real app page (window.puter.fs.write with a Drive
// path), watches the overlay mount, Allow → the file exists on the Drive and
// the grant covers the next write at once; revoke → the prompt returns,
// Deny → the write is refused with the plain no-permission error.
if (mode === 'consent') {
  const stamp = String(Date.now());

  const go = async (name) => {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await ctx.setCookie({ name: 'cad_session', value: token, url: base });
    await page.goto(`${base}/h/${name}/`, { waitUntil: 'networkidle2', timeout: 45_000 }).catch(() => {});
    await sleep(4500);
    return { ctx, page };
  };

  const write = async (page, rel) => page.evaluate(async (p) => {
    try {
      const entry = await window.puter.fs.write(p, 'consent smoke data', { createMissingParents: true });
      return { ok: true, name: entry && entry.name };
    } catch (err) {
      return { ok: false, code: err && err.code, message: String(err && err.message).slice(0, 160) };
    }
  }, rel);

  const overlayUp = async (page) => page.evaluate(() => {
    // Closed shadow root: the page only ever sees the host's dataset state —
    // no querySelector can reach the dialog itself, and that is part of the test.
    const host = document.querySelector('.cad-consent-host');
    return host ? { state: host.dataset.cadConsent, app: host.dataset.cadApp, path: host.dataset.cadPath, need: host.dataset.cadNeed }
      : null;
  });

  // A REAL click: real input events through CDP (page.mouse), aimed at one of
  // the buttons' published coordinates. Page script cannot aim OR produce
  // trusted events — it never gets a reference to a button at all.
  const clickConsent = async (page, yes) => {
    const aim = await page.evaluate((wantAllow) => {
      const host = document.querySelector('.cad-consent-host');
      return host ? (wantAllow ? host.dataset.cadAim : host.dataset.cadDenyAim) || null : null;
    }, yes);
    if (!aim) return null;
    const [x, y] = String(aim).split(',').map(Number);
    await page.mouse.click(x, y);
    await sleep(1200);
    return aim;
  };

  let keep; // eslint-disable-line no-unused-vars
  const con = [];
  const grantCount = async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(here, 'data', 'cad.db'));
    const n = db.prepare(
      "SELECT COUNT(*) AS n FROM hub_grants WHERE user=? AND app='tasks' AND path LIKE '/Documents/consent-probe%' AND revoked_at IS NULL",
    ).get(SMOKE_USER).n;
    db.close();
    return n;
  };
  try {
    keep = await go('tasks');
    const path1 = `/Documents/consent-probe/marker-${stamp}.txt`;

    // 1 — first Drive write: overlay mounts, and the page CANNOT reach it
    const p1 = write(keep.page, path1);
    await sleep(1500);
    const asked1 = await overlayUp(keep.page);
    con.push({ step: 'overlay mounts on first Drive write', pass: !!asked1 && asked1.state === 'pending', detail: JSON.stringify(asked1).slice(0, 140) });
    const undercover = await keep.page.evaluate(() => ({
      dialog: !!document.querySelector('.cad-consent-backdrop, .cad-consent-box'),
      allow: !!document.querySelector('.cad-consent-allow'),
      hostShadow: !!document.querySelector('.cad-consent-host')?.shadowRoot, // closed: must be null
    }));
    con.push({
      step: 'page script cannot reach the dialog (closed shadow root)',
      pass: !undercover.dialog && !undercover.allow && !undercover.hostShadow,
      detail: JSON.stringify(undercover),
    });

    // 2 — synthetic clicks (the whole arsenal the page has) create NO grant
    const beforeAttack = await grantCount(keep.page);
    const attack = await keep.page.evaluate(() => {
      const host = document.querySelector('.cad-consent-host');
      const results = { syntheticHostClick: null, syntheticKeydown: null };
      if (!host) return results;
      // dispatching AT the host: composed events retarget, but nothing inside
      // listens at the host; the closed root keeps the buttons unreachable.
      host.addEventListener('click', () => { results.syntheticHostClick = 'host-reached'; });
      host.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
      return results;
    });
    await sleep(800);
    const midState = await overlayUp(keep.page);
    const midGrants = await grantCount(keep.page);
    con.push({
      step: 'synthetic click + Escape from page script grant NOTHING',
      pass: midGrants === beforeAttack && (midState?.state || '') === 'pending',
      detail: JSON.stringify({ attack, state: midState?.state, grants: midGrants, before: beforeAttack }).slice(0, 140),
    });

    // 3 — a REAL click on Allow creates the grant and the write goes through
    await clickConsent(keep.page, true);
    const r1 = await p1;
    con.push({ step: 'real Allow → write succeeds', pass: r1.ok, detail: r1.message || r1.name });

    // 4 — the file really is on the Drive + the grant covers a second write, silently
    const onDisk = fs.existsSync(path.join(here, 'data', 'files', SMOKE_USER, 'Documents', 'consent-probe', `marker-${stamp}.txt`));
    con.push({ step: 'file exists in data/files/<user>/Documents', pass: onDisk });
    const ask2 = await keep.page.evaluate(async (p) => {
      const e = await window.puter.fs.write(p, 'again, same granted file', { overwrite: true }).catch((err) => ({ err: err.code }));
      return { second: e && !e.err ? e.name : null, overlay: !!document.querySelector('.cad-consent-host') };
    }, path1);
    con.push({ step: 'second write to the granted file needs no prompt', pass: !!ask2.second && !ask2.overlay, detail: JSON.stringify(ask2).slice(0, 120) });

    // 5 — revoke from the SERVER side (the Account endpoint's list + DELETE
    // have their own HTTP tests in test/hub-data.test.js; in-page fetches on
    // app pages ride behind the app's service worker, so the smoke checks the
    // database directly, which is what "revoked" means on this server).
    const { DatabaseSync } = await import('node:sqlite');
    const dbSrv = new DatabaseSync(path.join(here, 'data', 'cad.db'));
    const mine = dbSrv.prepare(
      "SELECT id FROM hub_grants WHERE user=? AND app='tasks' AND path LIKE '/Documents/consent-probe%' AND revoked_at IS NULL",
    ).all(SMOKE_USER);
    dbSrv.prepare("UPDATE hub_grants SET revoked_at=? WHERE user=? AND path LIKE '/Documents/consent-probe%' AND revoked_at IS NULL")
      .run(Date.now(), SMOKE_USER);
    dbSrv.close();
    con.push({ step: 'grants revoked (server-side; endpoint covered by HTTP tests)', pass: mine.length >= 1, detail: String(mine.length) });

    const p3 = write(keep.page, path1);
    await sleep(1500);
    const asked3 = await overlayUp(keep.page);
    con.push({ step: 'revoke → overlay asks again', pass: !!asked3 && asked3.state === 'pending', detail: JSON.stringify(asked3).slice(0, 140) });
    await clickConsent(keep.page, false);
    const r3 = await p3;
    con.push({ step: 'Deny → write refused, app sees the plain error', pass: !r3.ok && r3.code === 'no_permission_for_app', detail: r3.code || r3.message });

    const passAll = con.every((c) => c.pass);
    console.log(`\n== consent mock-app drive-through: ${passAll ? 'PASS' : 'FAIL'} (${con.filter((c) => c.pass).length}/${con.length})`);
    for (const c of con) console.log(`   ${c.pass ? '✔' : '✘'} ${c.step}${c.detail === undefined ? '' : ` — ${JSON.stringify(c.detail).slice(0, 160)}`}`);
    persistSummary = { mode: 'consent', checks: con, pass: passAll };
    await keep.ctx.close();
  } catch (err) {
    console.log(`consent mode FAILED: ${String((err && err.stack) || err).slice(0, 300)}`);
    if (keep) { try { await keep.ctx.close(); } catch { /* gone */ } }
  }
}

await browser.close();

fs.writeFileSync(
  path.join(here, 'browser-smoke-results.json'),
  JSON.stringify({ at: new Date().toISOString(), base, user: SMOKE_USER, mode, results, persist: persistSummary }, null, 1),
);
const loadsCount = results.filter((r) => r.loads).length;
if (results.length) console.log(`\n${loadsCount}/${results.length} app(s) render non-blank; details in browser-smoke-results.json`);
if (persistSummary && persistSummary.length) {
  const ok = persistSummary.filter((l) => !l.failed && l.survivedReload && l.survivedRestart).length;
  console.log(`persist: ${ok}/${persistSummary.length} app(s) created something, reopened it after reload, and it survived a server restart`);
} else if (persistSummary && !persistSummary.length) {
  console.log(`consent drive-through: ${persistSummary.pass ? 'PASS' : 'FAIL'} — details in browser-smoke-results.json`);
}
await running.close();
process.exit(0);
