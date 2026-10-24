/**
 * Serve-time rewriting for hub apps. Apps stay untouched in the upstream
 * clone; every change happens here, on the bytes this server sends:
 *
 *   - the js.puter.com script tag (any spelling) points at our shim instead;
 *   - external <script src> and <link href> tags are stripped (analytics,
 *     CDN libraries) and recorded;
 *   - inline scripts are listed by hash so a strict CSP can allow exactly them;
 *   - JS bundles get the same js.puter.com → shim rewrite (chess, checkers,
 *     backgammon and 3d load Puter from their own code);
 *   - a scanner lists every remaining external URL in the built app, so the
 *     admin can see what a build would try to reach.
 *
 * Rewriting is pure: no source file is modified, no clone is touched.
 */
import crypto from 'node:crypto';
import path from 'node:path';

/** Any absolute http(s) URL, terminated by quotes, spaces or angle brackets. */
const URL_RE = /https?:\/\/[^\s"'()`<>{}\\]+/g;

const PUTER_TEMPLATE = /^https?:\/\/js\.puter\.com\//;
/** js.puter.com URLs inside HTML attr values or JS strings. */
const PUTER_BODY_RE = /https?:\/\/js\.puter\.com\/[^\s"'`()<>{}\\]*/g;

const escapeAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Replace a URL with a local path, keeping at least the shim's path. */
function shimPath(appName) {
  return '/hub/puter.js';
}

/** sha256-… hashes inline scripts use in a CSP. The HTML input preprocessor
 * turns CRLF (and lone CR) into LF before the browser parses, so the browser
 * hashes the LF version — match it exactly. */
function inlineHashes(body) {
  if (!body.trim()) return [];
  const h = crypto.createHash('sha256').update(body.replace(/\r\n?/g, '\n'), 'utf8').digest('base64');
  return [`sha256-${h}`];
}

/**
 * Rewrite one HTML document.
 * root-absolute href/src references (href="/favicon.svg", /manifest.webmanifest
 * …) mean the app's own root — under /h/<name>/ they get the app prefix, the
 * same rule vite --base applies elsewhere. Our own /hub/* paths stay untouched.
 * Returns { html, hashes, stripped } — hashes feed the CSP header, stripped is
 * the list of external URLs removed from the page.
 */
export function rewriteHtml(html, { name } = {}) {
  const stripped = [];
  const hashes = [];
  let out = html;

  if (name) {
    const prefix = `/h/${name}/`;
    out = out.replace(/\b(href|src|poster|data)\s*=\s*"(\/[^"]*?)"/gi, (m, attr, url) => {
      if (/^\/+(hub|api|h)(\/|$)/.test(url) || url.startsWith('//')) return m;
      return `${attr}="${prefix}${url.slice(1)}"`;
    });
  }

  // Puter loader tags → our shim, whichever pattern the app used. The app's
  // name rides along as a data attribute on the shim tag itself — no new
  // inline script, so the strict CSP and its hashes stay exactly as before.
  out = out.replace(/<script\b([^>]*?)\bsrc=["'](?:https?:)?\/\/js\.puter\.com\/[^"']*["']([^>]*)>\s*<\/script>/gi, () => {
    const appAttr = name ? ` data-cad-app="${escapeAttr(name)}"` : '';
    return `<script src="${shimPath()}"${appAttr}></script>`;
  });

  // Other external scripts (analytics, CDN bundles) go away and are recorded.
  out = out.replace(/<script\b[^>]*\bsrc=["']((?:https?:)?\/\/[^"']+)["'][^>]*>\s*<\/script>/gi, (tag, src) => {
    if (PUTER_TEMPLATE.test(src)) return tag; // different puter shape; leave for the next pass to catch
    stripped.push(src);
    return `<!-- cad-hub: external script removed at serve time (${src}) -->`;
  });

  // External stylesheets and generic external <link>s: strip and record.
  out = out.replace(/<link\b([^>]*?)\bhref=["']((?:https?:)?\/\/[^"']+)["']([^>]*)>/gi, (tag, before, href, after) => {
    stripped.push(href);
    return `<!-- cad-hub: external resource removed at serve time (${href}) -->`;
  });

  // Hash every inline script so script-src 'self' can allow exactly these.
  // Lazy [\s\S]*? matches the way an HTML parser does: up to the first </script>.
  out = out.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (tag, attrs, body) => {
    if (/\bsrc\s*=/.test(attrs)) return tag; // has a src (local or unusual); not inline
    hashes.push(...inlineHashes(body));
    return tag;
  });

  return { html: out, hashes, stripped };
}

