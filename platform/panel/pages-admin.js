/** Admin pages: overview, people, sharing, email, server settings and the audit log. */
import { h, clear, icon, api, field, input, select, button, checkbox, toast, action, table, section, sectionWithActions, notice, badge, bytes, when, fullTime, duration, openDialog, confirmDialog, copyButton } from './ui.js';

const stat = (label, value, sub) => h('div.stat', h('div.stat-label', label), h('div.stat-value', value), sub ? h('div.stat-sub', sub) : null);

// Overview -----------------------------------------------------------------------------------

export async function overview() {
  const o = await api('GET', 'admin/overview');
  const hints = [];
  if (!o.privateUrl) hints.push(notice('info', 'The private address is not set. Links in emails use whatever address the admin panel was opened with.', h('a.link-btn', { href: '#/server' }, 'Set it in Server')));
  if (!o.publicUrl) hints.push(notice('info', 'Public share links and public apps are off until you set the public (Funnel) address.', h('a.link-btn', { href: '#/server' }, 'Set it in Server')));
  else if (o.publicReachable === false) hints.push(notice('warning', `This server could not reach ${o.publicUrl}/healthz. Check that Tailscale Funnel is on (tailscale funnel status). Some networks also block a computer from reaching its own Funnel address, so test from a phone on mobile data.`));
  else if (o.publicReachable) hints.push(notice('success', `The public address ${o.publicUrl} answers.`));
  if (!o.emailConfigured) hints.push(notice('info', 'Email is not set up, so invites, password resets and share notifications are off.', h('a.link-btn', { href: '#/email' }, 'Set up email')));
  return h(
    'div.page',
    h(
      'div.stats',
      stat('Running for', duration(o.uptime), `Node ${o.node}`),
      stat('Memory', bytes(o.memory.rss), `${bytes(o.memory.systemFree)} of ${bytes(o.memory.systemTotal)} free on this PC`),
      stat('Data folder', bytes(o.dataSize), o.disk ? `${bytes(o.disk.free)} free on the disk` : o.dataDir),
      stat('People', String(o.accounts), `${o.online} active in the last 5 minutes`),
      stat('Live drawings', String(o.rooms.length), `${o.rooms.reduce((n, r) => n + r.people.length, 0)} people editing`),
    ),
    hints.length ? h('div.stack', hints) : null,
    section(
      'Open live drawings',
      'Drawings someone has open right now. The server saves them automatically.',
      table(
        [
          { label: 'Drawing', render: (r) => h('div.cell-main', h('span.mono', r.path), h('small', `Owner ${r.owner}`)) },
          { label: 'People', render: (r) => r.people.map((p) => `${p.name}${p.mode === 'view' ? ' (view)' : ''}`).join(', ') || h('span.muted', 'Closing') },
          { label: 'Last save', render: (r) => (r.saveFailing ? badge('Not saving', 'danger') : when(r.lastSave)) },
        ],
        o.rooms,
        { empty: 'No drawings are open.' },
      ),
    ),
    section(
      'Recent errors',
      'The latest problems the server logged. Details are in the terminal where it runs.',
      table(
        [
          { label: 'When', render: (e) => h('span', { title: fullTime(e.at) }, when(e.at)) },
          { label: 'Where', render: (e) => h('span.mono', e.where) },
          { label: 'Message', render: (e) => e.message },
        ],
        o.errors,
        { empty: 'No errors since the server started.' },
      ),
    ),
  );
}

// People -------------------------------------------------------------------------------------

function personDialog(u) {
  const name = input({ value: u.displayName === u.username ? '' : u.displayName, placeholder: u.username });
  const email = input({ type: 'email', value: u.email });
  const isAdmin = checkbox('Admin', u.isAdmin, 'Can open this panel and manage the server.');
  const host = checkbox('Can host apps', u.hostsApps || u.isAdmin, 'Can deploy web apps and serverless functions. Functions run code on this PC, so only allow people you trust.');
  const disabled = checkbox('Disabled', u.disabled, 'Cannot sign in. Their files and shares stay.');
  if (u.isAdmin) host.input.disabled = true;
  return openDialog({
    title: `Edit ${u.username}`,
    body: h('div', field('Display name', name), field('Email', email), isAdmin.el, host.el, disabled.el),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Save',
        primary: true,
        onClick: () =>
          api('PUT', `admin/users/${u.username}`, { displayName: name.value, email: email.value, isAdmin: isAdmin.input.checked, canHostApps: host.input.checked, disabled: disabled.input.checked }).then(() => true),
      },
    ],
  });
}

