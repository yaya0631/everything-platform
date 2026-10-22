/**
 * Panel building blocks. h() and clear() are the CAD app's own DOM helper;
 * dialogs and toasts use the same markup and classes as app/src/ui/dialog.js.
 */
import { h, clear } from '/panel/app/dom.js';
import { icon } from './icons.js';

export { h, clear, icon };

// Server ---------------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api(method, route, body, { raw = false, headers = {} } = {}) {
  const init = { method, headers: { 'X-CAD-Request': '1', ...headers }, credentials: 'same-origin', cache: 'no-store' };
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof ArrayBuffer || body instanceof Uint8Array) init.body = body;
    else {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
  }
  let res;
  try {
    res = await fetch(`/api/${route}`, init);
  } catch {
    throw new ApiError(0, 'network', 'Could not reach your CAD server. Check that it is running.');
  }
  if (raw && res.ok) return res;
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) throw new ApiError(res.status, data?.code || `http_${res.status}`, data?.message || `The server answered ${res.status}.`);
  return data;
}

// Formatting ------------------------------------------------------------------------------

export function bytes(n) {
  if (n == null) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

export function when(t) {
  if (!t) return '–';
  const d = new Date(typeof t === 'string' ? t : Number(t));
  const diff = Date.now() - d.getTime();
  if (diff >= 0 && diff < 60_000) return 'just now';
  if (diff >= 0 && diff < 3600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff >= 0 && diff < 86400_000) return `${Math.round(diff / 3600_000)} h ago`;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export const fullTime = (t) => (t ? new Date(typeof t === 'string' ? t : Number(t)).toLocaleString() : '');

export function duration(ms) {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} min`;
  const hrs = Math.floor(m / 60);
  if (hrs < 48) return `${hrs} h ${m % 60} min`;
  return `${Math.floor(hrs / 24)} days`;
}

export function device(ua) {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

// Controls -------------------------------------------------------------------------------

let uid = 0;
export const nextId = (p = 'f') => `${p}-${++uid}`;

/** A labelled form field like the app's dialogs: label, control, optional hint. */
export function field(label, control, hint) {
  const id = control.id || nextId();
  control.id = id;
  const hintEl = hint ? h('p.field-hint', { id: `${id}-hint` }, hint) : null;
  if (hintEl) control.setAttribute('aria-describedby', hintEl.id);
  return h('div.field', h('label.field-label', { for: id }, label), control, hintEl);
}

export function checkbox(label, checked, hint) {
  const input = h('input', { type: 'checkbox', checked });
  return { el: h('label.check', input, h('span', label, hint ? h('small.check-hint', hint) : null)), input };
}

export function input(attrs = {}) {
  return h('input.input', { type: 'text', spellcheck: 'false', ...attrs });
}

export function select(options, value, attrs = {}) {
  return h(
    'select.input',
    attrs,
    options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)),
  );
}

export function button(label, { kind = '', icon: ic, onClick, type = 'button', sm = false, disabled = false, title } = {}) {
  return h(`button.btn${kind ? `.${kind}` : ''}${sm ? '.sm' : ''}`, { type, onClick, disabled, title }, ic ? icon(ic, sm ? 14 : 16) : null, label);
}

export function iconButton(name, label, onClick) {
  return h('button.icon-btn', { type: 'button', 'aria-label': label, title: label, onClick }, icon(name, 16));
}

export function badge(text, kind = '') {
  return h(`span.badge${kind ? `.${kind}` : ''}`, text);
}

/** A busy-safe click handler: disables the button while the action runs and reports errors. */
export function action(fn, { success } = {}) {
  return async (e) => {
    const btn = e?.currentTarget;
    if (btn?.disabled) return;
    if (btn) btn.disabled = true;
    try {
      const r = await fn(e);
      if (success && r !== false) toast(typeof success === 'function' ? success(r) : success, { kind: 'success' });
    } catch (err) {
      toast(err.message || String(err), { kind: 'error', timeout: 7000 });
    } finally {
      if (btn && btn.isConnected) btn.disabled = false;
    }
  };
}

/**
 * table([{ label, render(row), className, width }], rows, { empty, caption })
 * Dense table with a sticky header and a clear empty state.
 */
export function table(columns, rows, { empty = 'Nothing here yet.', caption } = {}) {
  if (!rows.length) return h('div.empty', icon('info', 16), h('span', empty));
  return h(
    'div.table-wrap',
    h(
      'table.table',
      caption ? h('caption.sr-only', caption) : null,
      h('thead', h('tr', columns.map((c) => h('th', { scope: 'col', class: c.className, style: c.width ? { width: c.width } : null }, c.label)))),
      h(
        'tbody',
        rows.map((r) => h('tr', columns.map((c) => h('td', { class: c.className }, c.render(r))))),
      ),
    ),
  );
}

export function section(title, description, ...children) {
  return h('section.card', h('header.card-head', h('div', h('h2.card-title', title), description ? h('p.card-desc', description) : null)), h('div.card-body', children));
}

export function sectionWithActions(title, description, actions, ...children) {
  return h(
    'section.card',
    h('header.card-head', h('div.grow', h('h2.card-title', title), description ? h('p.card-desc', description) : null), h('div.card-actions', actions)),
    h('div.card-body', children),
  );
}

export function notice(kind, text, ...extra) {
  return h(`div.notice.${kind}`, { role: kind === 'error' ? 'alert' : 'note' }, icon(kind === 'error' || kind === 'warning' ? 'alert' : 'info', 16), h('div', h('p', text), extra));
}

export function copyButton(text, label = 'Copy') {
  return button(label, {
    sm: true,
    icon: 'copy',
    onClick: async () => {
      try {
        await navigator.clipboard.writeText(text);
        toast('Copied', { kind: 'success' });
      } catch {
        toast('Select the text and copy it with Ctrl+C.', { kind: 'error' });
      }
    },
  });
}

// Dialogs and toasts (same markup as the CAD app) ---------------------------------------------

export function openDialog({ title, body, actions = [], size = 'md', initialFocus }) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const titleId = nextId('dlg');
    const dlg = h('dialog.dialog', { 'aria-labelledby': titleId, class: `size-${size}` });
    const close = (value) => {
      if (!dlg.open) return;
      dlg.close();
      dlg.remove();
      prev?.focus?.({ preventScroll: true });
      resolve(value);
    };
    const footer = actions.length
      ? h(
          'footer.dialog-actions',
          actions.map((a) =>
            h(
              `button.btn${a.primary ? '.primary' : ''}${a.danger ? '.danger' : ''}`,
              {
                type: 'button',
                onClick: async (e) => {
                  if (!a.onClick) return close(a.value ?? null);
                  const btn = e.currentTarget;
                  btn.disabled = true;
                  try {
                    const r = await a.onClick(e);
                    if (r === false) return;
                    close(r ?? a.value ?? null);
                  } catch (err) {
                    const errEl = dlg.querySelector('.field-error.dialog-error');
                    if (errEl) errEl.textContent = err.message;
                    else toast(err.message, { kind: 'error', timeout: 7000 });
                  } finally {
                    if (btn.isConnected) btn.disabled = false;
                  }
                },
              },
              a.label,
            ),
          ),
        )
      : null;
    dlg.append(
      h('header.dialog-head', h('h2.dialog-title', { id: titleId }, title), h('button.icon-btn.dialog-x', { type: 'button', 'aria-label': 'Close', onClick: () => close(null) }, icon('x', 18))),
      h('div.dialog-body', body, h('p.field-error.dialog-error', { role: 'alert' })),
    );
    if (footer) dlg.append(footer);
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      close(null);
    });
    dlg.addEventListener('keydown', (e) => {
      const t = e.target;
      if (e.key === 'Enter' && t instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'color', 'file'].includes(t.type)) {
        const primary = dlg.querySelector('.dialog-actions .btn.primary, .dialog-actions .btn.danger');
        if (primary) {
          e.preventDefault();
          primary.click();
        }
      }
    });
    document.body.append(dlg);
    dlg.showModal();
    const f = initialFocus ? dlg.querySelector(initialFocus) : dlg.querySelector('input:not([type=hidden]), select, textarea, .dialog-actions button.primary');
    f?.focus();
  });
}

export async function confirmDialog(title, message, { confirm = 'OK', danger = false } = {}) {
  const r = await openDialog({
    title,
    body: h('p.dialog-text', message),
    size: 'sm',
    actions: [
      { label: 'Cancel', value: false },
      { label: confirm, primary: !danger, danger, value: true },
    ],
  });
  return r === true;
}

let region = null;
export function toast(message, { kind = 'info', timeout = 3200 } = {}) {
  if (!region) {
    region = h('div.toasts', { role: 'status', 'aria-live': 'polite' });
    if ('popover' in region) region.popover = 'manual';
    document.body.append(region);
  }
  try {
    if (region.popover) {
      if (region.matches(':popover-open')) region.hidePopover();
      region.showPopover();
    }
  } catch {
    /* no popovers */
  }
  const el = h(`div.toast.${kind}`, h('span.toast-msg', message), h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Dismiss', onClick: () => el.remove() }, icon('x', 14)));
  region.append(el);
  if (timeout) setTimeout(() => el.remove(), timeout);
  return el;
}
