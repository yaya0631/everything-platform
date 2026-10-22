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

  function call(method, path, body) {
    var headers = { 'X-CAD-Request': '1' };
    var init = { method: method, credentials: 'same-origin', headers: headers };
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
    return fetch(API + withApp(path), { method: method, credentials: 'same-origin', headers: headers, body: body });
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
      var mapped = typeof input === 'string' ? mapHostedUrl(input)
        : (input && input.url ? mapHostedUrl(input.url) : input);
      if (typeof input !== 'string' && mapped !== input && typeof Request !== 'undefined') mapped = new Request(mapped, input);
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
    share: shareError,
    unshare: shareError,
    listShared: shareError,
    listSharedByMe: shareError,
    getShares: shareError,
    getShareLink: shareError,
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
      if (waiting.length) waiting.shift()({ value: value, done: false });
      else queue.push(value);
    }
    function deliverError(err) {
      if (waiting.length) waiting.shift()(err);
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
      w.forEach(function (res) {
        if (streamRef.message) {
          var m = streamRef.message;
          streamRef.message = null;
          res({ value: m, done: false });
        } else {
          res({ value: undefined, done: true });
        }
      });
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
      return reader.read().then(step);
    }
    reader.read().then(step, function (err) {
      deliverError(Object.assign(new Error('The stream broke.'), { cause: err }));
      finished = true;
    });

    return {
      next: function () {
        if (failures.length) return Promise.reject(failures.shift());
        if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
        if (finished) {
          if (streamRef.message) {
            var m = streamRef.message;
            streamRef.message = null;
            return Promise.resolve({ value: m, done: false });
          }
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise(function (res) { waiting.push(res); }).then(function (v) {
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

puter.ai = {
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
    launchApp: notYet('ui.launchApp', 'Hub apps open each other by link in this server; app launching stays in the hub home page.'),
    parentApp: notYet('ui.parentApp', 'Hub apps do not run inside another app.'),
    onLaunchedWithItems: function (fn) {
      // Nothing launches a hub app with files today; a real "open with"
      // launcher is a later phase (ledger). The callback simply never fires.
      console.info('[cad-hub] puter.ui.onLaunchedWithItems: no launcher yet; the callback stays idle. (ledger)');
      return undefined;
    },
    onItemsOpened: function (fn) {
      console.info('[cad-hub] puter.ui.onItemsOpened: no launcher yet; the callback stays idle. (ledger)');
      return undefined;
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
  ['net', 'email', 'perms'].forEach(function (area) {
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