function addPersonDialog(invite, emailReady) {
  const user = input({ autocapitalize: 'none', placeholder: 'for example sam' });
  const name = input();
  const email = input({ type: 'email' });
  const pass = input({ type: 'password', autocomplete: 'new-password' });
  const isAdmin = checkbox('Admin', false);
  const host = checkbox('Can host apps', false);
  const body = h(
    'div',
    invite && !emailReady ? notice('warning', 'Set up email first, so the invite can be sent.', h('a.link-btn', { href: '#/email' }, 'Email settings')) : null,
    h('div.form-grid', field('Username', user, '1 to 32 letters, digits, dots, dashes or underscores.'), field('Display name', name, 'Optional.')),
    field('Email', email, invite ? 'The invite goes here. It works for 7 days.' : 'Optional. Needed for password resets.'),
    invite ? null : field('Password', pass, 'At least 8 characters. Tell them, and they can change it in Account settings.'),
    isAdmin.el,
    host.el,
  );
  return openDialog({
    title: invite ? 'Invite by email' : 'Create with password',
    body,
    actions: [
      { label: 'Cancel' },
      {
        label: invite ? 'Send invite' : 'Create account',
        primary: true,
        onClick: async () => {
          const r = await api('POST', 'admin/users', { username: user.value.trim(), displayName: name.value, email: email.value.trim(), password: invite ? undefined : pass.value, invite, isAdmin: isAdmin.input.checked, canHostApps: host.input.checked });
          if (r.warning) toast(`Created, but the invite was not sent: ${r.warning}`, { kind: 'error', timeout: 9000 });
          else toast(invite ? `Invite sent to ${r.email}` : `Created ${r.username}`, { kind: 'success' });
          return true;
        },
      },
    ],
  });
}

function setPasswordDialog(u, emailReady) {
  const pass = input({ type: 'password', autocomplete: 'new-password' });
  return openDialog({
    title: `Reset password for ${u.username}`,
    size: 'sm',
    body: h(
      'div',
      u.email && emailReady ? h('p.dialog-text.auth-lead', `Send a reset link to ${u.email}, or set a new password yourself.`) : h('p.dialog-text.auth-lead', 'Set a new password and tell them what it is.'),
      field('New password', pass, 'Signs them out on every device.'),
    ),
    actions: [
      { label: 'Cancel' },
      u.email && emailReady ? { label: 'Email a reset link', onClick: () => api('POST', `admin/users/${u.username}/password`, { sendReset: true }).then(() => (toast('Reset link sent', { kind: 'success' }), true)) } : null,
      { label: 'Set password', primary: true, onClick: () => api('POST', `admin/users/${u.username}/password`, { password: pass.value }).then(() => (toast('Password changed', { kind: 'success' }), true)) },
    ].filter(Boolean),
  });
}