/**
 * Rewrite a JS bundle: puter loader URLs (used by apps that load Puter from
 * their own code, incl. lazy `<script>` injection in chess/checkers/backgammon
 * and 3d) become the shim path — with ?app=<name> so a dynamically injected
 * loader still names its app. Other external URLs are collected. A few
 * root-absolute asset references inside HTML template literals (the phase-1
 * shape: img src="/icon.svg") get the same /h/<name>/ prefix the HTML pass
 * applies, so no app request falls outside its own scope.
 */
export function rewriteJs(text, { name } = {}) {
  const shimUrl = name ? `${shimPath()}?app=${encodeURIComponent(name)}` : shimPath();
  const urls = [];
  let out = text.replace(PUTER_BODY_RE, (m) => {
    urls.push(m);
    return shimUrl;
  });
  if (name) {
    const prefix = `/h/${name}/`;
    if (name === 'photo-studio') {
      out = out.replaceAll('fetch("/photo-engine.wasm")', `fetch("${prefix}photo-engine.wasm")`);
    }
    out = out.replace(
      /\b(src|poster)\s*=\s*"(\/(favicon[^"]*|apple-touch[^"]*|icon[^"]*|logo[^"]*|manifest\.(?:json|webmanifest)))"/gi,
      (m, attr, url) => (/^\/+(hub|api|h)(\/|$)/.test(url) ? m : `${attr}="${prefix}${url.slice(1)}"`),
    );
    // Same root-absolute policy for service-worker registration: contacts
    // registers `/sw.js`, which under upstream's per-domain serving was the
    // app's own root. Here the app root is /h/<name>/, so an absolute
    // registration must be prefixed or the browser rejects it (scope out of
    // range) and the SW silently never installs — observed as contacts's
    // missing offline shell in the Chromium pass.
    out = out.replace(
      /(navigator\s*\.\s*serviceWorker\s*\.\s*register\s*\(\s*)(['"])\/(sw[^'"\s]*\.js|service-?worker[^'"\s]*\.js)\2/gi,
      (m, pre, q, file) => (`${pre}${q}${prefix}${file}${q}`),
    );
  }
  return { text: out, urls };
}

/**
 * Per-app CSP additions, only where a build really needs them (evidenced in
 * the browser pass, logged in the README honest-diffs table):
 *   - audio-studio runs WebAssembly (@ffmpeg wasm) → 'wasm-unsafe-eval';
 *   - 3d ships an emscripten-style lib that instantiates code from strings →
 *     'unsafe-eval'.
 * Every other app runs with script-src 'self'.
 */
export const CSP_SCRIPT_EXTRAS = {
  '3d': ["'unsafe-eval'"],
  'audio-studio': ["'wasm-unsafe-eval'"],
  'photo-studio': ["'wasm-unsafe-eval'"],
  'video-studio': ["'wasm-unsafe-eval'"],
};

/**
 * Guard prepended to every served service-worker script. Upstream SWs cache
 * same-origin GETs cache-first (assets only on Puter, where API calls were
 * cross-origin); here the hub API is same-origin, so without this guard a
 * stale API response would be served from a cache on reconnect (observed with
 * tasks's grants fetch). The wrapper rejects hub-API and hub-worker requests
 * from the SW entirely — they always go to the network — and leaves every
 * other behavior (precache, hashed assets, navigations, notifications) alone.
 */
export const SERVICE_WORKER_GUARD = `/* cad-home serve-time guard: hub API and worker requests never pass through
   a service worker cache. This wrapper is prepended before the script so it
   wraps every 'fetch' listener the worker registers. Same-origin check here is
   deliberate: cross-origin navigations never triggered the caches at issue. */
(function () {
  var realAddEventListener = self.addEventListener.bind(self);
  self.addEventListener = function (type, fn, opts) {
    if (type !== 'fetch' || typeof fn !== 'function') return realAddEventListener(type, fn, opts);
    var guarded = function (event) {
      try {
        var u = new URL(event.request.url, self.location.href);
        if (u.origin === self.location.origin &&
            (u.pathname === '/api' || u.pathname.startsWith('/api/') ||
             u.pathname === '/wr' || u.pathname.startsWith('/wr/'))) return;
      } catch (e) { /* unparseable URL defers to the app's own handler */ }
      return fn.call(self, event);
    };
    return realAddEventListener(type, guarded, opts);
  };
})();
`;

export function rewriteServiceWorker(text) {
  return SERVICE_WORKER_GUARD + text;
}

/** What the strict CSP looks like for one HTML response. `extras` are the
 * per-app script-src additions from CSP_SCRIPT_EXTRAS (documented cases only). */
export function cspHeader({ hashes = [], extras = [], connectExtras = [] } = {}) {
  const script = ["'self'", ...new Set([...hashes.map((h) => `'${h}'`), ...extras])];
  const connect = ["'self'", ...new Set(connectExtras)];
  return [
    "default-src 'self'",
    `script-src ${script.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    `connect-src ${connect.join(' ')}`,
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "form-action 'self'",
    "base-uri 'self'",
    'report-uri /hub/csp-report',
  ].join('; ');
}

/**
 * PWA manifests baked by some apps use absolute paths (start_url /, icon srcs
 * like /icon.svg). Under /h/<name>/ those need the app prefix — same rule as
 * the vite --base flag, applied to the JSON at serve time.
 */
export function rewriteManifest(text, name) {
  const prefix = `/h/${name}/`;
  return text.replace(/("(?:src|start_url|scope|logout_url|serviceworker|id)"\s*:\s*)"(\/[^"]*)"/g, (m, key, url) => {
    if (url.startsWith(prefix) || url.startsWith('//')) return m;
    return `${key}"${prefix}${url.slice(1)}`;
  });
}

