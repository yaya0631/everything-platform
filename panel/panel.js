/**
 * CAD Home panel: /account/ for everyone, /admin/ for admins (and for people
 * who host apps, limited to their own apps). Hash routes: #/people, #/ai …
 */
import { h, clear, icon, api, ApiError, field, input, button, toast, action, notice } from './ui.js';
import * as account from './pages-account.js';
import * as admin from './pages-admin.js';
import * as ai from './pages-ai.js';
import * as apps from './pages-apps.js';
import * as hub from './pages-hub.js';

const root = document.getElementById('panel');
const isAdminArea = location.pathname.startsWith('/admin');

export const state = { me: null };

// Theme: the same choice as the CAD app (same origin, so the same localStorage).
function applyTheme(pref) {
  const p = pref || localStorage.getItem('cad.theme') || 'system';
  if (p === 'light' || p === 'dark') document.documentElement.dataset.theme = p;
  else delete document.documentElement.dataset.theme;
}
applyTheme();

const ADMIN_PAGES = [
  { id: 'overview', label: 'Overview', icon: 'gauge', render: admin.overview },
  { id: 'people', label: 'People', icon: 'users', render: admin.people },
  { id: 'sharing', label: 'Sharing', icon: 'share', render: admin.sharing },
  { id: 'ai', label: 'AI', icon: 'sparkles', render: ai.page },
  { id: 'email', label: 'Email', icon: 'mail', render: admin.email },
  { id: 'apps', label: 'Apps', icon: 'apps', render: apps.page, hosts: true },
  { id: 'hub', label: 'Hub', icon: 'globe', render: hub.page },
  { id: 'server', label: 'Server', icon: 'server', render: admin.server },
  { id: 'audit', label: 'Audit log', icon: 'history', render: admin.audit },
];

const ACCOUNT_PAGES = [
  { id: 'profile', label: 'Profile', icon: 'user', render: account.profile },
  { id: 'password', label: 'Password', icon: 'key', render: account.password },
  { id: 'devices', label: 'Devices', icon: 'monitor', render: account.devices },
  { id: 'sharing', label: 'My shares', icon: 'share', render: account.sharing },
  { id: 'apps', label: 'Connected apps', icon: 'plug', render: account.connectedApps },
  { id: 'hubdata', label: 'Hub app data', icon: 'globe', render: account.hubApps },
];

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { page: parts[0] || '', args: parts.slice(1) };
}

// Sign-in and one-off flows ---------------------------------------------------------------

function authShell(title, body) {
  root.className = 'panel-root bare';
  root.removeAttribute('aria-busy');
  clear(root).append(
    h('div.auth', h('section.card.auth-card', h('div.card-body', h('div.auth-brand', h('span.brand-mark', icon('pencil', 14)), 'CAD Home'), h('h1.card-title.auth-title', title), body))),
  );
  root.querySelector('input')?.focus();
}

function signInPage(message) {
  const user = input({ name: 'username', autocomplete: 'username', autocapitalize: 'none' });
  const pass = input({ type: 'password', name: 'password', autocomplete: 'current-password' });
  const err = h('p.field-error', { role: 'alert' }, message || '');
  const submit = button('Sign in', { kind: 'primary', type: 'submit' });
  const form = h(
    'form',
    {
      onSubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        if (!user.value.trim() || !pass.value) return (err.textContent = 'Enter your username and password.');
        submit.disabled = true;
        try {
          await api('POST', 'auth/login', { username: user.value.trim(), password: pass.value });
          await boot();
        } catch (e2) {
          err.textContent = e2.message;
          pass.select();
        } finally {
          submit.disabled = false;
        }
      },
    },
    h('p.dialog-text.auth-lead', 'Sign in with your CAD Home account.'),
    field('Username', user),
    field('Password', pass),
    err,
    h('div.form-actions', h('button.link-btn', { type: 'button', onClick: () => (location.hash = '#/forgot') }, 'Forgot password?'), h('span.grow'), submit),
  );
  authShell('Sign in', form);
}

function forgotPage() {
  const user = input({ autocomplete: 'username', autocapitalize: 'none' });
  const msg = h('div');
  const send = button('Send reset link', { kind: 'primary', type: 'submit' });
  authShell(
    'Reset your password',
    h(
      'form',
      {
        onSubmit: async (e) => {
          e.preventDefault();
          if (!user.value.trim()) return;
          send.disabled = true;
          try {
            const r = await api('POST', 'auth/forgot', { username: user.value.trim() });
            clear(msg).append(
              r.emailConfigured
                ? notice('success', 'If that account has an email address, a reset link is on its way. It works for 1 hour.')
                : notice('warning', 'This server cannot send email yet. Ask the person who runs it to reset your password.'),
            );
          } catch (err) {
            clear(msg).append(notice('error', err.message));
          } finally {
            send.disabled = false;
          }
        },
      },
      field('Username', user),
      msg,
      h('div.form-actions', h('button.link-btn', { type: 'button', onClick: () => (location.hash = '') }, 'Back to sign in'), h('span.grow'), send),
    ),
  );
}