export async function people({ me, refresh }) {
  const [list, mail] = await Promise.all([api('GET', 'admin/users'), api('GET', 'admin/email')]);
  const tags = (u) =>
    h(
      'span.tags',
      u.isAdmin ? badge('Admin') : null,
      u.hostsApps && !u.isAdmin ? badge('Hosts apps', 'neutral') : null,
      u.disabled ? badge('Disabled', 'danger') : null,
      u.invited ? badge('Invited', 'warning') : null,
    );
  const run = (fn) => action(async () => ((await fn()) ? refresh() : false));
  return h(
    'div.page',
    sectionWithActions(
      'People',
      'Everyone who can sign in to this server. Accounts work only over your tailnet.',
      [button('Invite by email', { icon: 'mail', onClick: run(() => addPersonDialog(true, mail.configured)) }), button('Create with password', { kind: 'primary', icon: 'plus', onClick: run(() => addPersonDialog(false, mail.configured)) })],
      table(
        [
          { label: 'Person', render: (u) => h('div.row', h('span.avatar', { style: { background: u.color } }, (u.displayName || u.username)[0].toUpperCase()), h('div.cell-main', h('span', u.displayName), h('small', u.username))) },
          { label: 'Email', className: 'hide-sm', render: (u) => u.email || h('span.muted', '–') },
          { label: '', render: tags },
          { label: 'Last active', className: 'hide-sm', render: (u) => h('span', { title: fullTime(u.lastSeen) }, when(u.lastSeen)) },
          {
            label: '',
            className: 'actions',
            render: (u) =>
              h(
                'span',
                button('Edit', { sm: true, onClick: run(() => personDialog(u)) }),
                u.invited && u.email ? button('Resend invite', { sm: true, onClick: action(() => api('POST', `admin/users/${u.username}/invite`), { success: 'Invite sent' }) }) : button('Password', { sm: true, onClick: run(() => setPasswordDialog(u, mail.configured)) }),
                button('Sign out', {
                  sm: true,
                  title: 'Sign out everywhere',
                  onClick: run(async () => {
                    if (!(await confirmDialog(`Sign out ${u.username}?`, 'They are signed out on every device and leave any drawing they have open.', { confirm: 'Sign out', danger: true }))) return false;
                    await api('POST', `admin/users/${u.username}/signout`);
                    return true;
                  }),
                }),
                u.username === me.username
                  ? null
                  : button('Delete', {
                      sm: true,
                      kind: 'danger',
                      onClick: run(async () => {
                        const files = checkbox(`Also delete their files`, false, 'Otherwise their drawings stay in the data folder.');
                        const ok = await openDialog({
                          title: `Delete ${u.username}?`,
                          size: 'sm',
                          body: h('div', h('p.dialog-text.auth-lead', 'Their account, shares, links, app access and version history are removed.'), files.el),
                          actions: [{ label: 'Cancel' }, { label: 'Delete account', danger: true, value: true }],
                        });
                        if (!ok) return false;
                        await api('DELETE', `admin/users/${u.username}`, { deleteFiles: files.input.checked });
                        toast(`Deleted ${u.username}`, { kind: 'success' });
                        return true;
                      }),
                    }),
              ),
          },
        ],
        list,
      ),
    ),
  );
}

// Sharing ------------------------------------------------------------------------------------

export async function sharing({ refresh }) {
  const s = await api('GET', 'admin/sharing');
  return h(
    'div.page',
    section(
      'Shared with people',
      'Every file and folder shared between accounts.',
      table(
        [
          { label: 'Owner', render: (r) => r.owner },
          { label: 'Item', render: (r) => h('span.mono', r.path) },
          { label: 'With', render: (r) => r.grantee },
          { label: 'Access', render: (r) => badge(r.mode === 'edit' ? 'Can edit' : 'View only', r.mode === 'edit' ? '' : 'neutral') },
          { label: 'Since', className: 'hide-sm', render: (r) => when(r.created) },
          {
            label: '',
            className: 'actions',
            render: (r) =>
              button('Remove', {
                sm: true,
                onClick: action(async () => {
                  await api('DELETE', `admin/shares/${r.id}`);
                  refresh();
                }),
              }),
          },
        ],
        s.people,
        { empty: 'Nothing is shared between accounts.' },
      ),
    ),
    section(
      'Public links',
      'Links to drawings on the public (Funnel) address. Anyone with a link can use it.',
      table(
        [
          { label: 'Owner', render: (l) => l.owner },
          { label: 'Drawing', render: (l) => h('span.mono', l.path) },
          { label: 'Access', render: (l) => badge(l.mode === 'edit' ? 'Edit' : 'View', l.mode === 'edit' ? 'warning' : 'neutral') },
          { label: 'Created', className: 'hide-sm', render: (l) => when(l.created) },
          { label: 'Expires', render: (l) => (l.expired ? badge('Expired', 'danger') : l.expires ? when(l.expires) : 'Never') },
          { label: 'Last used', className: 'hide-sm', render: (l) => when(l.lastUsed) },
          { label: 'Uses', className: 'num', render: (l) => String(l.uses) },
          {
            label: '',
            className: 'actions',
            render: (l) =>
              button('Revoke', {
                sm: true,
                kind: 'danger',
                onClick: action(async () => {
                  if (!(await confirmDialog('Revoke this link?', 'Anyone using it is disconnected and the link stops working.', { confirm: 'Revoke', danger: true }))) return false;
                  await api('DELETE', `admin/links/${l.token}`);
                  refresh();
                }),
              }),
          },
        ],
        s.links,
        { empty: 'No public links.' },
      ),
    ),
  );
}

// Email --------------------------------------------------------------------------------------

