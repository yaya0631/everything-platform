/**
 * The app launcher: a trusted CAD Home page that signs the person in, asks the
 * server for a scoped bearer token, and passes it to the sandboxed app iframe
 * (opaque origin, so it shares nothing with CAD Home) — only after the app
 * says "ready", and only to messages that really came from this iframe.
 * It also shows the file pickers and permission dialogs the SDK asks for.
 */
(() => {
  'use strict';

  const match = /\/(apps|p)\/([^/?#]+)/.exec(location.pathname);
  if (!match) {
    document.title = 'Not an app page';
    document.getElementById('gateMsg').textContent = 'This page hosts CAD Home apps. Use /apps/<name>/ on this server.';
    return;
  }
  /** "private" for /apps/<name>/, "public" for /p/<name>/ over the public link. */
  const kind = match[1] === 'p' ? 'public' : 'private';
  const app = match[2];
  const frame = document.getElementById('iframe');
  const gateMsg = document.getElementById('gateMsg');
  document.getElementById('appLabel').textContent = `· ${app}`;

  let token = null;
  let readySeen = false;

  const respond = (msg) => frame.contentWindow?.postMessage(msg, '*');

  const pushToken = () => {
    if (readySeen && token) respond({ type: 'token', token });
  };

  const api = async (method, route, { json } = {}) => {
    const h = { 'X-CAD-Request': '1' };
    if (json !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(route, { method, headers: h, credentials: 'same-origin', body: json !== undefined ? JSON.stringify(json) : undefined });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json().catch(() => ({})) : await res.text();
    if (!res.ok) {
      const err = new Error((data && data.message) || `The server answered ${res.status}.`);
      err.status = res.status;
      err.code = data?.code || `http_${res.status}`;
      throw err;
    }
    return data;
  };

  // Token --------------------------------------------------------------------------------------

  const refreshToken = async () => {
    if (kind === 'public') {
      const r = await fetch(`/p/${app}/token`, { method: 'POST' });
      return r.ok ? (await r.json()).token : null;
    }
    const me = await fetch('/api/auth/me', { headers: { 'X-CAD-Request': '1' }, credentials: 'same-origin' });
    if (!me.ok) return null;
    return (await api('POST', `/api/apps/${app}/token`)).token;
  };

  // Sign-in form ---------------------------------------------------------------------------------

  function showSignIn() {
    gateMsg.textContent = 'Sign in with your CAD Home account to open this app.';
    const user = document.createElement('input');
    user.placeholder = 'Username';
    user.autocapitalize = 'none';
    user.autocomplete = 'username';
    const pass = document.createElement('input');
    pass.type = 'password';
    pass.placeholder = 'Password';
    pass.autocomplete = 'current-password';
    const err = document.createElement('p');
    err.className = 'err';
    const go = document.createElement('button');
    go.textContent = 'Sign in';
    const form = document.createElement('form');
    form.append(user, pass, go, err);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      go.disabled = true;
      try {
        await api('POST', '/api/auth/login', { json: { username: user.value.trim(), password: pass.value } });
        await boot();
      } catch (ex) {
        err.textContent = ex.message || 'That username and password do not match.';
        pass.value = '';
      } finally {
        go.disabled = false;
      }
    });
    const gate = document.getElementById('gate');
    gate.querySelectorAll('form').forEach((f) => f.remove());
    gate.append(form);
    user.focus();
  }

  // Picker dialog ---------------------------------------------------------------------------------

  const pickDlg = document.getElementById('pickDlg');
  const pickTitle = document.getElementById('pickTitle');
  const pickHint = document.getElementById('pickHint');
  const pickList = document.getElementById('pickList');
  const crumb = document.getElementById('crumb');
  const allowBtn = document.getElementById('pickAllow');
  const cancelBtn = document.getElementById('pickCancel');
  const askDlg = document.getElementById('askDlg');

  let current = null; // { id, save, mode, multiple, folder, picked:Set<path>, name }

  const human = (p) => p.split('/').filter(Boolean).join(' / ') || 'My files';

  function renderCrumb(path) {
    crumb.textContent = '';
    const root = document.createElement('button');
    root.type = 'button';
    root.textContent = 'My files';
    root.addEventListener('click', () => openFolder('/'));
    crumb.append(root);
    const parts = path.split('/').filter(Boolean);
    let soFar = '';
    for (const p of parts) {
      soFar += `/${p}`;
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = p;
      const target = soFar;
      b.addEventListener('click', () => openFolder(target));
      crumb.append(b);
    }
  }

  async function openFolder(path) {
    if (!current) return;
    current.folder = path;
    if (current.save && path === '/') {
      allowBtn.disabled = true;
      allowBtn.textContent = 'Choose a folder';
    } else {
      allowBtn.disabled = false;
      allowBtn.textContent = 'Allow access';
    }
    try {
      const r = await fetch(`/api/fs/readdir?path=${encodeURIComponent(path)}`, { headers: { 'X-CAD-Request': '1' }, credentials: 'same-origin' });
      if (!r.ok) throw new Error('That folder could not be opened.');
      const items = (await r.json()).items || [];
      renderCrumb(path);
      pickList.textContent = '';
      if (!items.length) pickList.append(Object.assign(document.createElement('p'), { style: 'opacity:.6;padding:8px', textContent: 'This folder is empty.' }));
      for (const it of items) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'row';
        row.title = it.path;
        row.textContent = `${it.is_dir ? '\u{1f4c1}' : '\u{1f5ce}'} ${it.name}`;
        row.addEventListener('click', () => {
          if (it.is_dir) return openFolder(it.path);
          if (current.save) return;
          if (current.picked.has(it.path)) current.picked.delete(it.path);
          else {
            if (!current.multiple) current.picked.clear();
            current.picked.add(it.path);
          }
          for (const r2 of pickList.querySelectorAll('.row')) r2.classList.remove('picked');
          for (const p of current.picked) for (const r2 of pickList.querySelectorAll('.row')) if (r2.title === p) r2.classList.add('picked');
        });
        pickList.append(row);
      }
    } catch (ex) {
      pickList.textContent = '';
      pickList.append(Object.assign(document.createElement('p'), { style: 'padding:8px;color:#b3261e', textContent: ex.message }));
    }
  }

  function showSaveName() {
    if (!current.save) return;
    const el = document.createElement('input');
    el.id = 'saveName';
    el.value = current.name;
    el.addEventListener('input', () => (current.name = el.value));
    pickHint.after(el);
  }

  function hiddenSaveName() {
    document.getElementById('saveName')?.remove();
  }

  function openPicker(msg) {
    if (pickDlg.open) return respond({ type: 'pickerResult', id: msg.id, error: 'cancelled' });
    current = {
      id: msg.id,
      save: msg.type === 'showSaveFilePicker',
      mode: msg.type === 'showSaveFilePicker' ? 'edit' : msg.mode === 'edit' ? 'edit' : 'read',
      multiple: !!msg.multiple,
      folder: '/',
      picked: new Set(),
      name: typeof msg.suggestedName === 'string' ? msg.suggestedName.replace(/[\\/:*?"<>|]/g, '-').slice(0, 100) : 'file',
    };
    pickTitle.textContent = current.save ? 'Choose where to save' : 'Give the app file access';
    pickHint.textContent = `${app} will be able to ${current.mode === 'edit' ? 'read and change' : 'read'} what you allow. Access lasts until you remove it in Account → Connected apps.`;
    showSaveName();
    pickDlg.showModal();
    openFolder('/');
  }

  allowBtn.addEventListener('click', async () => {
    if (!current) return;
    allowBtn.disabled = true;
    try {
      if (current.save) {
        // The chosen folder is granted as a whole; the app writes its file inside it.
        const g = await api('POST', `/api/apps/${app}/grants`, { json: { paths: [current.folder], mode: 'edit' } });
        const name = current.name.replace(/[\\/:*?"<>|]/g, '-').slice(0, 100) || 'file';
        const item = g.items[0];
        respond({ type: 'pickerResult', id: current.id, items: [{ name, path: `${item.path}/${name}` }] });
      } else {
        if (!current.picked.size) return;
        const g = await api('POST', `/api/apps/${app}/grants`, { json: { paths: [...current.picked], mode: current.mode } });
        respond({ type: 'pickerResult', id: current.id, items: g.items });
      }
      hiddenSaveName();
      pickDlg.close();
    } catch (ex) {
      pickHint.textContent = ex.message;
    } finally {
      allowBtn.disabled = false;
      if (allowBtn.isConnected && current && current.save && current.folder === '/') allowBtn.disabled = true;
    }
  });

  cancelBtn.addEventListener('click', () => {
    hiddenSaveName();
    pickDlg.close();
    if (current) respond({ type: 'pickerResult', id: current.id, error: 'cancelled' });
  });

  function askPermission(title, text) {
    return new Promise((resolve) => {
      document.getElementById('askTitle').textContent = title;
      document.getElementById('askText').textContent = text;
      const yes = document.getElementById('askYes');
      const no = document.getElementById('askNo');
      askDlg.showModal();
      const done = (v) => {
        yes.removeEventListener('click', yesFn);
        no.removeEventListener('click', noFn);
        askDlg.removeEventListener('cancel', cancelFn);
        askDlg.close();
        resolve(v);
      };
      const yesFn = () => done(true);
      const noFn = () => done(false);
      const cancelFn = () => done(false);
      yes.addEventListener('click', yesFn);
      no.addEventListener('click', noFn);
      askDlg.addEventListener('cancel', cancelFn);
    });
  }

  // Messages from the app -------------------------------------------------------------------------

  window.addEventListener('message', async (e) => {
    // Only this iframe is the app. Anything else is ignored, token included.
    if (e.source !== frame.contentWindow) return;
    const m = e.data || {};
    if (m.type === 'ready') {
      readySeen = true;
      pushToken();
    } else if (m.type === 'refreshToken') {
      try {
        if (!token) token = await refreshToken();
        if (token) pushToken();
        else respond({ type: 'needSignIn' });
      } catch {
        respond({ type: 'needSignIn' });
      }
    } else if (m.type === 'showOpenFilePicker' || m.type === 'showSaveFilePicker') {
      openPicker(m);
    } else if (m.type === 'emailPermission') {
      const allowed = await askPermission(`${m.title || app} wants to send email`, `Allow ${m.title || app} to send email as CAD Home? You can remove this at any time in Account → Connected apps.`);
      if (allowed) {
        try {
          await api('POST', `/api/apps/${app}/email-permission`, { json: {} });
          token = await refreshToken();
        } catch {
          /* the dialog result still tells the app */
        }
      }
      respond({ type: 'emailPermissionResult', id: m.id, allowed });
      if (token) pushToken();
    }
  });

  // Boot -------------------------------------------------------------------------------------------

  async function boot() {
    gateMsg.textContent = 'Loading…';
    gateMsg.setAttribute('aria-live', 'polite');
    try {
      token = await refreshToken();
    } catch (ex) {
      gateMsg.textContent = ex.message;
      gateMsg.removeAttribute('aria-live');
      return;
    }
    if (!token) return showSignIn();
    gateMsg.textContent = 'Loading…';
    frame.src = `/app-content/${app}/`;
    // The frame announces itself; open the app area as soon as it loads.
    frame.addEventListener('load', () => document.body.classList.add('open'), { once: true });
  }

  if (kind === 'public') {
    frame.src = `/p-content/${app}/`;
    frame.addEventListener('load', () => document.body.classList.add('open'), { once: true });
    refreshToken()
      .then((t) => {
        token = t;
        pushToken();
      })
      .catch(() => {});
  } else {
    boot();
  }
})();