async function passwordTokenPage(kind, token) {
  let info;
  try {
    info = await api('GET', `auth/token-info?kind=${kind}&token=${encodeURIComponent(token)}`);
  } catch (err) {
    return authShell(kind === 'invite' ? 'Invitation' : 'Reset your password', h('div.stack', notice('error', err.message), h('div.form-actions', button('Go to sign in', { onClick: () => (location.hash = '') }))));
  }
  const a = input({ type: 'password', autocomplete: 'new-password' });
  const b = input({ type: 'password', autocomplete: 'new-password' });
  const err = h('p.field-error', { role: 'alert' });
  const save = button(kind === 'invite' ? 'Create account' : 'Set password', { kind: 'primary', type: 'submit' });
  authShell(
    kind === 'invite' ? `Welcome, ${info.displayName}` : 'Choose a new password',
    h(
      'form',
      {
        onSubmit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          if (a.value.length < 8) return (err.textContent = 'Passwords need at least 8 characters.');
          if (a.value !== b.value) return (err.textContent = 'The passwords do not match.');
          save.disabled = true;
          try {
            await api('POST', kind === 'invite' ? 'auth/accept-invite' : 'auth/reset', { token, password: a.value });
            toast(kind === 'invite' ? 'Your account is ready.' : 'Password changed. You are signed in.', { kind: 'success' });
            location.href = '/';
          } catch (e2) {
            err.textContent = e2.message;
          } finally {
            save.disabled = false;
          }
        },
      },
      h('p.dialog-text.auth-lead', `Your username is "${info.username}".`),
      field('New password', a, 'At least 8 characters.'),
      field('Type it again', b),
      err,
      h('div.form-actions', save),
    ),
  );
}

// Shell -----------------------------------------------------------------------------------

function initials(me) {
  return (me.displayName || me.username).slice(0, 1).toUpperCase();
}

let shell = null;

function buildShell(pages) {
  const me = state.me;
  const nav = h('nav.nav', { 'aria-label': isAdminArea ? 'Admin' : 'Account' });
  const title = h('h1');
  const content = h('main.content', { id: 'content', tabindex: '-1' });
  const menuBtn = h('button.icon-btn.menu-btn', { type: 'button', 'aria-label': 'Menu', onClick: () => root.classList.toggle('nav-open') }, icon('chevron', 18));
  const side = h(
    'aside.side',
    h('div.brand', h('span.brand-mark', icon('pencil', 14)), 'CAD Home', h('small', isAdminArea ? 'Admin' : 'Account')),
    nav,
    h(
      'div.side-foot',
      h('div.who', h('span.avatar', { style: { background: me.color } }, initials(me)), h('div.who-text', h('span', me.displayName), h('small', me.username))),
      h('a.nav-link', { href: '/' }, icon('arrow_left', 16), 'Back to CAD'),
      isAdminArea ? h('a.nav-link', { href: '/account/' }, icon('user', 16), 'Account settings') : me.isAdmin || me.canHostApps ? h('a.nav-link', { href: '/admin/' }, icon('shield', 16), 'Admin panel') : null,
      h(
        'button.nav-link',
        {
          type: 'button',
          onClick: action(async () => {
            await api('POST', 'auth/logout');
            location.reload();
          }),
        },
        icon('log_out', 16),
        'Sign out',
      ),
    ),
  );
  root.className = 'panel-root';
  root.removeAttribute('aria-busy');
  clear(root).append(side, h('div.main', h('header.topbar', menuBtn, title), content));
  root.addEventListener('click', (e) => {
    if (e.target === root || e.target.closest('.nav-link')) root.classList.remove('nav-open');
  });
  shell = { nav, title, content, pages };
}

async function renderPage() {
  const { page, args } = route();
  if (page === 'reset' || page === 'invite') return passwordTokenPage(page, args[0] || '');
  if (page === 'forgot' && !state.me) return forgotPage();
  if (!state.me) return signInPage();
  const me = state.me;
  let pages = isAdminArea ? ADMIN_PAGES.filter((p) => me.isAdmin || (p.hosts && me.canHostApps)) : ACCOUNT_PAGES;
  if (isAdminArea && !pages.length) {
    return authShell('Admins only', h('div.stack', notice('info', 'Only admins can open the admin panel. Ask the person who runs this server if you need access.'), h('div.form-actions', h('a.btn', { href: '/account/' }, 'Account settings'), h('a.btn.primary', { href: '/' }, 'Back to CAD'))));
  }
  if (!shell || shell.pages !== pages) buildShell(pages);
  const current = pages.find((p) => p.id === page) || pages[0];
  clear(shell.nav).append(
    ...pages.map((p) => h('a.nav-link', { href: `#/${p.id}`, 'aria-current': p === current ? 'page' : null }, icon(p.icon, 16), p.label)),
  );
  shell.title.textContent = current.label;
  document.title = `${current.label} · CAD Home`;
  const target = shell.content;
  clear(target).append(h('div.loading', 'Loading…'));
  try {
    const el = await current.render({ args, me, refresh: renderPage, setTitle: (t) => (shell.title.textContent = t) });
    if (target === shell.content) clear(target).append(el);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      state.me = null;
      shell = null;
      return signInPage('Your session ended. Sign in again.');
    }
    clear(target).append(h('div.page', notice('error', err.message)));
  }
}

async function boot() {
  try {
    state.me = await api('GET', 'auth/me');
  } catch (err) {
    state.me = null;
    if (!(err instanceof ApiError) || err.status !== 401) {
      authShell('CAD Home', notice('error', err.message));
      return;
    }
  }
  if (state.me && !localStorage.getItem('cad.theme')) {
    api('GET', 'kv/settings')
      .then((r) => r.value?.theme && applyTheme(r.value.theme))
      .catch(() => {});
  }
  shell = null;
  await renderPage();
}

window.addEventListener('hashchange', renderPage);
window.addEventListener('storage', (e) => e.key === 'cad.theme' && applyTheme());
boot();