export async function email({ refresh, me }) {
  const [m, log] = await Promise.all([api('GET', 'admin/email'), api('GET', 'admin/email/log')]);
  const host = input({ value: m.host, placeholder: 'smtp.example.com' });
  const port = input({ value: m.port || '', inputmode: 'numeric', placeholder: '587' });
  const secure = checkbox('Use TLS from the start (port 465)', m.secure, 'Leave off for port 587, which upgrades with STARTTLS.');
  const user = input({ value: m.user, autocomplete: 'off' });
  const pass = input({ type: 'password', value: m.pass, autocomplete: 'new-password', placeholder: m.pass ? '' : 'App password' });
  const from = input({ value: m.from, placeholder: 'CAD Home <cad@example.com>' });
  const to = input({ type: 'email', value: me.email, placeholder: 'you@example.com' });
  const form = h(
    'form',
    {
      onSubmit: action(
        async (e) => {
          e.preventDefault();
          await api('PUT', 'admin/email', { host: host.value, port: port.value, secure: secure.input.checked, user: user.value, pass: pass.value, from: from.value });
          refresh();
        },
        { success: 'Email settings saved' },
      ),
    },
    h(
      'div.form-grid',
      field('SMTP server', host, 'Leave empty to turn email off.'),
      field('Port', port),
      h('div.span2', secure.el),
      field('Username', user),
      field('Password', pass, m.pass ? 'Saved. Type a new one to replace it.' : 'For Gmail and Outlook, create an app password.'),
      h('div.span2', field('From', from, 'The sender people see. Defaults to the username.')),
    ),
    h('div.form-actions', button('Save', { kind: 'primary', type: 'submit' })),
  );
  return h(
    'div.page',
    m.configured ? null : notice('info', 'Until email is set up, invites, password resets and share notifications are off, and apps cannot send email.'),
    section('SMTP', 'Email goes through your own mail provider. The password is stored on this PC and never shown again.', form),
    section(
      'Send a test',
      null,
      h(
        'div.row',
        h('div.grow', field('To', to)),
        button('Send test email', {
          icon: 'send',
          disabled: !m.configured,
          onClick: action(() => api('POST', 'admin/email/test', { to: to.value }), { success: 'Test email sent' }),
        }),
      ),
    ),
    section(
      'Email log',
      'Who sent what to whom. Message bodies are not kept.',
      table(
        [
          { label: 'When', render: (r) => h('span', { title: fullTime(r.at) }, when(r.at)) },
          { label: 'From', className: 'hide-sm', render: (r) => h('div.cell-main', h('span', r.user || 'server'), h('small', r.source)) },
          { label: 'To', render: (r) => r.to_addr },
          { label: 'Subject', render: (r) => r.subject },
          { label: 'Status', render: (r) => (r.status === 'sent' ? badge('Sent', 'success') : h('span', { title: r.error || '' }, badge('Failed', 'danger'))) },
        ],
        log,
        { empty: 'No email sent yet.' },
      ),
    ),
  );
}

// Server -------------------------------------------------------------------------------------