/**
 * Per-app path-prefix problem tracker. The apps were written to live at the
 * root of their own site; when served under /h/<name>/ some of their own code
 * still points there. Static heuristics over the built files, recorded per app
 * in hub metadata so the later decision (/h/<name>/ vs per-app origins) is made
 * on numbers, not impressions:
 *  - service workers registered with a root-absolute URL (break: 404, then a
 *    silent catch in most apps);
 *  - quoted strings that look like app-root-absolute static assets (favicon,
 *    icons, logo, manifest, sw.js, screenshots) — most are <img>/preload
 *    templates inside bundles.
 */
export function scanPathIssues(dir) {
  const issues = { swRegister: [], assetStrings: [] };
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!/\.(js|mjs|js.gz|html)$/i.test(e.name) && !e.isDirectory()) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      let text;
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      for (const m of text.matchAll(/serviceWorker\.register\(\s*(['"])(\/[^'"]+)\1/g)) {
        issues.swRegister.push(m[2]);
      }
      for (const m of text.matchAll(
        /['"]\/(favicon[^'"`]*|apple-touch[^'"`]*|icon[^'"`]*?[.](?:png|svg|ico|jpg)|icons\/[^'"`]*|logo[^'"`]*?[.](?:png|svg)|manifest[.](?:json|webmanifest)|sw[.]js|screenshots\/[^'"`]*)['"]/g,
      )) {
        issues.assetStrings.push(m[1]);
      }
    }
  };
  walk(dir);
  for (const k of Object.keys(issues)) issues[k] = [...new Set(issues[k])];
  return issues;
}

/**
 * Every external URL a built app would try to reach. Reads all text-ish files
 * under dir; returns [{ url, count }]. Harmless namespace strings (licence
 * links in comments, UA-sniffing code like 'puter.com' inside identifiers) show
 * up alongside real fetches — the admin decides per URL.
 */
export function scanForExternalUrls(dir, { limit = 5 * 1024 * 1024 } = {}) {
  const TEXT = new Set(['.html', '.htm', '.js', '.mjs', '.cjs', '.css', '.json', '.map', '.svg', '.xml', '.txt', '.md', '.webmanifest', '.wasm']);

  function* walk(d) {
    // Normalise so files join as dir + '/' + name at every depth.
    if (!d.endsWith('/')) d += '/';
    for (const entry of readdirSafe(d)) {
      const full = `${d}${entry.name}`;
      if (entry.isDirectory) yield* walk(full + '/');
      else yield { full, ...entry };
    }
  }

  const found = new Map();
  const re = new RegExp(URL_RE.source, 'g'); // fresh lastIndex per scan
  for (const { full, size } of walk(dir)) {
    if (size > limit) continue;
    if (!TEXT.has(full.slice(full.lastIndexOf('.')).toLowerCase())) continue;
    let text;
    try {
      text = readText(full);
    } catch {
      continue;
    }
    re.lastIndex = 0;
    let match = re.exec(text);
    while (match) {
      let url = match[0].replace(/[.,;:]$/, '');
      // Trim obviously embedded path fragments the app never fetches: a raw
      // 'https://something.else' inside prose is still listed as-is so nothing hides.
      while (url.length && /[)\]]+$/.test(url)) url = url.slice(0, -1);
      const rec = found.get(url) || { url, count: 0, files: [] };
      rec.count++;
      const short = full.slice(dir.length + 1);
      if (rec.files.length < 5 && !rec.files.includes(short)) rec.files.push(short);
      found.set(url, rec);
      match = re.exec(text);
    }
  }
  return [...found.values()].sort((a, b) => b.count - a.count || a.url.localeCompare(b.url));
}

// Filesystem helpers kept local so this file stays import-free and pure.
import fs from 'node:fs';

function readdirSafe(d) {
  try {
    return fs.readdirSync(d, { withFileTypes: true }).map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
  } catch {
    return [];
  }
}

function readText(f) {
  const st = fs.statSync(f);
  const buf = fs.readFileSync(f).subarray(0, Math.min(st.size, 8 * 1024 * 1024));
  return buf.toString('utf8');
}

/**
 * §22: every serve-time rewrite as a NAMED rule, and a counter that runs each
 * rule over every built dist — so the build can FAIL when a rule no longer
 * matches anything upstream (an upstream change silently obsoleting a
 * rewrite instead of it failing open at runtime). A rule's hit = one file in
 * which the rule has something to do:
 *
 *   shim-swap    — js.puter.com references serve time rewires to the shim
 *   sw-guard     — service-worker scripts the cache guard is prepended to
 *   manifest     — webmanifest / manifest*.json rewrite targets
 *   html-strip   — html files with external resources rewriteHtml strips
 */
const TEXT_FILE = /\.(html?|js|mjs|cjs|json|webmanifest)$/i;

/**
 * Per-app serve-time JS replacements (§24 productization). Apps stay
 * untouched in the clone; these run on the served bytes, same as the
 * generic rewrites above. The `old` strings are exact slices of the built
 * (minified) bundle — a rebuild that changes the shape makes the §22
 * zero-match check flag the rule, so the mismatch is loud, never silent.
 *
 * signatures:
 *  - 'sign-page-url': the owner-side pageUrl default composes
 *    `location.origin… + 'sign.html'` — the OWNER's page origin. Locally the
 *    signer is a guest on the PUBLIC listener, so the sign page must come
 *    from the guest origin (§23 base; substituted at serve time by
 *    __CAD_GUEST_BASE__). appUrl stays the owner's own origin (used for the
 *    owner-facing doc link; docUrlFor's https-only check then omits it over
 *    plain http LAN origins — documented honest diff).
 *  - 'sign-link-host': the guest sign page hard-checks the link's worker
 *    host `https://<name>.puter.work`. Upstream has no other namespace; we
 *    ADD an arm for http links (our §23 no-base fallback links are LAN
 *    `http://<host>/w/<user>/<name>` — the FULL url becomes the worker base
 *    the page calls). Canonical `https://<label>.puter.work` links keep
 *    taking the untouched https arm (and the guest-page URL mapper maps
 *    them onto the /w/host/ route at serve time, §26).
 *  - 'sign-worker-self': the deployed worker's /sign/<token> 303 only names
 *    `new URL(ctx.request.url).origin`, which drops the wrapper path
 *    (`/w/<user>/<name>`). The source is patched so the fragment carries the
 *    worker's own address INCLUDING that path (everything after /sign/ is
 *    stripped) — the runner gives the child the wrapper path via
 *    ctx.request.url (§17); this rule is what makes the published fragment
 *    a working URL.
 */
export const APP_JS_RULES = {
  signatures: [
    {
      name: 'sign-page-url',
      old: 'pageUrl:s=(typeof location<`u`&&location.origin&&location.origin!==`null`?location.origin+location.pathname.replace(/[^/]*$/,``):`https://puter.com/`)+`sign.html`,appUrl:c=s.replace(/sign\\.html$/,``)',
      replacement: 'pageUrl:s=`__CAD_GUEST_BASE__/h/signatures/sign.html`,appUrl:c=location.origin+location.pathname.replace(/[^/]*$/,``)',
    },
    {
      name: 'sign-link-host',
      // Byte-exact slice of the built sign chunk (readLink). The added arm
      // accepts our LAN http links; the canonical https arm is untouched.
      old: 'e.protocol===`https:`&&/^[a-z0-9-]+\\.puter\\.work$/i.test(e.hostname)&&(r=`https://${e.hostname.toLowerCase()}`)',
      replacement: 'e.protocol===`https:`&&/^[a-z0-9-]+\\.puter\\.work$/i.test(e.hostname)&&(r=`https://${e.hostname.toLowerCase()}`),e.protocol===`http:`&&(r=e.href)',
    },
    {
      name: 'sign-worker-self',
      // Byte-exact slice of the DEPLOYED WORKER SOURCE inside the owner chunk
      // (the chunk embeds sign-worker.js in a template literal, so the regex
      // backslashes are doubled and no `${` sequence may appear). The patched
      // source is evaluated at deploy; the produced line stays valid worker
      // JS: the /sign/<token> 303 fragment carries the worker's own address
      // INCLUDING the wrapper path (the §17 wrapper reaches the child through
      // ctx.request.url, §26).
      old: 'w: new URL(ctx.request.url).origin,',
      replacement: 'w: new URL(ctx.request.url).href.replace(/\\\\/sign\\\\/.*$/, ""),',
    },
    {
      name: 'sign-guest-link',
      // Byte-exact slice of the owner chunk: the guest sign-link composition
      // (syncDoc's `links[signerId] = `${cfg.url}/sign/${token}``). The app
      // only sees canonical rows (§26), but a link the OWNER actually shares
      // must be OPENABLE by a guest: §23 resolves it on the configured public
      // base through the /w/host/<label> public alias of the worker's
      // canonical hostname (both listeners host that route). With no public
      // base configured the marker is not an http string and the composition
      // keeps the honest canonical row URL (documented degrade; guests cannot
      // be made reachable without a public base).
      old: 'o[e]=`${r.url}/sign/${t}`;',
      replacement: 'o[e]=`${(`__CAD_GUEST_BASE__`.startsWith(`http`)?`__CAD_GUEST_BASE__/w/host/`+new URL(r.url).host.replace(/\\.puter\\.work$/,``):r.url)}/sign/${t}`;',
    },
  ],
};

const SIGN_WORKER_PDF_READ = `const blob = await ownerOf(ctx).puter.fs.read(path);
    const bytes = blob && typeof blob.arrayBuffer === 'function' ? await blob.arrayBuffer() : blob;
    return new Response(bytes, {
      headers: {`;

/** Public signing pages have a token-checked PDF route, but public workers
 * never receive a general filesystem API. Turn that one route into a narrow
 * file response marker; the parent serves only signatures app PDFs. */
export function rewriteWorkerSource(text, { app, filePath } = {}) {
  if (app !== 'signatures' || filePath !== 'sign-worker.js') return { text, applied: false };
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.includes(SIGN_WORKER_PDF_READ)) {
    throw new Error('Serve-time rule sign-worker-public-pdf no longer matches signatures/sign-worker.js');
  }
  return {
    text: normalized.replace(SIGN_WORKER_PDF_READ, `return new Response(null, {
      headers: {
        'x-cad-public-file': path,`),
    applied: true,
  };
}

/** Serve-time hook: apply an app's rules to a JS bundle. Unmatched rules are
 * reported (never silent) but do not break serving. */
export function applyAppJsRules(text, name) {
  const rules = APP_JS_RULES[name];
  if (!rules) return { text, applied: [], missed: [] };
  let out = text;
  const applied = [];
  const missed = [];
  for (const r of rules) {
    if (out.includes(r.old)) {
      out = out.replace(r.old, r.replacement);
      applied.push(r.name);
    } else {
      missed.push(r.name);
    }
  }
  return { text: out, applied, missed };
}

export const REWRITE_RULES = [
  {
    name: 'shim-swap',
    hits: (text, file) => TEXT_FILE.test(file)
      && /https?:\/\/js\.puter\.com\//.test(text),
  },
  {
    name: 'sw-guard',
    hits: (text, file) => /(^|\/)(sw|service-?worker)\.js$/i.test(file),
  },
  {
    name: 'manifest',
    hits: (text, file) => (/\.webmanifest$/i.test(file) || /(^|\/)manifest[^/]*\.json$/i.test(file)) && TEXT_FILE.test(file),
  },
  {
    name: 'html-strip',
    hits: (text, file) => /\.html?$/i.test(file) && rewriteHtml(text).stripped.length > 0,
  },
  {
    name: 'sign-page-url',
    hits: (text, file) => TEXT_FILE.test(file) && text.includes(APP_JS_RULES.signatures[0].old),
  },
  {
    name: 'sign-link-host',
    hits: (text, file) => TEXT_FILE.test(file) && text.includes(APP_JS_RULES.signatures[1].old),
  },
  {
    name: 'sign-worker-self',
    hits: (text, file) => TEXT_FILE.test(file) && text.includes(APP_JS_RULES.signatures[2].old),
  },
  {
    name: 'sign-guest-link',
    hits: (text, file) => TEXT_FILE.test(file) && text.includes(APP_JS_RULES.signatures[3].old),
  },
  {
    name: 'sign-worker-public-pdf',
    hits: (text, file) => TEXT_FILE.test(file)
      && text.includes('ownerOf(ctx).puter.fs.read(path)'),
  },
];

/** Hit counts per rule across every built dist root (e.g. data/hub/apps). */
export function countRuleHits(root, rules = REWRITE_RULES) {
  const counts = Object.fromEntries(rules.map((r) => [r.name, 0]));
  function* walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) yield* walk(full);
      else yield { file: e.name, full };
    }
  }
  const seen = new Set();
  for (const { file, full } of walk(root)) {
    if (seen.has(full)) continue;
    seen.add(full);
    if (!TEXT_FILE.test(file)) continue;
    let text;
    try { text = readText(full); } catch { continue; }
    for (const r of rules) {
      try { if (r.hits(text, file)) counts[r.name] += 1; } catch { /* unreadable shape */ }
    }
  }
  return counts;
}

/** §22 verdict: { counts, zeros, bad } — `bad` are zero-hit rules that were
 * NOT retired via the leave list; the build throws on bad.length > 0. */
export function zeroMatchVerdict(root, { leave = [], print = false } = {}) {
  const counts = countRuleHits(root);
  const zeros = REWRITE_RULES.map((r) => r.name).filter((n) => !counts[n]);
  const retired = new Set(leave.map((s) => String(s).trim()).filter(Boolean));
  const bad = zeros.filter((n) => !retired.has(n));
  if (print) {
    for (const [name, n] of Object.entries(counts)) console.log(`  ${name.padEnd(12)} ${n}`);
  }
  return { counts, zeros, bad, retired: [...retired] };
}

/**
 * §22 zero-match rule check. The serve-time rewrites live in this module as
 * named rules; this counter runs each rule over every built dist and reports
 * per-rule hit counts, so a build can FAIL when a rule no longer matches
 * anything upstream (an upstream change silently obsoleting a rewrite).
 *
 * Rules (hit = file where the rule has something to do):
 *   shim-swap    — js.puter.com references that serve time rewires to the shim
 *   sw-guard     — service-worker scripts the guard is prepended to
 *   manifest     — webmanifest / manifest*.json rewrite targets
 *   html-strip   — html files with external resources rewriteHtml strips
 */
