/**
 * The cad-home Puter shim (client side). Served at /hub/puter.js in place of
 * js.puter.com for hub apps. CAD_HUB_API_ORIGIN is substituted at serve time
 * with the same-origin API base (/api/hub).
 *
 * Phase 2 scope: fs (behind grants), kv, ai.chat, and the ui file pickers.
 * Method names, return shapes and error codes match the observable behavior
 * of the Apache License 2.0 puter-js SDK (github.com/HeyPuter/puter, src/puter-js):
 * picker results are FSItem instances with methods; readdir/stat/write
 * resolve plain v1 entries. Everything else answers honestly.
 *
 * No external requests ever: the shim talks only to its own origin, and
 * rejects any URL an app hands it that points elsewhere.
 *
 * This file contains no AGPL-licensed Puter backend code.
 */
(function () {
  'use strict';
  var API = /*CAD_HUB_API_ORIGIN*/ '/api/hub';
  var HOSTING_BASE = CAD_HUB_HOSTING_BASE;
  window.puter = window.puter || {};
  var puter = window.puter;

  puter.version = 'cad-home-shim-2 (phase 2: fs, kv, ai.chat, ui pickers)';
  puter.env = 'app'; // like puter-js "app" env: relative paths resolve into the app's own folder
  puter.APIOrigin = API;
  puter.cadHub = true; // apps may feature-test instead of guessing
  puter.print = 'cad-home hub'; // matches puter-js: a build tag, not a function

  // -- plumbing --------------------------------------------------------

  // Every call names its app: the session cookie says WHO, the app name says
  // WHICH app's sandbox and grant space the server should use. Static pages
  // carry it on the shim's own script tag (data-cad-app, set at serve time);
  // apps that inject the loader themselves get window.CAD_HUB_APP, which the
  // server puts ahead of the shim when the loader asks for ?app=<name>.
  var APPNAME = (function () {
    var fromTag = '';
    try {
      var s = document.currentScript || document.querySelector('script[src$="/hub/puter.js"]');
      fromTag = (s && s.dataset && s.dataset.cadApp) || '';
    } catch (e) { /* older browsers: fall through */ }
    var fromGlobal = '';
    try { fromGlobal = String(window.CAD_HUB_APP || ''); } catch (e2) { fromGlobal = ''; }
    var n = fromTag || fromGlobal;
    if (n && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(n)) return n;
    return 'app';
  })();
  puter.appID = APPNAME;
  function withApp(path) {
    if (path.indexOf('app=') >= 0) return path;
    return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'app=' + encodeURIComponent(APPNAME);
  }

  // -- cross-app connections (puter.ui.launchApp in background mode) -----
  // A background launch opens the target app in a hidden same-origin iframe.
  // Parent and child speak over postMessage under a random token carried in
  // the child's URL, so no other window on the page can join the channel.
  // Upstream apps read the launch arguments as puter.args (calendar-api's
  // service mode) and the caller as puter.source_app.name in the URL.
  var LAUNCH = (function () {
    var q = null;
    try { q = new URLSearchParams(window.location.search); } catch (e) { q = null; }
    var args = {};
    try {
      var parsed = JSON.parse((q && q.get('cad_args')) || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
    } catch (e2) { args = {}; }
    return {
      token: String((q && q.get('cad_launch')) || ''),
      args: args,
      source: String((q && q.get('cad_source_app')) || ''),
    };
  })();
  puter.args = LAUNCH.args;
  puter.sourceApp = LAUNCH.source || null;

  function call(method, path, body) {
    var headers = { 'X-CAD-Request': '1' };
    var init = { method: method, credentials: 'include', headers: headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(
        body !== null && typeof body === 'object' && !Array.isArray(body)
          ? Object.assign({}, body, { app: APPNAME })
          : body,
      );
    }
    return fetch(API + withApp(path), init);
  }

  function rawCall(method, path, contentType, body) {
    var headers = { 'X-CAD-Request': '1' };
    if (contentType) headers['Content-Type'] = contentType;
    return fetch(API + withApp(path), { method: method, credentials: 'include', headers: headers, body: body });
  }

  // Apps form https://<name>.puter.site URLs themselves. Translate those
  // URLs at the shim boundary to this server's public /site/<name> mount.
  function mapHostedUrl(value) {
    if (!HOSTING_BASE || typeof value !== 'string') return value;
    return value.replace(/^https?:\/\/([a-z0-9][a-z0-9-]{0,61}[a-z0-9])\.puter\.site(?=[:/?#]|$)/i,
      function (_all, name) { return HOSTING_BASE + encodeURIComponent(name.toLowerCase()); });
  }
  if (typeof Element !== 'undefined' && Element.prototype.setAttribute) {
    var nativeSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      var key = String(name).toLowerCase();
      if (key === 'href' || key === 'action' || key === 'src') value = mapHostedUrl(String(value));
      return nativeSetAttribute.call(this, name, value);
    };
  }
  if (typeof HTMLAnchorElement !== 'undefined') {
    var hrefDescriptor = Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, 'href');
    if (hrefDescriptor && hrefDescriptor.set && hrefDescriptor.get) {
      Object.defineProperty(HTMLAnchorElement.prototype, 'href', Object.assign({}, hrefDescriptor, {
        set: function (value) { return hrefDescriptor.set.call(this, mapHostedUrl(String(value))); },
      }));
    }
  }
  if (typeof window.fetch === 'function') {
    var nativeFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      // A Request with a body may only ever be constructed ONCE: chaining
      // `new Request(url, otherRequest)` detaches the body stream in a real
      // browser and uploads die mid-flight ("Failed to fetch"). Keep the
      // original request when the URL is not rewritten.
      if (input && typeof input === 'object' && typeof input.url === 'string') {
        var reqUrl = String(input.url);
        var reqMapped = mapHostedUrl(reqUrl);
        if (reqMapped === reqUrl) return nativeFetch(input, init);
        if (init) {
          var mergedInit = Object.assign({}, init);
          if (mergedInit.method === undefined) mergedInit.method = input.method;
          if (mergedInit.headers === undefined) mergedInit.headers = input.headers;
          if (mergedInit.body === undefined && input.body !== null && !/^(GET|HEAD)$/i.test(mergedInit.method || '')) {
            return input.clone().arrayBuffer().then(function (buffer) {
              mergedInit.body = buffer;
              return nativeFetch(new Request(reqMapped, mergedInit));
            });
          }
          return nativeFetch(new Request(reqMapped, mergedInit));
        }
        var method = input.method || 'GET';
        var head = input.headers;
        if (input.body === null || method === 'GET' || method === 'HEAD') {
          return nativeFetch(new Request(reqMapped, { method: method, headers: head }));
        }
        return input.clone().arrayBuffer().then(function (buffer) {
          return nativeFetch(new Request(reqMapped, { method: method, headers: head, body: buffer }));
        });
      }
      var mapped = typeof input === 'string' ? mapHostedUrl(input) : input;
      if (typeof input === 'string' && mapped === input) return nativeFetch(input, init);
      if (typeof input === 'string' && mapped !== input && init === undefined) return nativeFetch(new Request(mapped), undefined);
      return nativeFetch(mapped, init);
    };
  }
  if (window.XMLHttpRequest) {
    var nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      arguments[1] = mapHostedUrl(String(url));
      return nativeOpen.apply(this, arguments);
    };
  }
  if (typeof window.open === 'function') {
    var nativeWindowOpen = window.open.bind(window);
    window.open = function (url) { arguments[0] = mapHostedUrl(String(url)); return nativeWindowOpen.apply(window, arguments); };
  }
  if (typeof MutationObserver !== 'undefined' && document.documentElement) {
    var rewriteSiteLinks = function (root) {
      if (!root || root.nodeType !== 1) return;
      if (root.matches && root.matches('a[href],form[action],iframe[src]')) {
        var attr = root.matches('a[href]') ? 'href' : root.matches('form[action]') ? 'action' : 'src';
        var before = root.getAttribute(attr); var after = mapHostedUrl(before);
        if (after !== before) root.setAttribute(attr, after);
      }
      if (root.querySelectorAll) root.querySelectorAll('a[href],form[action],iframe[src]').forEach(rewriteSiteLinks);
    };
    new MutationObserver(function (records) { records.forEach(function (r) { r.addedNodes.forEach(rewriteSiteLinks); }); })
      .observe(document.documentElement, { childList: true, subtree: true });
    rewriteSiteLinks(document.documentElement);
  }

  function jsonData(r) {
    try {
      return r.json();
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  // Errors match the SDK's { message, code } shape: a real Error with .code.
  function apiFail(r, data) {
    var err = new Error((data && data.message) || 'The server answered ' + r.status + '.');
    err.code = (data && data.code) || 'server_error';
    err.status = r.status;
    // A refused Drive write carries the structured grant request (lib/hub-fsops
    // access()); the mutating fs ops turn it into the consent overlay.
    err.grantRequest = (data && data.grant_request) || null;
    return Promise.reject(err);
  }

  function request(method, path, body) {
    return call(method, path, body).then(function (r) {
      return jsonData(r).then(function (d) {
        if (!r.ok) return apiFail(r, d);
        return d;
      });
    });
  }

  // -- Drive consent overlay -------------------------------------------------

  // A Drive write this app has no grant for is never silently allowed and
  // never silently refused: the server answers no_permission_for_app with a
  // structured grant request, and the shim asks the person once, in this
  // page, with explicit Allow / Deny. An Allow creates the same revocable
  // grant the Account page lists (source 'consent'); a Deny hands the app the
  // original error, exactly as if no overlay existed.

  // The dialog renders in a CLOSED shadow root, so app code cannot reach the
  // buttons to call .click() or dispatch synthetic events on them (closed
  // roots are unreachable from the page; puppeteer-class tooling still can,
  // which is exactly the split we want: a person can, code cannot). Only
  // trusted user events get through — every handler checks isTrusted — and
  // the host element carries the decision as dataset state the page (and the
  // smoke) can observe without opening the root.
  function consentOverlay(req) {
    return new Promise(function (resolve) {
      var host = document.createElement('div');
      host.className = 'cad-consent-host';
      host.dataset.cadConsent = 'pending';
      host.dataset.cadApp = String(APPNAME);
      host.dataset.cadPath = String(req.path || '/');
      host.dataset.cadNeed = String(req.need || 'write');
      var shadow = host.attachShadow({ mode: 'closed' });

      var finish = function (allowed) {
        if (host.dataset.cadConsent !== 'pending') return; // one decision
        host.dataset.cadConsent = allowed ? 'allowed' : 'denied';
        try { document.removeEventListener('keydown', onKey, true); } catch (e) { /* ignore */ }
        host.remove();
        resolve(allowed);
      };

      var st = document.createElement('style');
      st.textContent =
        '.cad-consent-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;' +
        'align-items:center;justify-content:center;z-index:2147483647;font:15px/1.5 system-ui,' +
        '-apple-system,"Segoe UI",sans-serif}' +
        '.cad-consent-box{max-width:22rem;margin:1rem;padding:18px 20px;border-radius:12px;background:' +
        '#fff;color:#1c1c1c;box-shadow:0 12px 40px rgba(0,0,0,.35)}' +
        '@media (prefers-color-scheme:dark){.cad-consent-box{background:#26262b;color:#ececf0}}' +
        '.cad-consent-title{font-size:15px;font-weight:600;margin:0 0 6px}' +
        '.cad-consent-note{font-size:12.5px;opacity:.7;margin:0 0 14px}' +
        '.cad-consent-actions{display:flex;gap:8px;justify-content:flex-end}' +
        '.cad-consent-actions button{font:inherit;padding:6px 14px;border-radius:8px;border:1px solid ' +
        'rgba(128,128,128,.45);background:transparent;color:inherit;cursor:pointer;min-width:84px;' +
        'min-height:36px}' +
        '.cad-consent-allow{background:#2563eb;border-color:#2563eb;color:#fff;font-weight:600}';
      shadow.appendChild(st);

      var backdrop = document.createElement('div');
      backdrop.className = 'cad-consent-backdrop';
      var box = document.createElement('div');
      box.className = 'cad-consent-box';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      var where = req.path === '/' ? 'your Drive (all of it)' : (req.path || 'your Drive').replace(/^\//, '');
      var title = document.createElement('p');
      title.className = 'cad-consent-title';
      title.textContent = req.need === 'read'
        ? '"' + APPNAME + '" wants to open files in ' + where
        : '"' + APPNAME + '" wants to save into ' + where;
      box.appendChild(title);
      var note = document.createElement('p');
      note.className = 'cad-consent-note';
      note.textContent = 'Outside this app\'s own data folder. You can revoke this at any time in the hub Account page.';
      box.appendChild(note);
      var actions = document.createElement('div');
      actions.className = 'cad-consent-actions';
      var deny = document.createElement('button');
      deny.textContent = 'Deny';
      deny.type = 'button';
      var allow = document.createElement('button');
      allow.textContent = 'Allow';
      allow.type = 'button';
      allow.className = 'cad-consent-allow';
      actions.appendChild(deny);
      actions.appendChild(allow);
      box.appendChild(actions);
      backdrop.appendChild(box);
      shadow.appendChild(backdrop);
      document.body.appendChild(host);

      // Trusted user events only: a click handed to us by page script — even
      // one that somehow landed here — never decides a grant.
      allow.addEventListener('click', function (e) { if (!e.isTrusted) return; finish(true); });
      deny.addEventListener('click', function (e) { if (!e.isTrusted) return; finish(false); });
      var onKey = function (e) {
        if (e.isTrusted && e.key === 'Escape') finish(false);
      };
      document.addEventListener('keydown', onKey, true);
      try { allow.focus(); } catch (e2) { /* older browsers */ }
      // Pointing coordinates, published in the light DOM so real input
      // (CDP, a test, an accessibility tool) can aim at the closed dialog.
      // Page script knowing a geometry cannot produce a trusted event, so
      // this opens nothing — it exists so that "a person could click it"
      // stays true for tooling that drives real input.
      var publish = function () {
        var ra = allow.getBoundingClientRect();
        var rd = deny.getBoundingClientRect();
        host.dataset.cadAim = Math.round(ra.left + ra.width / 2) + ',' + Math.round(ra.top + ra.height / 2);
        host.dataset.cadDenyAim = Math.round(rd.left + rd.width / 2) + ',' + Math.round(rd.top + rd.height / 2);
      };
      publish();
    });
  }

  /**
   * A DEPLOY consent (§13/§24): the same trusted-user dialog, different
   * wording — an app putting a background worker under this member's
   * account. A Deny is remembered for the page session, so upstream's
   * create-retry loop fails fast instead of reopening the dialog three
   * times; the retry gets the same named error shape it already handles.
   */
  var deployDenied = false;
  function deployOverlay(name) {
    if (deployDenied) return Promise.resolve(false);
    return new Promise(function (resolve) {
      var host = document.createElement('div');
      host.className = 'cad-consent-host';
      host.dataset.cadDeploy = 'pending';
      host.dataset.cadApp = String(APPNAME);
      host.dataset.cadWorker = String(name || '');
      var shadow = host.attachShadow({ mode: 'closed' });

      var finish = function (allowed) {
        if (host.dataset.cadDeploy !== 'pending') return; // one decision
        host.dataset.cadDeploy = allowed ? 'allowed' : 'denied';
        try { document.removeEventListener('keydown', onKey, true); } catch (e) { /* ignore */ }
        host.remove();
        if (!allowed) deployDenied = true;
        resolve(allowed);
      };

      var st = document.createElement('style');
      st.textContent =
        '.cad-consent-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;' +
        'align-items:center;justify-content:center;z-index:2147483647;font:15px/1.5 system-ui,' +
        '-apple-system,"Segoe UI",sans-serif}' +
        '.cad-consent-box{max-width:22rem;margin:1rem;padding:18px 20px;border-radius:12px;background:' +
        '#fff;color:#1c1c1c;box-shadow:0 12px 40px rgba(0,0,0,.35)}' +
        '@media (prefers-color-scheme:dark){.cad-consent-box{background:#26262b;color:#ececf0}}' +
        '.cad-consent-title{font-size:15px;font-weight:600;margin:0 0 6px}' +
        '.cad-consent-note{font-size:12.5px;opacity:.7;margin:0 0 14px}' +
        '.cad-consent-actions{display:flex;gap:8px;justify-content:flex-end}' +
        '.cad-consent-actions button{font:inherit;padding:6px 14px;border-radius:8px;border:1px solid ' +
        'rgba(128,128,128,.45);background:transparent;color:inherit;cursor:pointer;min-width:84px;' +
        'min-height:36px}' +
        '.cad-consent-allow{background:#2563eb;border-color:#2563eb;color:#fff;font-weight:600}';
      shadow.appendChild(st);

      var backdrop = document.createElement('div');
      backdrop.className = 'cad-consent-backdrop';
      var box = document.createElement('div');
      box.className = 'cad-consent-box';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      var title = document.createElement('p');
      title.className = 'cad-consent-title';
      title.textContent = '"' + APPNAME + '" wants to run a background worker ("' + String(name || '') + '")';
      box.appendChild(title);
      var note = document.createElement('p');
      note.className = 'cad-consent-note';
      note.textContent = 'It runs under your account — it sends mail and serves links for this app. You can remove it in the app or the hub admin list.';
      box.appendChild(note);
      var actions = document.createElement('div');
      actions.className = 'cad-consent-actions';
      var deny = document.createElement('button');
      deny.textContent = 'Deny';
      deny.type = 'button';
      var allow = document.createElement('button');
      allow.textContent = 'Allow';
      allow.type = 'button';
      allow.className = 'cad-consent-allow';
      actions.appendChild(deny);
      actions.appendChild(allow);
      box.appendChild(actions);
      backdrop.appendChild(box);
      shadow.appendChild(backdrop);
      document.body.appendChild(host);

      allow.addEventListener('click', function (e) { if (!e.isTrusted) return; finish(true); });
      deny.addEventListener('click', function (e) { if (!e.isTrusted) return; finish(false); });
      var onKey = function (e) {
        if (e.isTrusted && e.key === 'Escape') finish(false);
      };
      document.addEventListener('keydown', onKey, true);
      try { allow.focus(); } catch (e2) { /* older browsers */ }
      var publish = function () {
        var ra = allow.getBoundingClientRect();
        var rd = deny.getBoundingClientRect();
        host.dataset.cadAim = Math.round(ra.left + ra.width / 2) + ',' + Math.round(ra.top + ra.height / 2);
        host.dataset.cadDenyAim = Math.round(rd.left + rd.width / 2) + ',' + Math.round(rd.top + rd.height / 2);
      };
      publish();
    });
  }

  function consentChain(grantReq, originalErr, run) {
    return consentOverlay(grantReq).then(function (allowed) {
      if (!allowed) throw originalErr;
      return request('POST', '/grants', {
        path: grantReq.path,
        perms: grantReq.need === 'read' ? 'read' : 'write',
        source: 'consent',
      }).then(run);
    });
  }

  /** Mutating fs ops (request-based): on a grant-less Drive write ask once.
   *  Allow → POST the one-time grant → retry. Deny → the original error. */
  function requestWithConsent(method, sub, body) {
    var run = function () { return request(method, sub, body); };
    return run().then(undefined, function (err) {
      if (!err || err.code !== 'no_permission_for_app' || !err.grantRequest) throw err;
      return consentChain(err.grantRequest, err, run);
    });
  }

  // This server never lets an app load another site. If an app hands the
  // shim a remote URL, the call fails here before anything happens.
  function assertLocal(url) {
    if (typeof url === 'string' && /^https?:/i.test(url) && url.indexOf(window.location.origin) !== 0) {
      var err = new Error('External URLs are not allowed on this server.');
      err.code = 'external_not_allowed';
      throw err;
    }
    return url;
  }

  function notYet(area, detail) {
    var note = detail || 'Not implemented in this cad-home phase yet.';
    return function () {
      var err = new Error('puter.' + area + ' is not available on this server. ' + note);
      err.code = 'shim_not_available';
      console.warn('[cad-hub] ' + err.message);
      return Promise.reject(err);
    };
  }

  function pendingPromise() {
    var resolve;
    var promise = new Promise(function (res) { resolve = res; });
    return { promise: promise, resolve: resolve };
  }

  // -- FSItem (only picker results carry methods, matching the SDK) ------

  function FSItem(opts) {
    opts = opts || {};
    // Field-for-field the SDK's FSItem constructor (see puter-js FSItem.js).
    this.readURL = opts.readURL ?? opts.read_url ?? null;
    this.writeURL = opts.writeURL ?? opts.write_url ?? null;
    this.metadataURL = opts.metadataURL ?? opts.metadata_url ?? null;
    this.name = opts.name ?? opts.fsentry_name ?? null;
    this.uid = opts.uid ?? opts.uuid ?? opts.fsentry_uid ?? opts.fsentry_id ?? opts.fsentry_uuid ?? opts.id ?? null;
    this.id = this.uid;
    this.uuid = this.uid;
    this.path = opts.path ?? opts.fsentry_path ?? null;
    this.size = opts.size ?? opts.fsentry_size ?? null;
    this.accessed = opts.accessed ?? opts.fsentry_accessed ?? null;
    this.modified = opts.modified ?? opts.fsentry_modified ?? null;
    this.created = opts.created ?? opts.fsentry_created ?? null;
    this.isDirectory = (opts.isDirectory || opts.isDir || opts.is_dir || opts.fsentry_is_dir) ? true : false;
    this.isDir = this.isDirectory;
    this.writable = opts.writable !== undefined ? !!opts.writable : true;
  }
  FSItem.prototype.read = async function () { return puter.fs.read(this.path); };
  FSItem.prototype.write = async function (data) {
    return puter.fs.write(this.path, data, {});
  };
  FSItem.prototype.rename = async function (newName) {
    return puter.fs.rename(this.uid ? { uid: this.uid, newName: newName } : { path: this.path, newName: newName });
  };
  FSItem.prototype.move = async function (dest, overwrite, newName) {
    return puter.fs.move(this.path, dest, { overwrite: overwrite, newName: newName });
  };
  FSItem.prototype.copy = async function (dir, autoRename, overwrite) {
    return puter.fs.copy(this.path, dir, { overwrite: overwrite, dedupeName: autoRename });
  };
  FSItem.prototype.delete = async function () { return puter.fs.delete(this.path, {}); };
  FSItem.prototype.trash = function () { return this.delete(); };
  FSItem.prototype.readdir = async function () { return puter.fs.readdir(this.path); };
  FSItem.prototype.watch = function () {};
  FSItem.prototype.open = function () {};
  FSItem.prototype.setAsWallpaper = function () {};

  // -- auth --------------------------------------------------------------

  puter.auth = {
    isSignedIn: function () {
      return call('GET', '/auth/whoami').then(function (r) { return r.ok; }, function () { return false; });
    },
    getUser: function () {
      return call('GET', '/auth/whoami').then(function (r) {
        if (!r.ok) return null;
        return jsonData(r);
      }, function () { return null; });
    },
    // The puter-js contract: resolves { username, ... } for the signed-in
    // person, rejects with auth_required when nobody is signed in.
    whoami: function () {
      return call('GET', '/auth/whoami').then(function (r) {
        if (r.status === 401) {
          var err = new Error('You are not signed in.');
          err.code = 'auth_required';
          err.status = 401;
          throw err;
        }
        if (!r.ok) {
          var other = new Error('Could not look up your account.');
          other.code = 'auth_failed';
          other.status = r.status;
          throw other;
        }
        return jsonData(r);
      });
    },
    signIn: notYet('auth.signIn', 'People sign in once at the CAD home page; every hub app then uses that session.'),
    signOut: function () {
      return call('POST', '/auth/logout').then(function () { return undefined; });
    },
    isSignedInSync: function () { return null; },
  };

  // -- fs ------------------------------------------------------------------

  // The v1 plain entry that readdir/stat/write resolve to in puter-js.
  function fsEntry(o) {
    var dirname = o.dirname;
    if (dirname === undefined) {
      var slash = String(o.path || '').lastIndexOf('/');
      dirname = slash > 0 ? String(o.path).slice(0, slash) : '';
    }
    if (dirname === '/' && String(o.path).lastIndexOf('/') === 0) dirname = '';
    // The v1 fsentry, field-for-field (putor-js mapV2EntryToV1 output).
    return {
      id: o.id ?? o.uid,
      uid: o.uid ?? o.uuid,
      uuid: o.uuid ?? o.uid,
      parent_id: null,
      parent_uid: null,
      path: o.path,
      dirname: dirname,
      dirpath: dirname,
      name: o.name,
      is_dir: !!o.is_dir,
      is_shortcut: 0,
      shortcut_to: null,
      is_symlink: 0,
      symlink_path: null,
      type: o.is_dir ? 'dir' : 'file',
      writable: o.writable !== false,
      is_public: null,
      is_shared: false,
      thumbnail: null,
      immutable: false,
      metadata: null,
      modified: o.modified,
      created: o.created ?? null,
      accessed: o.accessed ?? null,
      size: o.size ?? null,
      layout: null,
      subdomains: [],
      workers: [],
      has_website: false,
      suggested_apps: null,
      associated_app: null,
    };
  }

  function readFile(path, options) {
    options = options || {};
    var q = new URLSearchParams();
    q.set('path', path);
    if (options.offset) q.set('offset', String(options.offset));
    if (options.byte_count || options.byteCount) q.set('byte_count', String(options.byte_count || options.byteCount));
    return rawCall('GET', '/fs/read?' + q.toString()).then(function (r) {
      if (!r.ok) {
        return jsonData(r).then(function (d) { return apiFail(r, d); }, function () { return apiFail(r, null); });
      }
      return r.blob();
    });
  }

  function dataToBuffer(data) {
    if (data === undefined || data === null) return Promise.resolve(new ArrayBuffer(0));
    if (data instanceof Blob) return data.arrayBuffer();
    if (data instanceof ArrayBuffer) return Promise.resolve(data);
    if (ArrayBuffer.isView(data)) return Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    if (typeof data === 'string') {
      return Promise.resolve(new TextEncoder().encode(data).buffer);
    }
    if (typeof data === 'object' && typeof data.text === 'function') return data.text().then(dataToBuffer);
    return Promise.resolve(new TextEncoder().encode(String(data)).buffer);
  }

  function writeFile(path, data, options) {
    options = options || {};
    var q = new URLSearchParams();
    q.set('path', path);
    q.set('options', JSON.stringify({
      overwrite: options.overwrite, dedupeName: options.dedupeName,
      createMissingParents: options.createMissingParents, exclusive: options.exclusive,
    }));
    return dataToBuffer(data).then(function (buf) {
      var once = function () {
        return rawCall('PUT', '/fs/write?' + q.toString(), 'application/octet-stream', buf).then(function (r) {
          return jsonData(r).then(function (d) {
            if (!r.ok) return apiFail(r, d);
            return fsEntry(d);
          });
        });
      };
      return once().then(undefined, function (err) {
        if (!err || err.code !== 'no_permission_for_app' || !err.grantRequest) throw err;
        return consentChain(err.grantRequest, err, once);
      });
    });
  }

  function mkdir(path, options) {
    options = options || {};
    return requestWithConsent('POST', '/fs/mkdir', {
      path: path,
      options: {
        createMissingParents: options.createMissingParents,
        dedupeName: options.dedupeName,
        exclusive: options.exclusive,
      },
    }).then(fsEntry);
  }

  function readdir(path, options) {
    options = options || {};
    return request('POST', '/fs/readdir', {
      path: path,
      options: {
        limit: options.limit, offset: options.offset, cursor: options.cursor,
        includeTotal: options.includeTotal,
      },
    }).then(function (d) {
      // No pagination options ask → plain array; with cursor/limit/includeTotal
      // (or includeTotal) → the page envelope, exactly like puter-js.
      return d;
    });
  }

  function stat(path) {
    return request('POST', '/fs/stat', { path: path }).then(fsEntry);
  }

  function fsDelete(paths, options) {
    options = options || {};
    var recursive = options.recursive === undefined ? true : !!options.recursive;
    return requestWithConsent('POST', '/fs/delete', {
      path: paths,
      options: { recursive: recursive, descendantsOnly: !!options.descendantsOnly },
    }).then(function () { return undefined; });
  }

  function fsRename(input) {
    return requestWithConsent('POST', '/fs/rename', input).then(fsEntry);
  }

  function fsMove(source, destination, options) {
    options = options || {};
    return requestWithConsent('POST', '/fs/move', {
      source: source, destination: destination,
      options: { overwrite: options.overwrite, newName: options.newName, dedupeName: options.dedupeName, createMissingParents: options.createMissingParents },
    }).then(fsEntry);
  }

  function fsCopy(source, destination, options) {
    options = options || {};
    return requestWithConsent('POST', '/fs/copy', {
      source: source, destination: destination,
      options: { overwrite: options.overwrite, newName: options.newName, dedupeName: options.dedupeName, createMissingParents: options.createMissingParents },
    }).then(fsEntry);
  }

  var shareNote = 'Drive sharing is managed in the CAD app itself. Sharing files directly from hub apps is on the Phase 2 gap ledger.';
  var shareError = notYet('fs.share', shareNote);
  var sharePath = function (item) {
    if (typeof item === 'string') return item;
    return item && (item.path || item.fullPath || item.name);
  };
  var shareCall = function (method, path, body) {
    var headers = { 'X-CAD-Request': '1' };
    var init = { method: method, credentials: 'include', headers: headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(API.replace('/api/hub', '/api') + path, init).then(function (r) {
      return jsonData(r).then(function (d) { return r.ok ? d : apiFail(r, d); });
    });
  };
  var shareGet = function (path) {
    return shareCall('GET', '/share/list?path=' + encodeURIComponent(sharePath(path) || ''));
  };

  puter.fs = {
    read: readFile,
    write: writeFile,
    mkdir: mkdir,
    readdir: readdir,
    stat: stat,
    delete: fsDelete,
    rename: fsRename,
    move: fsMove,
    copy: fsCopy,
    upload: writeFile, // the easy tier only uses write(); real upload arrives with heavy apps
    space: function () { return request('GET', '/fs/space'); },
    getReadURL: function (path, expiresIn) {
      var seconds = typeof expiresIn === 'number' ? Math.min(expiresIn, 86400) : 3600;
      return request('POST', '/fs/readurl', { path: path, expiresIn: seconds }).then(function (d) { return d.url; });
    },
    sign: notYet('fs.sign', 'No easy-tier app uses file signing; tokenized read URLs are available via fs.getReadURL.'),
    share: function (path, user, options) {
      return shareCall('POST', '/share/people', { path: sharePath(path), user: user, mode: options && options.mode || 'view' });
    },
    unshare: function (path, user) {
      return shareCall('DELETE', '/share/people', { path: sharePath(path), user: user });
    },
    listShared: function (path) {
      if (!sharePath(path)) return shareCall('GET', '/share/incoming');
      return shareGet(path).then(function (d) { return d.people || []; });
    },
    listSharedByMe: function () { return shareCall('GET', '/share/mine').then(function (d) { return d.people || []; }); },
    getShares: shareGet,
    getShareLink: function (path) { return shareGet(path).then(function (d) { return d.links && d.links[0] || null; }); },
    FSItem: FSItem,
  };

  // -- kv --------------------------------------------------------------

  puter.kv = {
    // The limits the SDK publishes; apps read them.
    MAX_KEY_SIZE: 1024,
    MAX_VALUE_SIZE: 399 * 1024,

    get: function (key) {
      return request('POST', '/kv/get', { key: key }).then(function (d) {
        return d === null ? null : (d && d.items ? d.items : d);
      });
    },
    set: function (key, value) {
      if (key && typeof key === 'object' && !Array.isArray(key)) {
        value = key.value;
        key = key.key;
      }
      return request('POST', '/kv/set', { key: key, value: value }).then(function () { return null; });
    },
    del: function (key) {
      return request('POST', '/kv/del', { key: key }).then(function () { return null; });
    },
    // Same contract as js.puter.com (kv/list): positional forms
    //   list()  list(pattern)  list(true)  list(pattern, returnValues)
    //   list(options)  [and an opt-config may trail any positional form]
    // plus stream/pagination options. The pattern is a PREFIX match, not a
    // glob: a trailing '*' is accepted and stripped (both here and on the
    // server), 'abc' matches every key beginning with 'abc'.
    list: function (patternOrOptions, returnValuesOrOptConfig, maybeOptConfig, callback) {
      var isObject = function (v) {
        return !!v && typeof v === 'object' && !Array.isArray(v);
      };
      var normalizePattern = function (p) {
        if (typeof p !== 'string') return null;
        var t = p.trim();
        if (t === '') return null;
        if (t.charAt(t.length - 1) === '*') t = t.slice(0, -1);
        return t === '' ? null : t;
      };
      var options = {};
      var returnValues = false;
      var streaming = false;
      var paginated = false;
      var splitPage = function (extra) {
        var page = Object.assign({}, options, extra);
        return request('POST', '/kv/list', page).then(function (d) {
          if (d && Array.isArray(d.items)) return d;
          return { items: d || [], cursor: null };
        });
      };
      var collectAll = function () {
        // Unbound listing: page through the store, return the legacy array.
        var pageSize = 100;
        var items = [];
        var next = function () {
          return splitPage({ limit: pageSize, offset: items.length }).then(function (page) {
            items = items.concat(page.items);
            if (page.cursor) return next();
            return items;
          });
        };
        return next();
      };
      if (isObject(patternOrOptions) && returnValuesOrOptConfig === undefined && maybeOptConfig === undefined) {
        var input = patternOrOptions;
        streaming = input.stream === true;
        if (typeof input.pattern === 'string') {
          var np = normalizePattern(input.pattern);
          if (np) options.pattern = np;
        }
        returnValues = !!input.returnValues;
        ['limit', 'offset', 'cursor', 'includeTotal', 'reverse'].forEach(function (name) {
          if (input[name] !== undefined) {
            options[name] = input[name];
            paginated = true;
          }
        });
      } else {
        if (patternOrOptions === true) returnValues = true;
        else {
          var np2 = normalizePattern(patternOrOptions);
          if (np2) options.pattern = np2;
        }
        if (returnValuesOrOptConfig === true) returnValues = true;
        else if (isObject(returnValuesOrOptConfig)) options = Object.assign(options, returnValuesOrOptConfig);
        if (isObject(maybeOptConfig)) options = Object.assign(options, maybeOptConfig);
      }
      if (!returnValues) options.as = 'keys';
      else options.returnValues = true;

      if (streaming) {
        var pageLimit = options.limit || 100;
        delete options.cursor; delete options.offset; delete options.includeTotal;
        var offset = 0;
        var iterator = {
          next: async function () {
            var d = await splitPage(Object.assign({}, { limit: pageLimit, fetchUntilFull: false }, { offset: offset }));
            var items = Array.isArray(d.items) ? d.items : [];
            if (!items.length) return { done: true, value: undefined };
            offset += items.length;
            return { done: false, value: { items: items, cursor: items.length === pageLimit ? String(offset) : null } };
          },
          [Symbol.asyncIterator]: function () { return this; },
        };
        return iterator;
      }
      var value = (paginated ? splitPage({}) : collectAll()).then(function (result) {
        if (!returnValues) {
          // `as: 'keys'`: the server returns plain keys; pairs if it did not.
          return (Array.isArray(result) ? result : result.items).map(function (it) {
            return typeof it === 'string' ? it : it.key;
          });
        }
        return result;
      });
      if (typeof callback === 'function') {
        value.then(function (v) { callback(v); }, function (e) { throw e; });
        return undefined;
      }
      return value;
    },
    add: function (key, value) {
      return request('POST', '/kv/add', { key: key, value: value === undefined ? 1 : value });
    },
    incr: function (key, value) {
      return request('POST', '/kv/incr', { key: key, value: value === undefined ? 1 : value });
    },
    decr: function (key, value) {
      return request('POST', '/kv/decr', { key: key, value: value === undefined ? 1 : value });
    },
    update: function (key, pathMap) {
      return request('POST', '/kv/update', { key: key, pathMap: pathMap });
    },
    expire: function (key, ttlSeconds) {
      return request('POST', '/kv/expire', { key: key, ttlSeconds: ttlSeconds }).then(function () { return null; });
    },
    expireAt: function (key, timestamp) {
      return request('POST', '/kv/expire-at', { key: key, timestamp: timestamp }).then(function () { return null; });
    },
    flush: function () {
      return request('POST', '/kv/flush', {}).then(function () { return null; });
    },
    clear: function () {
      return request('POST', '/kv/flush', {}).then(function () { return null; });
    },
  };

  // -- ai ------------------------------------------------------------------

  // Call forms: chat(prompt [, options|testMode]) | chat(messages, ...) |
  // chat(prompt, mediaURL, [options]). Media are data or same-origin URLs
  // only; anything else the shim rejects before it leaves the page.
  function chatArgs(args) {
    var prompt = args[0];
    var media = [];
    var options = {};
    for (var i = 1; i < args.length; i++) {
      var a = args[i];
      if (a === true || a === undefined) continue;
      if (typeof a === 'string') { media.push(a); continue; }
      if (typeof a === 'object' && !Array.isArray(a)) {
        if (typeof a.url === 'string') { media.push(a.url); continue; }
        options = Object.assign(options, a);
      }
    }
    var messages = Array.isArray(prompt)
      ? prompt
      : [{ role: 'user', content: String(prompt) }];
    return {
      messages: messages,
      model: options.model,
      stream: !!options.stream,
      temperature: options.temperature,
      max_tokens: options.max_tokens !== undefined ? options.max_tokens : options.maxTokens,
      tools: options.tools,
      media: media.map(assertLocal),
    };
  }

  // NDJSON wire → documented chunk shapes, as an async iterator. The stream
  // object exposes .message once the final summary line arrives.
  function asChunkStream(body, streamRef) {
    var reader = body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    var queue = [];    // ready values
    var failures = []; // errors that next() rejects with
    var waiting = [];  // pending next() resolvers
    var finished = false;

    function deliver(value) {
      if (waiting.length) waiting.shift().resolve({ value: value, done: false });
      else queue.push(value);
    }
    function deliverError(err) {
      if (waiting.length) waiting.shift().reject(err);
      else failures.push(err);
    }
    function handleLine(line) {
      if (!line) return;
      var obj;
      try { obj = JSON.parse(line); } catch (e) { return; }
      if (obj.type === 'error') {
        var err = new Error(obj.message || 'The model failed.');
        err.code = obj.code || 'provider_error';
        deliverError(err);
        return;
      }
      if (obj.message && obj.finish_reason !== undefined) streamRef.message = obj;
      deliver(obj);
    }
    function finishTail() {
      if (buffer) { handleLine(buffer.replace(/\r$/, '')); buffer = ''; }
      finished = true;
      var w = waiting;
      waiting = [];
      w.forEach(function (waiter) {
        if (streamRef.message) {
          var m = streamRef.message;
          streamRef.message = null;
          waiter.resolve({ value: m, done: false });
        } else {
          waiter.resolve({ value: undefined, done: true });
        }
      });
    }
    function onReadError(err) {
      // A hard server stop (taskkill, LAN drop) kills the body mid-stream.
      // Apps get one designed, named error instead of the browser's raw
      // TypeError, and pending next() calls never hang (m2).
      var broke = new Error('The AI stream was interrupted: the server or the connection went away.');
      broke.code = 'ai_stream_interrupted';
      broke.cause = err;
      deliverError(broke);
      finished = true;
    }
    function step(r) {
      if (r.done) return finishTail();
      buffer += decoder.decode(r.value, { stream: true });
      var idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        var line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handleLine(line.replace(/\r$/, ''));
      }
      return reader.read().then(step, onReadError);
    }
    reader.read().then(step, onReadError);

    return {
      next: function () {
        // Bytes received before a break are still valid data: drain the queue
        // before surfacing the failure (a mid-stream kill must not swallow
        // the chunks that already arrived).
        if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
        if (failures.length) return Promise.reject(failures.shift());
        if (finished) {
          if (streamRef.message) {
            var m = streamRef.message;
            streamRef.message = null;
            return Promise.resolve({ value: m, done: false });
          }
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise(function (resolve, reject) { waiting.push({ resolve: resolve, reject: reject }); }).then(function (v) {
          if (v && v.done) return { value: undefined, done: true };
          return { value: v.value, done: false };
        });
      },
      [Symbol.asyncIterator]: function () { return this; },
    };
  }

  // -- workers (Phase 3) -----------------------------------------------------
  // Deploy a script from this app's space under this member's account and get
  // a worker answer / Response back. The server side is lib/hub-workers*.js;
  // names are unique PER MEMBER here (upstream: global) — documented.
  // §26 URL boundary: the server's internal /hub/workers shape keeps relative
  // /wr/ routes (§23), but app code must only ever SEE the canonical
  // https://<host_label>.puter.work address (about 15 upstream apps validate
  // it themselves). The transport mapper (worker-url-map.js, installed with
  // this shim) maps any fetch to that canonical host back onto the route the
  // row is served from — public /w/ routes on public pages, private /wr/
  // routes behind the session. The conversion happens ONLY here.
  function canonicalWorkerRow(d) {
    var rows = Array.isArray(d) ? d : (d != null ? [d] : []);
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r && typeof r === 'object' && typeof r.host_label === 'string' && r.host_label) {
        r.url = 'https://' + r.host_label + '.puter.work';
      }
    }
    return Array.isArray(d) ? rows : (rows[0] === undefined ? d : rows[0]);
  }
  puter.workers = {
    create: function (name, filePath) {
      // §13/§24: a deploy is a consent moment like a Drive write — the
      // person decides once, per worker, in this page. The call below only
      // happens on an explicit Allow (and never on synthetic events).
      return deployOverlay(String(name)).then(function (allowed) {
        if (!allowed) {
          // Same shape the SDK gives a real server refusal; the app's retry
          // loop reads a reason from it either way.
          return apiFail2({ code: 'deploy_denied', message: 'The worker deploy was not approved.' });
        }
        return request('POST', '/workers', { name: name, filePath: filePath }).then(function (d) {
          return canonicalWorkerRow(d);
        }, function (err) {
          // Upstream's create actually deploys; a name someone else holds is a
          // named error the apps retry around. Same shape as the SDK's.
          return apiFail2(err);
        });
      });
    },
    list: function () {
      return request('POST', '/workers/list', {}).then(function (d) {
        return canonicalWorkerRow(d || []);
      });
    },
    get: function (name) {
      return request('POST', '/workers/get', { name: name }).then(function (d) {
        return canonicalWorkerRow(d) || null;
      }, function (err) {
        if (err && err.code === 'worker_not_found') return null;
        return Promise.reject(err);
      });
    },
    delete: function (name) {
      return request('POST', '/workers/delete', { name: name }).then(function () { return null; });
    },
    // exec → a real Response: the routes return the raw worker answer body.
    // Targets: '/<owner>/<name>', 'https://<name>.puter.work[/path]', or a
    // bare name for the member's own deploy. Server-side resolution covers
    // the packaged system names (calendar-email etc., design §10).
    exec: function (target, init) {
      init = init || {};
      var body = null;
      var headers = init.headers ? Object.assign({}, init.headers) : {};
      var isBodyString = typeof init.body === 'string';
      if (init.body !== undefined && init.body !== null) {
        body = isBodyString ? init.body : JSON.stringify(init.body);
        if (!isBodyString) headers['content-type'] = headers['content-type'] || 'application/json';
      }
      var payload = { target: String(target), method: init.method || (body != null ? 'POST' : 'GET'), headers: headers, body: body };
      if (init.path != null || init.url != null) payload.path = init.path || init.url || '/invites';
      // If target is itself a /wr/... address of ours, speak to it directly:
      // same-origin fetch keeps the session cookie and the X-CAD-Request side.
      var direct = null;
      if (/^\/wr\//.test(payload.target)) direct = payload.target;
      else if (/^(https?:)?\/\/[^/]+\.puter\.work/.test(payload.target)) {
        // The one address family our server actually hosts: resolved
        // server-side by name (own deploy, system worker, or cal-<user>).
        var m2 = payload.target.match(/^(?:https?:)?\/\/([^/]+)\.puter\.work(\/.*)?$/);
        payload.target = (m2[1] || '').split('.')[0];
        payload.path = m2[2] || '/';
      }
      var p = direct
        ? fetch(direct, {
            method: payload.method, credentials: 'same-origin',
            headers: Object.assign({ 'X-CAD-Request': '1' }, headers),
            body: body === null ? undefined : body,
          })
        : request('POST', '/workers/exec', payload);
      return Promise.resolve(p);
    },
  };

  function apiFail2(err) {
    return Promise.reject(err && err.status ? err : new Error(String(err && err.message || err)));
  }

  // The models Admin → AI turned on, in the same shape CAD uses. Apps read
  // this to offer the person's real models rather than a hardcoded list.
  function aiModels() {
    return request('GET', '/ai/models').then(function (list) {
      return Array.isArray(list) ? list : [];
    });
  }

puter.ai = {
    models: aiModels,
    listModels: aiModels,
    chat: function () {
      var args = [].slice.call(arguments);
      var body = chatArgs(args);
      if (body.stream) {
        var streamRef = { message: null };
        var result = rawCall('POST', '/ai/chat', 'application/json', JSON.stringify(Object.assign({}, body, { app: APPNAME }))).then(function (r) {
          if (!r.ok) {
            return jsonData(r).then(function (d) { return apiFail(r, d); }, function () { return apiFail(r, null); });
          }
          var it = asChunkStream(r.body, streamRef);
          it.message = undefined; // set by the stream when its final line lands
          Object.defineProperty(it, 'message', { get: function () { return streamRef.message; } });
          return it;
        }).catch(function (err) {
          // The server died before the first byte: fetch itself rejects with
          // "TypeError: fetch failed". Name it, so a UI can say what happened
          // instead of printing the browser's TypeError (m2).
          if (err && !err.status && (err.name === 'TypeError' || /fetch failed|network ?error|load failed/i.test(String(err.message || '')))) {
            var broke = new Error('The AI stream was interrupted: the server or the connection went away.');
            broke.code = 'ai_stream_interrupted';
            broke.cause = err;
            throw broke;
          }
          throw err;
        });
        return result;
      }
      return request('POST', '/ai/chat', body).then(function (d) {
        return {
          message: d.message,
          finish_reason: d.finish_reason,
          stopReason: d.stopReason,
          usage: d.usage,
          toString: function () {
            var c = d.message && d.message.content;
            return typeof c === 'string' ? c : JSON.stringify(c);
          },
          valueOf: function () { return d.message && d.message.content; },
        };
      });
    },
    txt2img: notYet('ai.txt2img', "Local image generation is not enabled. Install the image engine (see README, 'engines') to enable puter.ai.txt2img."),
    img2txt: notYet('ai.img2txt', "Local OCR is not enabled. Install the tesseract engine (see README, 'engines') to enable puter.ai.img2txt."),
    txt2speech: notYet('ai.txt2speech', "Local speech synthesis is not enabled. Install the Piper engine (see README, 'engines') to enable puter.ai.txt2speech."),
    speech2txt: notYet('ai.speech2txt', "Local speech-to-text is not enabled. Install the whisper.cpp engine (see README, 'engines') to enable puter.ai.speech2txt."),
    txt2vid: notYet('ai.txt2vid', 'This server has no text-to-video provider and never calls external ones. Choose a provider in Admin → Hub (ledger).'),
  };

  // -- ui pickers + dialogs -------------------------------------------------

  var overlayEl = null;
  var shimCssAdded = false;
  function ensureCss() {
    if (shimCssAdded) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/hub/shim.css';
    document.head.appendChild(link);
    shimCssAdded = true;
  }

  // The inline overlay: no popups, no frames, no external assets.
  function pickerOverlay(options) {
    options = options || {};
    ensureCss();
    if (overlayEl) overlayEl.remove();
    overlayEl = document.createElement('div');
    overlayEl.className = 'cad-shim-backdrop';
    overlayEl.innerHTML =
      '<div class="cad-shim-dialog" role="dialog" aria-modal="true" aria-label="' + (options.title || 'Pick a file') + '">' +
      '<div class="cad-shim-head"><span class="cad-shim-title">' + (options.title || 'Pick a file') + '</span>' +
      '<div class="cad-shim-roots"><label class="cad-shim-rootlabel"><input type="radio" name="cad-shim-root" value="drive" checked> Drive</label>' +
      '<label class="cad-shim-rootlabel"><input type="radio" name="cad-shim-root" value="sandbox"> This app</label></div></div>' +
      '<div class="cad-shim-path"></div>' +
      '<div class="cad-shim-list" role="listbox"></div>' +
      '<div class="cad-shim-foot">' +
      (options.saveName !== undefined ? '<input class="cad-shim-name" type="text" value="' + (options.saveName || '').replace(/"/g, '&quot;') + '" aria-label="File name">' : '') +
      '<button type="button" class="cad-shim-cancel">Cancel</button>' +
      '<button type="button" class="cad-shim-ok primary">' + (options.okLabel || 'OK') + '</button>' +
      '</div></div>';
    document.body.appendChild(overlayEl);
    return overlayEl;
  }

  function closeOverlay() {
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
  }

  function browse(root, dirPath) {
    var q = new URLSearchParams({ root: root, dir: dirPath || '/' });
    return request('GET', '/fs/browse?' + q.toString());
  }

  /**
   * The shared picker controller: browse (Drive or app data), pick file(s)
   * or a directory, or type a save name. Resolves via done({items, dir}) on
   * OK and via done({cancelled:true}) on cancel.
   */
  function runPicker(opts) {
    return new Promise(function (skipResolve) {
      var state = { root: 'drive', dir: opts.startDir || '/', selected: [], dirPath: opts.startDir || '/' };
      var el = pickerOverlay(opts);
      var listEl = el.querySelector('.cad-shim-list');
      var pathEl = el.querySelector('.cad-shim-path');
      var okBtn = el.querySelector('.cad-shim-ok');
      var cancelBtn = el.querySelector('.cad-shim-cancel');
      var nameEl = el.querySelector('.cad-shim-name');
      var radios = el.querySelectorAll('input[name="cad-shim-root"]');

      function fin(value) {
        closeOverlay();
        skipResolve(value);
      }
      cancelBtn.addEventListener('click', function () { fin({ cancelled: true }); });
      overlayEl.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') fin({ cancelled: true });
      });

      function load(dir) {
        browse(state.root, dir).then(function (d) {
          listEl.textContent = '';
          pathEl.textContent = dir === '' || dir === '/' ? (state.root === 'drive' ? 'Drive' : 'App data') : dir;
          state.dir = dir;
          state.selected = [];
          if (dir !== '/' && dir !== '') {
            var up = document.createElement('button');
            up.type = 'button';
            up.className = 'cad-shim-row dir';
            up.textContent = '..';
            up.addEventListener('click', function () {
              var parts = dir.split('/').filter(Boolean);
              parts.pop();
              load(parts.length ? '/' + parts.join('/') : '/');
            });
            listEl.appendChild(up);
          }
          (d.entries || []).forEach(function (it) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'cad-shim-row ' + (it.is_dir ? 'dir' : 'file');
            btn.textContent = it.name + (it.is_dir ? '/' : '');
            btn.dataset.path = it.path;
            btn.dataset.dir = it.is_dir ? '1' : '';
            btn.addEventListener('click', function () {
              if (it.is_dir) {
                if (opts.mode === 'save' || opts.mode === 'open') { load(it.path); state.dir = it.path; state.dirPath = it.path; return; }
                pickOne({ item: it, isDir: true, path: it.path });
                return;
              }
              if (opts.mode === 'save') {
                if (nameEl) nameEl.value = it.name;
                state.dir = it.path.split('/').slice(0, -1).filter(Boolean).length ? '/' + it.path.split('/').slice(0, -1).filter(Boolean).join('/') : '/';
                if (!state.dir || state.dir === it.path.split('/').slice(0, -1).filter(Boolean).join('/')) state.dir = parentOf(it.path);
                state.dirPath = state.dir;
                markSelected(btn);
                return;
              }
              if (opts.multiple && it.path && !it.is_dir) {
                btn.classList.toggle('sel');
                if (state.selected.indexOf(it.path) >= 0) state.selected = state.selected.filter(function (p) { return p !== it.path; });
                else state.selected.push(it.path);
                return;
              }
              pickOne({ item: it, isDir: false, path: it.path });
            });
            if (state.selected.indexOf(it.path) >= 0) btn.classList.add('sel');
            listEl.appendChild(btn);
          });
          nameEl && (nameEl.value === '') && (nameEl.value = opts.saveName || '');
        }, function (err) {
          listEl.textContent = err.message || 'Could not list that folder.';
        });
      }
      function parentOf(p) {
        var parts = String(p).split('/').filter(Boolean);
        parts.pop();
        return parts.length ? '/' + parts.join('/') : '/';
      }
      function markSelected(btn) {
        [].forEach.call(listEl.querySelectorAll('.cad-shim-row.sel'), function (x) { x.classList.remove('sel'); });
        if (btn) btn.classList.add('sel');
      }
      function pickOne(sel) {
        state.selected = [sel];
        okBtn.textContent = opts.okLabel || 'OK';
      }

      radios.forEach(function (r) {
        r.addEventListener('change', function () {
          state.root = r.value;
          state.selected = [];
          load('/');
        });
      });

      if (nameEl) {
        nameEl.addEventListener('input', function () {
          state.saveName = nameEl.value;
        });
      }

      okBtn.addEventListener('click', function () {
        var name = nameEl ? nameEl.value.trim() : '';
        var result = { dir: state.dir, root: state.root };
        if (opts.mode === 'save') {
          if (!name) { nameEl && nameEl.focus(); return; }
          result.saveName = name;
        } else if (opts.mode === 'open') {
          result.items = state.selected;
        } else {
          result.items = state.selected;
        }
        fin(result);
      });

      load(state.dir);
    });
  }

  // Grant creation after a pick: exact file (open/save) or folder subtree.
  function grantPick(path, perms, source) {
    return request('POST', '/grants', { path: path, perms: perms, source: source }).catch(function () { /* sandbox picks need none */ });
  }

  function fsItemFrom(entry) {
    return new FSItem({
      uid: entry.uid, path: entry.path, name: entry.name, is_dir: entry.is_dir,
      size: entry.size, modified: entry.modified, created: entry.created, writable: entry.writable,
    });
  }

  // -- app-connection plumbing (see LAUNCH at the top) --------------------
  function connDispatch(list, arg) {
    var copy = (list || []).slice();
    for (var i = 0; i < copy.length; i++) {
      try { copy[i](arg); } catch (e) { console.error('[cad-hub] app-connection handler failed', e); }
    }
  }

  function makeConnection(token, frame) {
    var handlers = { message: [], close: [] };
    var conn = {
      usesSDK: true, // upstream apps refuse a connection without SDK messaging
      appInstanceID: token,
      frame: frame || null,
      postMessage: function (data) {
        if (conn.__closed) return;
        var target = frame ? frame.contentWindow : window.parent;
        if (!target) return;
        try {
          target.postMessage({ __cadConn: token, dir: frame ? 'to-child' : 'to-parent', data: data }, window.location.origin);
        } catch (e) { /* uncloneable payloads are the caller's bug */ }
      },
      on: function (evt, fn) {
        if (typeof fn === 'function' && handlers[evt]) handlers[evt].push(fn);
        return conn;
      },
      off: function (evt, fn) {
        var a = handlers[evt];
        if (a) {
          var i = a.indexOf(fn);
          if (i >= 0) a.splice(i, 1);
        }
        return conn;
      },
      close: function () {
        if (frame) {
          closeConnection(conn);
        } else if (!conn.__closed) {
          conn.__closed = true;
          sendChildClose();
        }
      },
    };
    conn.__handlers = handlers;
    conn.__token = token;
    conn.__closed = false;
    if (frame && connections) connections[token] = conn;
    return conn;
  }

  function sendChildClose() {
    try { window.parent.postMessage({ __cadConn: LAUNCH.token, dir: 'to-parent', ctrl: 'close' }, window.location.origin); } catch (e) { /* parent gone */ }
  }

  // Parent side: one registry, one listener, one hidden iframe per launch.
  var connections = null;
  function ensureConnectionListener() {
    if (connections) return;
    connections = {};
    window.addEventListener('message', function (ev) {
      if (ev.origin !== window.location.origin) return;
      var d = ev.data;
      if (!d || !d.__cadConn || d.dir !== 'to-parent') return;
      var conn = connections[d.__cadConn];
      if (!conn || conn.__closed) return;
      if (conn.frame && ev.source !== conn.frame.contentWindow) return;
      if (d.ctrl === 'close') closeConnection(conn);
      else connDispatch(conn.__handlers.message, d.data);
    });
  }
  function closeConnection(conn) {
    if (!conn || conn.__closed) return;
    conn.__closed = true;
    if (connections) delete connections[conn.__token];
    try { conn.frame && conn.frame.remove(); } catch (e) { /* already gone */ }
    connDispatch(conn.__handlers.close, undefined);
  }

  // Child side: only when this page was opened by a background launch.
  var launchedInFrame = !!(LAUNCH.token && window.parent && window.parent !== window);
  var childConn = launchedInFrame ? makeConnection(LAUNCH.token, null) : null;
  if (launchedInFrame) {
    window.addEventListener('message', function (ev) {
      if (ev.source !== window.parent || ev.origin !== window.location.origin) return;
      var d = ev.data;
      if (!d || d.__cadConn !== LAUNCH.token || d.dir !== 'to-child') return;
      if (d.ctrl === 'close') connDispatch(childConn.__handlers.close, undefined);
      else connDispatch(childConn.__handlers.message, d.data);
    });
    window.addEventListener('pagehide', function () {
      if (!childConn.__closed) sendChildClose();
    });
  }

  puter.ui = {
    showOpenFilePicker: function (options, callback) {
      options = options || {};
      var undefinedOnCancel = pendingPromise();
      var main = runPicker({ mode: 'open', title: 'Open file', multiple: !!options.multiple, startDir: normalizeStart(options.path) }).then(async function (r) {
        if (!r || r.cancelled) {
          undefinedOnCancel.resolve(undefined);
          var err = new Error('The file-open dialog was cancelled.');
          err.code = 'fileOpenCancelled';
          throw err;
        }
        var items = [];
        for (const sel of r.items) {
          await grantPick(sel.path, 'read', 'picker-open');
          var o = await request('POST', '/fs/stat', { path: sel.path });
          items.push(fsItemFrom(o));
        }
        var out = options.multiple ? items : items[0];
        if (typeof callback === 'function') callback(out);
        return out;
      });
      return main;
    },

    showSaveFilePicker: function (content, suggestedName, type) {
      var rest = [].slice.call(arguments);
      var undefinedOnCancel = pendingPromise();
      var savePickerOpts = { mode: 'save', title: 'Save file', startDir: '/', saveName: '' };
      // Forms: (content, suggestedName, type) | (content, opts? no) — apps in
      // the tier use the document form.
      if (typeof suggestedName === 'object' && suggestedName) {
        savePickerOpts.saveName = suggestedName.suggestName || '';
      } else if (typeof suggestedName === 'string') {
        savePickerOpts.saveName = suggestedName;
      }
      var main = runPicker(savePickerOpts).then(async function (r) {
        if (!r || r.cancelled) {
          undefinedOnCancel.resolve(undefined);
          return undefined;
        }
        var dirPath = r.dir === '/' || r.dir === '' ? '/' : r.dir;
        var isDrive = r.root === 'drive';
        var fullDir = isDrive ? dirPath : normalizeAppDir(dirPath);
        var full = (fullDir === '/' ? '' : fullDir) + '/' + r.saveName;
        if (isDrive) {
          await grantPick(fullDir === '/' ? '/' + r.saveName : full, 'write', 'picker-save');
        }
        var data = content;
        // save_type 'url' means "save what that URL points at" — same-origin
        // only here, fetched and written in one go.
        if (type === 'url' && typeof content === 'object' && content) {
          var url = assertLocal(content.toString());
          data = await fetch(url, { credentials: 'same-origin' }).then(function (resp) {
            if (!resp.ok) {
              var err = new Error('Could not read ' + url.slice(0, 60) + ' to save it.');
              err.code = 'bad_url';
              throw err;
            }
            return resp.arrayBuffer();
          });
        }
        var entry = await puter.fs.write(full, data, { overwrite: true });
        undefinedOnCancel.resolve(undefined);
        return fsItemFrom(entry);
      });
      // Cancelled pickers leave the main promise pending, exactly like the SDK,
      // while the undefinedOnCancel promise resolves undefined.
      return main;
    },

    showDirectoryPicker: function (options, callback) {
      options = options || {};
      var undefinedOnCancel = pendingPromise();
      var main = runPicker({ mode: 'dir', title: 'Choose folder', startDir: normalizeStart(options.path) }).then(async function (r) {
        if (!r || r.cancelled) {
          undefinedOnCancel.resolve(undefined);
          var err = new Error('The directory dialog was cancelled.');
          err.code = 'fileDirectoryOpenCancelled';
          throw err;
        }
        var picked = (r.items && r.items[0] && r.items[0].path) || (r.dir === '' ? '/' : r.dir);
        var dirPath = picked;
        await grantPick(dirPath, 'write', 'picker-dir');
        var o = dirPath === '/'
          ? null
          : await request('POST', '/fs/stat', { path: dirPath });
        var out = o ? fsItemFrom(o) : fsItemFrom({ name: '', path: '/', is_dir: true });
        if (typeof callback === 'function') callback(out);
        return out;
      });
      return main;
    },

    setWindowTitle: function (title) {
      if (arguments.length) document.title = String(title);
      return undefined;
    },
    onWindowClose: function (fn) {
      if (typeof fn !== 'function') return undefined;
      window.addEventListener('pagehide', function () {
        try { fn(); } catch (e) { /* app callbacks must not break unload */ }
      });
      return undefined;
    },
    showWindow: function () {
      console.info('[cad-hub] puter.ui.showWindow: hub apps are tab apps; there are no floating windows. (ledger)');
      return Promise.resolve(null);
    },
    hideWindow: function () {
      console.info('[cad-hub] puter.ui.hideWindow: hub apps are tab apps. (ledger)');
      return undefined;
    },
    contextMenu: function (items) {
      console.info('[cad-hub] puter.ui.contextMenu: menu registrations are stored; native menus are up to the browser. (ledger)');
      return undefined;
    },
    launchApp: function (name, options) {
      if (typeof name === 'object' && name) {
        options = name;
        name = name.name || name.app;
      }
      var app = name;
      if (!app || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(String(app))) {
        return Promise.reject(new Error('A valid hub app name is required.'));
      }
      if (options && options.background) {
        // Background launch = a hidden same-origin iframe plus a postMessage
        // channel (calendar-api and contacts-api services expect this). The
        // connection is returned in a microtask, before the child document can
        // load, so the caller's on('message') handlers cannot miss the ready
        // handshake.
        ensureConnectionListener();
        var token = '';
        try { token = window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : ''; } catch (e) { token = ''; }
        if (!token) token = 'conn-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
        var frame = document.createElement('iframe');
        frame.setAttribute('aria-hidden', 'true');
        frame.setAttribute('tabindex', '-1');
        frame.title = 'background app: ' + String(app);
        frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
        var conn = makeConnection(token, frame);
        frame.src = '/h/' + encodeURIComponent(String(app)) + '/'
          + '?cad_launch=' + encodeURIComponent(token)
          + '&cad_args=' + encodeURIComponent(JSON.stringify((options && options.args) || {}))
          + '&cad_source_app=' + encodeURIComponent(APPNAME)
          + '&puter.source_app.name=' + encodeURIComponent(APPNAME);
        (document.body || document.documentElement).appendChild(frame);
        return Promise.resolve(conn);
      }
      var url = '/h/' + encodeURIComponent(String(app)) + '/';
      if (options && options.items) url += '?open=' + encodeURIComponent(JSON.stringify(options.items));
      window.location.assign(url);
      return Promise.resolve(null);
    },
    parentApp: function () { return childConn; },
    requestPictureInPicture: function (video) {
      var el = video && video.requestPictureInPicture ? video : document.querySelector('video');
      return el && el.requestPictureInPicture ? el.requestPictureInPicture() : Promise.reject(new Error('Picture-in-picture is unavailable.'));
    },
    exitPictureInPicture: function () {
      return document.exitPictureInPicture ? document.exitPictureInPicture() : Promise.resolve(null);
    },
    onLaunchedWithItems: function (fn) {
      if (typeof fn !== 'function') return undefined;
      var raw = new URLSearchParams(window.location.search).get('open');
      if (!raw) return undefined;
      try { fn(JSON.parse(raw)); } catch { /* malformed launch payloads are ignored */ }
      return undefined;
    },
    onItemsOpened: function (fn) {
      return this.onLaunchedWithItems(fn);
    },
    alert: function (message, buttons, options) {
      ensureCss();
      return new Promise(function (resolve) {
        var el = document.createElement('div');
        el.className = 'cad-shim-backdrop';
        var first = buttons && buttons[0];
        el.innerHTML =
          '<div class="cad-shim-dialog slim" role="alertdialog" aria-modal="true">' +
          '<div class="cad-shim-head"><span class="cad-shim-title">' +
          ((options && options.title) || 'Notice') +
          '</span></div>' +
          '<div class="cad-shim-body"></div>' +
          '<div class="cad-shim-foot"><button type="button" class="cad-shim-ok primary">' +
          ((first && first.label) || 'OK') +
          '</button></div></div>';
        document.body.appendChild(overlayEl = el);
        el.querySelector('.cad-shim-body').textContent = String(message);
        el.querySelector('.cad-shim-ok').addEventListener('click', function () {
          var id = (first && (first.id || first.value)) || 'OK';
          el.remove();
          overlayEl = null;
          resolve(id);
        });
      });
    },
    openNotice: function (message, options) {
      return this.alert(message, [{ label: 'OK', value: 'OK' }], options);
    },
  };

  function normalizeStart(p) {
    if (typeof p === 'string' && p.indexOf('%appdata%') === 0) {
      return p.slice('%appdata%'.length) || '/';
    }
    return p || '/';
  }
  function normalizeAppDir(d) {
    return d || '/';
  }

  // -- everything else stays honest until its own phase ----------------------

  // Workers have a concrete phase-3 implementation above; keep only the
  // still-unimplemented namespaces behind the honest fallback proxy.
  puter.hosting = {
    create: function (subdomain, dirPath) {
      var o = typeof subdomain === 'object' && subdomain !== null ? subdomain : { subdomain: subdomain, root_dir: dirPath };
      return request('POST', '/hosting/create', { subdomain: o.subdomain, root_dir: o.root_dir || o.dirPath });
    },
    get: function (subdomain) { return request('POST', '/hosting/get', { subdomain: typeof subdomain === 'string' ? subdomain : subdomain.subdomain }); },
    list: function (options) { return request('POST', '/hosting/list', options || {}); },
    update: function (subdomain, dirPath) {
      var o = typeof subdomain === 'object' && subdomain !== null ? subdomain : { subdomain: subdomain, root_dir: dirPath };
      return request('POST', '/hosting/update', { subdomain: o.subdomain, root_dir: o.root_dir || o.dirPath });
    },
    delete: function (subdomain) { return request('POST', '/hosting/delete', { subdomain: typeof subdomain === 'string' ? subdomain : subdomain.subdomain }); },
  };
  puter.perms = {
    check: function (permission, options) {
      var o = options || {};
      return request('POST', '/perms/check', { permission: permission, app: APPNAME, options: o }).then(function (result) {
        return !!(result && result.granted);
      });
    },
    request: function (permission, options) {
      var o = options || {};
      if (permission === 'folder') {
        // A folder grant is a consent moment like any other write outside the
        // app's own folder (M8). Ask once, in this page, with the same closed
        // shadow-root dialog as a Drive write: only a trusted Allow creates the
        // revocable grant; Deny is a plain `false`.
        return puter.perms.check('folder', o).then(function (already) {
          if (already) return true;
          return consentOverlay({ path: 'Documents', need: 'write' }).then(function (allowed) {
            if (!allowed) return false;
            return request('POST', '/perms/request', { permission: permission, app: APPNAME, options: o }).then(function (result) {
              return result && result.granted ? (result.path || true) : false;
            });
          });
        });
      }
      return request('POST', '/perms/request', { permission: permission, app: APPNAME, options: o }).then(function (result) {
        return result && result.granted ? (result.path || true) : false;
      });
    },
  };
  function localSocket(host, port, tls) {
    var scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var endpoint = scheme + '//' + location.host + API + '/net?app=' + encodeURIComponent(APPNAME)
      + '&host=' + encodeURIComponent(host) + '&port=' + encodeURIComponent(port) + (tls ? '&tls=1' : '');
    var ws = new WebSocket(endpoint);
    var listeners = {};
    var closed = false;
    function emit(name, value) { (listeners[name] || []).slice().forEach(function (fn) { fn(value); }); }
    function bytes(value) {
      if (value instanceof Uint8Array) return value;
      if (value instanceof ArrayBuffer) return new Uint8Array(value);
      if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      if (typeof value === 'string') return new TextEncoder().encode(value);
      return new Uint8Array(0);
    }
    function b64(value) {
      var b = bytes(value), text = '';
      for (var i = 0; i < b.length; i += 0x8000) text += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
      return btoa(text);
    }
    ws.onopen = function () { emit('open'); };
    ws.onmessage = function (event) {
      var msg;
      try { msg = JSON.parse(event.data); } catch (e) { emit('error', e); return; }
      if (msg.type === 'data') {
        var text = atob(msg.data || ''), out = new Uint8Array(text.length);
        for (var i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
        emit('data', out);
      } else if (msg.type === 'close') emit('close', !!msg.hadError);
      else if (msg.type === 'error') { var err = new Error(msg.message || 'Socket error'); err.code = msg.code; emit('error', err); }
    };
    ws.onerror = function () { var err = new Error('Local socket connection failed.'); err.code = 'socket_error'; emit('error', err); };
    ws.onclose = function () { if (!closed) { closed = true; emit('close', false); } };
    return {
      on: function (event, fn) { (listeners[event] || (listeners[event] = [])).push(fn); return this; },
      write: function (value) { if (!closed && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'write', data: b64(value) })); },
      close: function () { if (!closed) { closed = true; try { ws.send(JSON.stringify({ type: 'close' })); } catch (e) {} ws.close(); } },
    };
  }
  puter.net = {
    fetch: function (url, options) {
      assertLocal(url);
      return window.fetch(url, options || {});
    },
    Socket: function (host, port) { return localSocket(host, port, false); },
    tls: { TLSSocket: function (host, port) { return localSocket(host, port, true); } },
  };
  // -- peer ----------------------------------------------------------------
  // The LAN signaller: invites and messages relay through this server's
  // private WebSocket; audio/video use a direct RTCPeerConnection between the
  // two browsers (negotiated over that socket). The contract follows the
  // puter-js Peer API (serve/connect, send/message, close, publish/unpublish,
  // configure, owner, connected, peerconnection, linkstate).
  function peerError(message, code) {
    var err = new Error(message);
    if (code) err.code = code;
    return err;
  }

  function eventTarget(target) {
    var listeners = Object.create(null);
    target.addEventListener = function (type, fn) {
      if (typeof fn !== 'function') return;
      (listeners[type] || (listeners[type] = [])).push(fn);
    };
    target.removeEventListener = function (type, fn) {
      var list = listeners[type];
      if (!list) return;
      var at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    };
    target.dispatchEvent = function (type, event) {
      var list = listeners[type];
      if (!list) return;
      list.slice().forEach(function (fn) {
        try { fn.call(target, event); } catch (e) {
          console.error('[cad-hub] peer ' + type + ' handler failed', e);
        }
      });
    };
    // Some apps (and older SDK snippets) use on/off instead of the DOM names.
    target.on = function (type, fn) { target.addEventListener(type, fn); return target; };
    target.off = function (type, fn) { target.removeEventListener(type, fn); return target; };
    return target;
  }

  function peerSocket(extra) {
    var scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return scheme + '//' + location.host + API + '/peer?app=' + encodeURIComponent(APPNAME) + (extra || '');
  }

  function peerParse(event) {
    try { return JSON.parse(event.data); } catch (e) { return null; }
  }

  function bytesToB64(bytes) {
    var text = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(text);
  }

  function b64ToBytes(text) {
    var raw = atob(text || '');
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function peerLinkState(conn) {
    var pc = conn.peerconnection;
    if (!pc) return;
    var state = pc.connectionState;
    var mapped = state === 'connected' ? 'connected'
      : state === 'disconnected' ? 'unstable'
        : state === 'failed' ? 'recovering' : '';
    if (!mapped) {
      var ice = pc.iceConnectionState;
      if (ice === 'connected' || ice === 'completed') mapped = 'connected';
      else if (ice === 'disconnected') mapped = 'unstable';
      else if (ice === 'failed') mapped = 'recovering';
    }
    if (!mapped || mapped === conn.linkState) return;
    conn.linkState = mapped;
    conn.dispatchEvent('linkstate', { state: mapped, attempt: mapped === 'connected' ? 0 : 1, of: 3 });
  }

  function peerPc(conn) {
    if (typeof window.RTCPeerConnection !== 'function') return null;
    var pc;
    try { pc = new window.RTCPeerConnection({ iceServers: [] }); } catch (e) { return null; }
    // The dialer owns the first offer and creates the three media slots in a
    // fixed order: 0 audio, 1 camera video, 2 screen video. The answerer does
    // not pre-create transceivers: Chrome would create a second set when the
    // offer arrives instead of associating the local ones. It adopts the
    // offer's transceivers, attaches any queued publication before it answers,
    // and renegotiates if a later publish has to change a direction.
    if (!conn._hostSide) {
      try {
        pc.addTransceiver('audio', { direction: 'sendrecv' });
        pc.addTransceiver('video', { direction: 'sendrecv' });
        pc.addTransceiver('video', { direction: 'sendrecv' });
      } catch (e) { /* older browser: the relay still carries data */ }
    }
    pc.onicecandidate = function (e) {
      if (e.candidate) conn._relay({ t: 'ice', candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate });
    };
    pc.onconnectionstatechange = function () { peerLinkState(conn); };
    pc.oniceconnectionstatechange = function () { peerLinkState(conn); };
    return pc;
  }

  function peerFlushIce(conn) {
    var pc = conn.peerconnection;
    var list = conn._pendingIce;
    conn._pendingIce = [];
    if (!pc || !list.length) return Promise.resolve();
    return Promise.all(list.map(function (candidate) {
      return pc.addIceCandidate(candidate).catch(function () { /* stale candidate */ });
    }));
  }

  function peerStartOffer(conn) {
    var pc = conn.peerconnection;
    if (!pc || conn.closed) return;
    // Force one SCTP m-line even for data-only apps: whiteboard and
    // photo-studio open their own negotiated presence channels directly on
    // the exposed peerconnection, which needs an established SCTP transport.
    try {
      if (typeof pc.createDataChannel === 'function') {
        pc.createDataChannel('__cad_peer', { negotiated: true, id: 0, ordered: true });
      }
    } catch (e) { /* data-only relays still work */ }
    pc.createOffer().then(function (offer) {
      return pc.setLocalDescription(offer);
    }).then(function () {
      conn._relay({
        t: 'sdp',
        description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
      });
    }).catch(function (err) {
      conn.dispatchEvent('error', { error: err });
    });
  }

  function peerDrainRemoteMedia(conn) {
    var pending = conn._pendingRemoteMedia || [];
    conn._pendingRemoteMedia = [];
    pending.forEach(function (message) { peerRemoteMedia(conn, message); });
  }

  function peerApplyPendingPublishes(conn) {
    var pending = conn._pendingPublishes || {};
    conn._pendingPublishes = {};
    for (var name in pending) {
      if (conn.publications.get(name) !== pending[name]) continue;
      peerAssignSlots(conn, name, pending[name]);
      peerApplyConfig(conn, name);
    }
  }

  function peerSdp(conn, description) {
    var pc = conn.peerconnection;
    if (!pc || !description) return;
    conn._sdpQueue = conn._sdpQueue.then(function () {
      return pc.setRemoteDescription(description).then(function () {
        return peerFlushIce(conn).then(function () {
          peerDrainRemoteMedia(conn);
          if (description.type !== 'offer') {
            if (conn._renegotiateAgain) {
              conn._renegotiateAgain = false;
              peerRenegotiate(conn);
            }
            return null;
          }
          // The host adopts the offer's transceivers; attach anything it
          // published before the offer so the answer itself is sendrecv.
          peerApplyPendingPublishes(conn);
          return pc.createAnswer().then(function (answer) {
            return pc.setLocalDescription(answer);
          }).then(function () {
            conn._renegotiateAgain = false;
            conn._relay({
              t: 'sdp',
              description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
            });
          });
        });
      });
    }).catch(function (err) {
      // A signalling error is real for callers, but data relay keeps going.
      conn.dispatchEvent('error', { error: err });
    });
  }

  function peerRenegotiate(conn) {
    var pc = conn.peerconnection;
    if (!pc || conn.closed) return;
    if (conn._negotiating || pc.signalingState !== 'stable') {
      conn._renegotiateAgain = true;
      return;
    }
    conn._negotiating = true;
    pc.createOffer().then(function (offer) {
      return pc.setLocalDescription(offer);
    }).then(function () {
      conn._relay({
        t: 'sdp',
        description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
      });
      conn._negotiating = false;
    }, function (err) {
      conn._negotiating = false;
      conn.dispatchEvent('error', { error: err });
    });
  }

  function peerIce(conn, candidate) {
    var pc = conn.peerconnection;
    if (!pc || !candidate) return;
    if (!pc.remoteDescription) { conn._pendingIce.push(candidate); return; }
    pc.addIceCandidate(candidate).catch(function () { /* stale candidate */ });
  }

  function peerApplyConfig(conn, name) {
    var pc = conn.peerconnection;
    var config = conn._configs[name];
    var cfg = config && config.video;
    var slots = conn._slots[name] || [];
    if (!pc || !cfg) return;
    slots.forEach(function (slot) {
      var tr = pc.getTransceivers ? pc.getTransceivers()[slot] : null;
      var sender = tr && tr.sender;
      if (!sender || !sender.track || sender.track.kind !== 'video' || !sender.getParameters) return;
      try {
        var params = sender.getParameters();
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        var encoding = {};
        for (var key in cfg) {
          if (Object.prototype.hasOwnProperty.call(cfg, key) && key !== 'degradationPreference') encoding[key] = cfg[key];
        }
        if (cfg.degradationPreference) params.degradationPreference = cfg.degradationPreference;
        Object.assign(params.encodings[0], encoding);
        var pending = sender.setParameters(params);
        if (pending && typeof pending.catch === 'function') pending.catch(function () { /* unsupported hint */ });
      } catch (e) { /* Firefox rejects some encoding hints; media still flows */ }
    });
  }

  function peerLogicalSlots(name, stream) {
    var slots = [];
    var used = [];
    var videoPool = /screen|display|share/i.test(String(name)) ? [2, 1] : [1, 2];
    var tracks = [];
    try { tracks = stream.getTracks ? stream.getTracks() : []; } catch (e) { tracks = []; }
    tracks.forEach(function (track) {
      var pool = track.kind === 'audio' ? [0] : videoPool;
      for (var i = 0; i < pool.length; i++) {
        if (used.indexOf(pool[i]) >= 0) continue;
        used.push(pool[i]);
        slots.push(pool[i]);
        break;
      }
    });
    return slots;
  }

  function peerAssignSlots(conn, name, stream) {
    var pc = conn.peerconnection;
    var slots = peerLogicalSlots(name, stream);
    conn._slots[name] = slots;
    if (!pc) return { slots: slots, changed: false };
    var tracks = [];
    try { tracks = stream.getTracks ? stream.getTracks() : []; } catch (e) { tracks = []; }
    var changed = false;
    slots.forEach(function (slot, index) {
      var track = tracks[index];
      var tr = pc.getTransceivers ? pc.getTransceivers()[slot] : null;
      if (!tr || !track) return;
      if (tr.direction === 'recvonly' || tr.direction === 'inactive') {
        try { tr.direction = 'sendrecv'; changed = true; } catch (e) { /* old browser */ }
      }
      if (tr.sender) {
        try {
          var pending = tr.sender.replaceTrack(track);
          if (pending && pending.catch) pending.catch(function () { /* kind mismatch */ });
        } catch (e2) { /* kind mismatch */ }
      }
    });
    return { slots: slots, changed: changed };
  }

  function peerPublish(conn, name, stream, options) {
    if (!name || !stream) throw new Error('publish() needs a stream name and a MediaStream.');
    conn.publications.set(name, stream);
    conn._configs[name] = conn._configs[name] || {};
    if (options && options.video) conn._configs[name].video = Object.assign({}, conn._configs[name].video || {}, options.video);
    var pc = conn.peerconnection;
    var slots = peerLogicalSlots(name, stream);
    conn._slots[name] = slots;
    if (pc && (!conn._hostSide || pc.remoteDescription)) {
      var assigned = peerAssignSlots(conn, name, stream);
      peerApplyConfig(conn, name);
      if (assigned.changed) {
        if (pc.signalingState === 'stable') peerRenegotiate(conn);
        else if (pc.signalingState !== 'have-remote-offer') conn._renegotiateAgain = true;
      }
    } else {
      conn._pendingPublishes[name] = stream;
    }
    conn._relay({ t: 'media', action: 'publish', name: name, slots: slots });
  }

  function peerUnpublish(conn, name) {
    var pc = conn.peerconnection;
    var slots = conn._slots[name] || [];
    delete conn._pendingPublishes[name];
    if (pc) {
      slots.forEach(function (slot) {
        var tr = pc.getTransceivers ? pc.getTransceivers()[slot] : null;
        if (tr && tr.sender) {
          try {
            var pending = tr.sender.replaceTrack(null);
            if (pending && pending.catch) pending.catch(function () {});
          } catch (e) { /* already gone */ }
        }
      });
    }
    delete conn._slots[name];
    delete conn._configs[name];
    conn.publications.delete(name);
    conn._relay({ t: 'media', action: 'unpublish', name: name });
  }

  function peerConfigure(conn, name, options) {
    var cfg = options && options.video;
    if (!name || !cfg) return;
    conn._configs[name] = conn._configs[name] || {};
    conn._configs[name].video = Object.assign({}, conn._configs[name].video || {}, cfg);
    peerApplyConfig(conn, name);
  }

  function peerRemoteMedia(conn, message) {
    if (message.action === 'unpublish') {
      var ended = conn.media.get(message.name);
      if (!ended) return;
      try { ended.getTracks().forEach(function (track) { ended.removeTrack(track); }); } catch (e) { /* ignore */ }
      conn.media.delete(message.name);
      conn.dispatchEvent('mediaended', { name: message.name, stream: ended });
      return;
    }
    if (message.action !== 'publish') return;
    var pc = conn.peerconnection;
    var transceivers = pc && pc.getTransceivers ? pc.getTransceivers() : [];
    if (!transceivers.length) {
      // The answerer has not applied the offer yet; its receiver tracks do
      // not exist. Replay this once they do.
      conn._pendingRemoteMedia.push(message);
      return;
    }
    var stream = conn.media.get(message.name);
    if (!stream) {
      try { stream = new MediaStream(); } catch (e) { return; }
      conn.media.set(message.name, stream);
    }
    (message.slots || []).forEach(function (slot) {
      var tr = transceivers[slot];
      var track = tr && tr.receiver && tr.receiver.track;
      if (!track) return;
      try {
        var known = stream.getTracks().some(function (t) { return t === track; });
        if (!known) stream.addTrack(track);
      } catch (e) { /* ignore */ }
      conn.dispatchEvent('media', { name: message.name, stream: stream, track: track });
    });
  }

  function peerConn(server, ws, id, owner, hostSide) {
    var conn = eventTarget({
      owner: owner || null,
      connected: false,
      closed: false,
      linkState: 'connecting',
      publications: new Map(),
      media: new Map(),
      peerconnection: null,
      send: function (data) { peerSend(conn, data); },
      close: function (reason) { peerClose(conn, reason); },
      publish: function (name, stream, options) { peerPublish(conn, name, stream, options); },
      unpublish: function (name) { peerUnpublish(conn, name); },
      configure: function (name, options) { peerConfigure(conn, name, options); },
      _server: server,
      _ws: ws,
      _id: id,
      _hostSide: !!hostSide,
      _slots: Object.create(null),
      _configs: Object.create(null),
      _pendingPublishes: Object.create(null),
      _pendingRemoteMedia: [],
      _pendingIce: [],
      _negotiating: false,
      _renegotiateAgain: false,
      _sdpQueue: Promise.resolve(),
    });
    conn.peerconnection = peerPc(conn);
    conn._relay = function (data) {
      if (conn.closed || !conn._ws || conn._ws.readyState !== WebSocket.OPEN) return;
      var envelope = conn._hostSide
        ? { type: 'relay', connId: conn._id, data: data }
        : { type: 'relay', data: data };
      try { conn._ws.send(JSON.stringify(envelope)); } catch (e) { /* closing */ }
    };
    conn._fromPeer = function (data) {
      if (!data || conn.closed) return;
      if (data.t === 'msg') {
        var payload = data.data;
        if (data.binary && typeof payload === 'string') {
          try { payload = b64ToBytes(payload).buffer; } catch (e) { payload = null; }
        }
        conn.dispatchEvent('message', { data: payload });
      } else if (data.t === 'sdp') {
        peerSdp(conn, data.description);
      } else if (data.t === 'ice') {
        peerIce(conn, data.candidate);
      } else if (data.t === 'media') {
        peerRemoteMedia(conn, data);
      }
    };
    conn._open = function () {
      if (conn.closed) return;
      conn.connected = true;
      conn.dispatchEvent('open', {});
      if (!conn._hostSide) peerStartOffer(conn);
    };
    conn._remoteClose = function (reason) {
      if (conn.closed) return;
      conn.closed = true;
      conn.connected = false;
      try { if (conn.peerconnection) conn.peerconnection.close(); } catch (e) { /* already closed */ }
      if (conn._server) conn._server.connections.delete(conn._id);
      conn.dispatchEvent('close', { reason: reason || 'The connection closed.' });
    };
    return conn;
  }

  function peerSend(conn, data) {
    if (conn.closed) throw new Error('The connection is closed.');
    if (!conn.connected) throw new Error('The connection is not open yet.');
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      data.arrayBuffer().then(function (buffer) {
        conn._relay({ t: 'msg', data: bytesToB64(new Uint8Array(buffer)), binary: true });
      }, function () { /* unreadable blob */ });
      return;
    }
    if (typeof ArrayBuffer !== 'undefined' && (data instanceof ArrayBuffer || ArrayBuffer.isView(data))) {
      var bytes = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      conn._relay({ t: 'msg', data: bytesToB64(bytes), binary: true });
      return;
    }
    conn._relay({ t: 'msg', data: data });
  }

  function peerClose(conn, reason) {
    if (conn.closed) return;
    conn.closed = true;
    conn.connected = false;
    try { if (conn.peerconnection) conn.peerconnection.close(); } catch (e) { /* already closed */ }
    if (conn._server) conn._server.connections.delete(conn._id);
    if (conn._hostSide) {
      if (conn._ws && conn._ws.readyState === WebSocket.OPEN) {
        try { conn._ws.send(JSON.stringify({ type: 'close-conn', connId: conn._id, reason: reason || 'Closed.' })); } catch (e) { /* closing */ }
      }
    } else if (conn._ws) {
      if (conn._ws.readyState === WebSocket.OPEN) {
        try { conn._ws.send(JSON.stringify({ type: 'close', reason: reason || 'Closed.' })); } catch (e) { /* closing */ }
      }
      try { conn._ws.close(); } catch (e2) { /* closing */ }
    }
  }

  function peerServer(ws) {
    var server = eventTarget({
      inviteCode: '',
      connections: new Map(),
      _closed: false,
      close: function () {
        if (server._closed) return;
        server._closed = true;
        server.connections.forEach(function (conn) {
          conn.closed = true;
          conn.connected = false;
          try { if (conn.peerconnection) conn.peerconnection.close(); } catch (e) { /* ignore */ }
        });
        server.connections.clear();
        try { ws.send(JSON.stringify({ type: 'close-server' })); } catch (e) { /* closing */ }
        try { ws.close(); } catch (e2) { /* closing */ }
        server.dispatchEvent('close', { reason: 'The server closed.' });
      },
      _socketClosed: function (reason) {
        if (server._closed) return;
        server._closed = true;
        server.connections.forEach(function (conn) { conn._remoteClose(reason || 'The invite closed.'); });
        server.connections.clear();
        server.dispatchEvent('close', { reason: reason || 'The invite closed.' });
      },
    });
    return server;
  }

  puter.peer = {
    createGuestGrant: function () {
      return request('POST', '/peer/grant', {}).then(function (data) {
        return { grant: data && data.grant, expiresAt: data && data.expiresAt };
      });
    },

    serve: function () {
      return new Promise(function (resolve, reject) {
        var ws;
        try { ws = new WebSocket(peerSocket('')); } catch (e) {
          return reject(peerError('Could not reach the signaller.', 'signaller_unreachable'));
        }
        var server = peerServer(ws);
        var settled = false;
        var timer = setTimeout(function () {
          fail(peerError('Could not reach the signaller.', 'signaller_unreachable'));
        }, 15000);
        function fail(err) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { ws.close(); } catch (e) { /* closing */ }
          reject(err);
        }
        ws.onopen = function () {
          try { ws.send(JSON.stringify({ type: 'serve' })); } catch (e) {
            fail(peerError('Could not reach the signaller.', 'signaller_unreachable'));
          }
        };
        ws.onerror = function () { if (!settled) fail(peerError('Could not reach the signaller.', 'signaller_unreachable')); };
        ws.onclose = function () {
          if (!settled) return fail(peerError('Could not reach the signaller.', 'signaller_unreachable'));
          server._socketClosed('The invite closed.');
        };
        ws.onmessage = function (event) {
          var msg = peerParse(event);
          if (!msg) return;
          if (msg.type === 'served') {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            server.inviteCode = msg.inviteCode;
            resolve(server);
          } else if (msg.type === 'connection') {
            var conn = peerConn(server, ws, msg.connId, msg.user, true);
            server.connections.set(msg.connId, conn);
            server.dispatchEvent('connection', { conn: conn, user: msg.user });
            queueMicrotask(function () { conn._open(); });
          } else if (msg.type === 'conn-closed') {
            var open = server.connections.get(msg.connId);
            if (open) {
              server.connections.delete(msg.connId);
              open._remoteClose(msg.reason);
            }
          } else if (msg.type === 'relay') {
            var target = server.connections.get(msg.connId);
            if (target) target._fromPeer(msg.data);
          } else if (msg.type === 'error') {
            if (!settled) fail(peerError(msg.message || 'The signaller refused the invite.', msg.code));
          }
        };
      });
    },

    connect: function (code, options) {
      return new Promise(function (resolve, reject) {
        if (!code || typeof code !== 'string') {
          return reject(peerError('An invite code is required.', 'invalid_invite'));
        }
        var extra = '';
        if (options && options.turnGrant) extra += '&grant=' + encodeURIComponent(options.turnGrant);
        var ws;
        try { ws = new WebSocket(peerSocket(extra)); } catch (e) {
          return reject(peerError('Could not reach the signaller.', 'signaller_unreachable'));
        }
        var conn = null;
        var settled = false;
        var timer = setTimeout(function () {
          fail(peerError('Could not reach the signaller.', 'signaller_unreachable'));
        }, 15000);
        function fail(err) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { ws.close(); } catch (e) { /* closing */ }
          reject(err);
        }
        ws.onopen = function () {
          try {
            ws.send(JSON.stringify({
              type: 'join',
              code: code,
              anonToken: (options && options.anonToken) || undefined,
            }));
          } catch (e) {
            fail(peerError('Could not reach the signaller.', 'signaller_unreachable'));
          }
        };
        ws.onerror = function () { if (!settled) fail(peerError('Could not reach the signaller.', 'signaller_unreachable')); };
        ws.onclose = function () {
          if (!settled) return fail(peerError('Could not reach the signaller.', 'signaller_unreachable'));
          if (conn) conn._remoteClose('The connection was lost.');
        };
        ws.onmessage = function (event) {
          var msg = peerParse(event);
          if (!msg) return;
          if (msg.type === 'joined') {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            conn = peerConn(null, ws, msg.connId, msg.host, false);
            resolve(conn);
            queueMicrotask(function () { conn._open(); });
          } else if (msg.type === 'join-error') {
            fail(peerError(msg.message || 'Invalid invite code.', msg.code || 'invalid_invite'));
          } else if (msg.type === 'conn-closed' && conn) {
            conn._remoteClose(msg.reason);
          } else if (msg.type === 'relay' && conn) {
            conn._fromPeer(msg.data);
          } else if (msg.type === 'error' && !settled) {
            fail(peerError(msg.message || 'The signaller refused the connection.', msg.code));
          }
        };
      });
    },
  };

  // -- events (onLocal) ----------------------------------------------------
  // Realtime change delivery for one person's own data. The socket is opened
  // lazily on the first subscription and reconnects with backoff; changes
  // that happened while it was down arrive as a `gap` event so the app knows
  // to re-read rather than assume it saw everything.
  var eventBus = {
    ws: null,
    ready: false,
    subs: Object.create(null),
    seq: 0,
    retry: 0,
    failures: 0,
    timer: null,
  };

  function eventsSocketUrl() {
    var scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return scheme + '//' + location.host + API + '/events?app=' + encodeURIComponent(APPNAME);
  }

  function eventsLiveCount() {
    var n = 0;
    for (var id in eventBus.subs) if (!eventBus.subs[id].dead) n++;
    return n;
  }

  function eventsSend(frame) {
    if (!eventBus.ws || eventBus.ws.readyState !== WebSocket.OPEN) return false;
    try { eventBus.ws.send(JSON.stringify(frame)); return true; } catch (e) { return false; }
  }

  function eventsResubscribe() {
    for (var id in eventBus.subs) {
      var sub = eventBus.subs[id];
      if (sub.dead) continue;
      if (eventsSend({ type: 'sub', id: sub.requestId, subject: sub.subject, includeValue: sub.includeValue })) {
        sub.resubscribed = sub.everReady;
      }
    }
  }

  function eventsRetry() {
    if (eventBus.timer || eventsLiveCount() === 0) return;
    var delay = Math.min(30000, 1000 * Math.pow(2, Math.min(eventBus.retry++, 5)));
    eventBus.timer = setTimeout(function () {
      eventBus.timer = null;
      eventsEnsure();
    }, delay);
  }

  function eventsDeliver(sub, event) {
    if (!sub || sub.dead) return;
    try {
      sub.handler({ event: event });
    } catch (e) {
      console.error('[cad-hub] events handler failed', e);
    }
  }

  /** Give up on the transport: every standing subscription is told once. */
  function eventsFailAll(message) {
    for (var id in eventBus.subs) {
      var sub = eventBus.subs[id];
      if (sub.dead) continue;
      sub.dead = true;
      if (sub.timer) clearTimeout(sub.timer);
      delete eventBus.subs[id];
      var err = peerError(message, 'events_unavailable');
      if (sub.ready) {
        if (sub.options && typeof sub.options.onError === 'function') {
          try { sub.options.onError(err); } catch (e) { /* caller's error */ }
        }
      } else {
        sub.reject(err);
      }
    }
  }

  function eventsHandle(sub) {
    return {
      subId: sub.serverId,
      subject: sub.subject,
      anchor: sub.anchor,
      match: sub.match,
      op: sub.op,
      includeValue: sub.includeValue,
      off: function () {
        if (sub.dead) return Promise.resolve();
        sub.dead = true;
        delete eventBus.subs[sub.requestId];
        if (sub.serverId) eventsSend({ type: 'unsub', subId: sub.serverId });
        return Promise.resolve();
      },
    };
  }

  function eventsEnsure() {
    if (eventBus.ws && (eventBus.ws.readyState === WebSocket.CONNECTING || eventBus.ws.readyState === WebSocket.OPEN)) return;
    if (typeof WebSocket !== 'function') return eventsRetry();
    var ws;
    try { ws = new WebSocket(eventsSocketUrl()); } catch (e) { return eventsRetry(); }
    eventBus.ws = ws;
    eventBus.ready = false;
    ws.onopen = function () {
      if (eventBus.ws !== ws) return;
      eventBus.ready = true;
      eventBus.retry = 0;
      eventBus.failures = 0;
      eventsResubscribe();
    };
    ws.onmessage = function (event) {
      var msg = peerParse(event);
      if (!msg) return;
      if (msg.type === 'sub-ok') {
        var sub = eventBus.subs[msg.id];
        if (!sub || sub.dead) return;
        sub.serverId = msg.subId;
        sub.anchor = msg.anchor;
        sub.match = msg.match;
        sub.op = msg.op;
        if (!sub.ready) {
          sub.ready = true;
          sub.everReady = true;
          if (sub.timer) { clearTimeout(sub.timer); sub.timer = null; }
          sub.resolve(eventsHandle(sub));
        } else if (sub.resubscribed) {
          sub.resubscribed = false;
          eventsDeliver(sub, { op: 'gap', subject: sub.subject, reason: 'reconnect' });
        }
        return;
      }
      if (msg.type === 'sub-error') {
        var failed = eventBus.subs[msg.id];
        if (!failed || failed.dead) return;
        var err = peerError(msg.message || 'That event subject is not supported.', msg.code || 'subject_does_not_exist');
        if (!failed.ready) {
          failed.dead = true;
          if (failed.timer) clearTimeout(failed.timer);
          delete eventBus.subs[msg.id];
          failed.reject(err);
        } else {
          failed.dead = true;
          delete eventBus.subs[msg.id];
          if (failed.options && typeof failed.options.onError === 'function') {
            try { failed.options.onError(err); } catch (e) { /* caller's error */ }
          }
        }
        return;
      }
      if (msg.type === 'event') {
        var target = eventBus.subs[msg.id];
        if (target && !target.dead) eventsDeliver(target, msg.event || {});
      }
    };
    ws.onerror = function () { /* onclose does the retrying */ };
    ws.onclose = function () {
      if (eventBus.ws !== ws) return;
      eventBus.ws = null;
      eventBus.ready = false;
      if (eventsLiveCount() === 0) return;
      // A dropped link is not the end of the subscription: the socket is
      // remade and the subscription re-made on it. Only after several failed
      // attempts is the caller told, so it can fall back to polling.
      eventBus.failures += 1;
      if (eventBus.failures > 5) {
        eventsFailAll('Could not reconnect to the event service.');
        return;
      }
      eventsRetry();
    };
  }

  function onLocal(subject, handler, options) {
    return new Promise(function (resolve, reject) {
      if (typeof subject !== 'string' || !subject.trim() || subject.length > 2048) {
        return reject(peerError('onLocal() needs an event subject.', 'invalid_subject'));
      }
      if (typeof handler !== 'function') {
        return reject(peerError('onLocal() needs a handler function.', 'invalid_handler'));
      }
      if (!APPNAME) return reject(peerError('Events need a hub app name.', 'not_an_app'));
      var o = options || {};
      var requestId = 's' + ++eventBus.seq + '-' + Date.now().toString(36);
      var sub = {
        requestId: requestId,
        subject: subject.trim(),
        handler: handler,
        options: o,
        includeValue: !!o.includeValue,
        ready: false,
        everReady: false,
        resubscribed: false,
        dead: false,
        serverId: '',
        anchor: 0,
        match: 'exact',
        op: 'set|del|expire|gap',
        resolve: resolve,
        reject: reject,
        timer: null,
      };
      eventBus.subs[requestId] = sub;
      var wait = Number(o.timeout);
      var limit = Number.isFinite(wait) && wait > 0 ? Math.min(wait, 120000) : 15000;
      sub.timer = setTimeout(function () {
        if (sub.ready || sub.dead) return;
        sub.dead = true;
        delete eventBus.subs[requestId];
        reject(peerError('The event subscription timed out.', 'events_timeout'));
      }, limit);
      eventsEnsure();
      if (eventBus.ready && !eventsSend({ type: 'sub', id: requestId, subject: sub.subject, includeValue: sub.includeValue })) {
        sub.dead = true;
        delete eventBus.subs[requestId];
        if (sub.timer) clearTimeout(sub.timer);
        reject(peerError('Could not reach the event service.', 'events_unavailable'));
      }
    });
  }

  puter.events = {
    onLocal: onLocal,
  };

  puter.email = {
    send: function (message) {
      return request('POST', '/email/send', { message: message, app: APPNAME });
    },
    sendTransactional: function (message) {
      return request('POST', '/email/send-transactional', { message: message, app: APPNAME });
    },
    list: function (options) {
      return request('POST', '/email/list', { options: options || {}, app: APPNAME });
    },
  };
  ['maps'].forEach(function (area) {
    puter[area] = new Proxy({}, {
      get: function (target, prop) {
        if (prop === 'then') return undefined; // remain a non-thenable for await checks
        if (typeof prop !== 'string') return undefined;
        return notYet(area + '.' + prop);
      },
    });
  });

  // The generic easy-tier gate sets this flag before the shim loads. It
  // records results without changing the application's value or arguments.
  if (window.__CAD_FUNCTIONAL_GATE__ === true && typeof Proxy === 'function') {
    var callLog = window.__CAD_PUTER_CALLS__ = [];
    var wrapped = new WeakMap();
    function instrument(value, path) {
      if (!value || (typeof value !== 'object' && typeof value !== 'function')) return value;
      if (wrapped.has(value)) return wrapped.get(value);
      var proxy = new Proxy(value, {
        get: function (target, key, receiver) {
          var childPath = path + '.' + String(key);
          var child = Reflect.get(target, key, receiver);
          if (typeof child === 'function') {
            return function () {
              var entry = { method: childPath, status: 'pending' };
              callLog.push(entry);
              var result;
              try { result = Reflect.apply(child, receiver, arguments); }
              catch (err) { entry.status = 'rejected'; entry.code = err && err.code || null; entry.message = String(err && err.message || err); throw err; }
              if (result && typeof result.then === 'function') {
                return result.then(function (resolved) { entry.status = 'resolved'; entry.resultType = resolved === null ? 'null' : typeof resolved; return resolved; }, function (err) {
                  entry.status = 'rejected'; entry.code = err && err.code || null; entry.message = String(err && err.message || err); throw err;
                });
              }
              entry.status = 'resolved'; entry.resultType = result === null ? 'null' : typeof result;
              return result;
            };
          }
          return instrument(child, childPath);
        },
      });
      wrapped.set(value, proxy);
      return proxy;
    }
    window.puter = instrument(puter, 'puter');
    puter = window.puter;
  }

  console.info('CAD Home: the local Puter shim is active (phase 2: fs, kv, ai.chat, file pickers).');
})();