export async function server({ refresh }) {
  const s = await api('GET', 'admin/server');
  const privateUrl = input({ value: s.privateUrl || '', placeholder: 'https://my-pc.tail1234.ts.net', disabled: !!s.envPrivateUrl });
  const publicUrl = input({ value: s.publicUrl || '', placeholder: 'https://my-pc.tail1234.ts.net:8443', disabled: !!s.envPublicUrl });
  const ai = input({ type: 'number', min: 0, value: s.publicAiPerHour });
  const mails = input({ type: 'number', min: 0, value: s.publicEmailPerHour });
  const timeout = input({ type: 'number', min: 1, max: 600, value: Math.round(s.functionTimeoutMs / 1000) });
  const guestBase = input({ value: s.workersPublicBaseUrl || '', placeholder: 'http://192.168.1.4:18100' });
  const hosting = checkbox('Enable shared static hosting', !!s.hostingEnabled, 'Sites are served under /site/<name> on the public listener. Published files are static and limited to 100 MiB per account.');
  const cmd = (text) => h('div.cmd', h('code', text), copyButton(text));
  const form = h(
    'form',
    {
      onSubmit: action(
        async (e) => {
          e.preventDefault();
          const body = { publicAiPerHour: ai.value, publicEmailPerHour: mails.value, functionTimeoutMs: Number(timeout.value) * 1000, workersPublicBaseUrl: guestBase.value, hostingEnabled: hosting.input.checked };
          if (!s.envPrivateUrl) body.privateUrl = privateUrl.value;
          if (!s.envPublicUrl) body.publicUrl = publicUrl.value;
          await api('PUT', 'admin/server', body);
          refresh();
        },
        { success: 'Saved' },
      ),
    },
    field('Private address', privateUrl, s.envPrivateUrl ? `Set by CAD_PRIVATE_URL: ${s.envPrivateUrl}` : 'Your tailnet address from tailscale serve. Used in invite and reset emails.'),
    field('Public address', publicUrl, s.envPublicUrl ? `Set by CAD_PUBLIC_URL: ${s.envPublicUrl}` : 'Your Funnel address, with :8443. Share links and public apps use it. Leave empty to turn them off.'),
    h(
      'div.form-grid',
      field('Public app AI calls per hour, per visitor', ai, 'Only for public apps with AI turned on.'),
      field('Public app emails per hour, per visitor', mails),
      field('Function time limit (seconds)', timeout, 'A function that runs longer is stopped.'),
      field('Guest links address (workers public routes)', guestBase, s.workersPublicBaseUrl
        ? 'Guest links use this address; they work for anyone whose network can reach it.'
        : 'Where guests are told to reach public links. Unset: links name this listener\'s own address and are reachable only from networks that reach it — a loopback-only hub is LAN-only.'),
    ),
    hosting.el,
    h('div.form-actions', button('Save', { kind: 'primary', type: 'submit' })),
  );
  return h(
    'div.page',
    section('Addresses and limits', null, form),
    section(
      'Tailscale',
      'Run these once on this PC. Serve keeps the app private to your tailnet; Funnel publishes only share links and public apps.',
      h(
        'div.stack',
        h('span.field-label', 'Private (you and people on your tailnet)'),
        cmd(`tailscale serve --bg --https=443 http://127.0.0.1:${s.privatePort}`),
        h('span.field-label', 'Public (share links and public apps only)'),
        cmd(`tailscale funnel --bg --https=8443 http://127.0.0.1:${s.publicPort}`),
        h('span.field-label', 'Check what is on'),
        cmd('tailscale serve status'),
        notice('info', 'Then set the private address to https://<this-pc>.<tailnet>.ts.net and the public address to the same name with :8443. The admin panel, accounts and drives are never on the public address.'),
      ),
    ),
    section(
      'Backup',
      'Downloads a copy of the database (accounts, shares, settings, logs) taken while the server runs. Drawings are normal files in the data folder; back that folder up too.',
      h('div.row', h('a.btn', { href: '#', onClick: (e) => (e.preventDefault(), downloadBackup(e.currentTarget)) }, icon('download', 16), 'Download database backup')),
    ),
  );
}

async function downloadBackup(btn) {
  btn.setAttribute('aria-disabled', 'true');
  try {
    const res = await api('GET', 'admin/backup', undefined, { raw: true });
    const blob = await res.blob();
    const a = h('a', { href: URL.createObjectURL(blob), download: `cad-home-${new Date().toISOString().slice(0, 10)}.db` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  } catch (err) {
    toast(err.message, { kind: 'error' });
  } finally {
    btn.removeAttribute('aria-disabled');
  }
}

// Audit --------------------------------------------------------------------------------------

export async function audit() {
  let rows = await api('GET', 'admin/audit');
  const holder = h('div');
  const more = button('Load older', {
    onClick: action(async () => {
      const older = await api('GET', `admin/audit?before=${rows.at(-1).id}`);
      rows = rows.concat(older);
      render();
      if (older.length < 200) more.remove();
    }),
  });
  const render = () =>
    clear(holder).append(
      table(
        [
          { label: 'When', render: (r) => h('span', { title: fullTime(r.at) }, when(r.at)) },
          { label: 'Who', render: (r) => r.actor || 'server' },
          { label: 'What', render: (r) => h('span.mono', r.action) },
          { label: 'Details', render: (r) => h('span.mono.muted', Object.entries(r.detail || {}).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('  ')) },
        ],
        rows,
        { empty: 'Nothing has been recorded yet.' },
      ),
    );
  render();
  return h('div.page', section('Audit log', 'Changes made in this panel, sign-ins with links, restores and command-line changes. Kept for a year.', holder, rows.length >= 200 ? h('div.form-actions', more) : null));
}

export { select };
