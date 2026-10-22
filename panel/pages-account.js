/** Account pages: everyone's own profile, password, devices, shares and connected apps. */
import { h, clear, icon, api, field, input, button, checkbox, toast, action, table, section, sectionWithActions, notice, badge, when, fullTime, device, confirmDialog, copyButton } from './ui.js';
import { state } from './panel.js';

export const COLORS = ['#e5484d', '#f76b15', '#e2a336', '#46a758', '#12a594', '#0090ff', '#3e63dd', '#8e4ec6', '#d6409f', '#ab6400'];

export function colorPicker(value, onPick) {
  let current = value;
  const custom = h('input.input', { type: 'color', value, 'aria-label': 'Custom colour' });
  const wrap = h('div.swatches', { role: 'group', 'aria-label': 'Cursor colour' });
  const render = () => {
    clear(wrap).append(
      ...COLORS.map((c) =>
        h('button.swatch-btn', {
          type: 'button',
          style: { background: c },
          'aria-label': c,
          'aria-pressed': String(c.toLowerCase() === current.toLowerCase()),
          onClick: () => {
            current = c;
            custom.value = c;
            onPick(c);
            render();
          },
        }),
      ),
      custom,
    );
  };
  custom.addEventListener('input', () => {
    current = custom.value;
    onPick(current);
    render();
  });
  render();
  return wrap;
}

export async function profile() {
  const a = await api('GET', 'account');
  const name = input({ value: a.displayName, maxlength: 64, autocomplete: 'name' });
  const email = input({ type: 'email', value: a.email, autocomplete: 'email' });
  let color = a.color;
  const notify = checkbox('Email me when someone shares a file with me', a.notifyShares);
  const save = button('Save', { kind: 'primary', type: 'submit' });
  const form = h(
    'form',
    {
      onSubmit: action(
        async (e) => {
          e.preventDefault();
          const r = await api('PUT', 'account', { displayName: name.value, email: email.value, color, notifyShares: notify.input.checked });
          Object.assign(state.me, r);
        },
        { success: 'Saved' },
      ),
    },
    h(
      'div.form-grid',
      field('Display name', name, 'Shown to people you edit drawings with.'),
      field('Email', email, a.emailConfigured ? 'Used for password resets and share notifications.' : 'Used for password resets once the server can send email.'),
      h('div.field.span2', h('span.field-label', 'Cursor colour'), colorPicker(color, (c) => (color = c)), h('p.field-hint', 'Others see your cursor and selection in this colour during live editing.')),
      h('div.span2', notify.el),
    ),
    h('div.form-actions', save),
  );
  return h('div.page.narrow', section('Profile', `Signed in as ${a.username}.`, form));
}

export async function password() {
  const cur = input({ type: 'password', autocomplete: 'current-password' });
  const a = input({ type: 'password', autocomplete: 'new-password' });
  const b = input({ type: 'password', autocomplete: 'new-password' });
  const err = h('p.field-error', { role: 'alert' });
  const form = h(
    'form',
    {
      onSubmit: action(async (e) => {
        e.preventDefault();
        err.textContent = '';
        if (a.value.length < 8) return (err.textContent = 'Passwords need at least 8 characters.'), false;
        if (a.value !== b.value) return (err.textContent = 'The new passwords do not match.'), false;
        try {
          await api('POST', 'account/password', { current: cur.value, next: a.value });
        } catch (e2) {
          err.textContent = e2.message;
          return false;
        }
        cur.value = a.value = b.value = '';
        toast('Password changed. Your other devices were signed out.', { kind: 'success' });
      }),
    },
    field('Current password', cur),
    field('New password', a, 'At least 8 characters.'),
    field('Type the new password again', b),
    err,
    h('div.form-actions', button('Change password', { kind: 'primary', type: 'submit' })),
  );
  return h('div.page.narrow', section('Change password', 'Changing your password signs you out on every other device.', form));
}

export async function devices({ refresh }) {
  const list = await api('GET', 'account/sessions');
  const others = list.filter((s) => !s.current).length;
  return h(
    'div.page',
    sectionWithActions(
      'Signed-in devices',
      'Each browser where you signed in to CAD Home. Sign out any you do not recognise.',
      others
        ? button('Sign out all other devices', {
            kind: 'danger',
            onClick: action(async () => {
              if (!(await confirmDialog('Sign out other devices?', `${others} other device${others === 1 ? '' : 's'} will need to sign in again.`, { confirm: 'Sign out', danger: true }))) return false;
              await api('POST', 'account/sessions/others');
              refresh();
            }),
          })
        : null,
      table(
        [
          { label: 'Device', render: (s) => h('div.cell-main', h('span', device(s.userAgent), s.current ? h('span', ' ', badge('This device')) : null), h('small.hide-sm', s.userAgent.slice(0, 90))) },
          { label: 'Last active', render: (s) => h('span', { title: fullTime(s.lastSeen) }, when(s.lastSeen)) },
          { label: 'Signed in', className: 'hide-sm', render: (s) => when(s.created) },
          {
            label: '',
            className: 'actions',
            render: (s) =>
              s.current
                ? null
                : button('Sign out', {
                    sm: true,
                    onClick: action(async () => {
                      await api('DELETE', `account/sessions/${s.id}`);
                      refresh();
                    }),
                  }),
          },
        ],
        list,
        { empty: 'No sessions.' },
      ),
    ),
  );
}

export async function sharing({ refresh }) {
  const mine = await api('GET', 'share/mine');
  const peopleTable = table(
    [
      { label: 'Item', render: (r) => h('span.mono', r.path) },
      { label: 'Shared with', render: (r) => h('div.cell-main', h('span', r.displayName), h('small', r.grantee)) },
      { label: 'Access', render: (r) => badge(r.mode === 'edit' ? 'Can edit' : 'View only', r.mode === 'edit' ? '' : 'neutral') },
      { label: 'Since', className: 'hide-sm', render: (r) => when(r.created) },
      {
        label: '',
        className: 'actions',
        render: (r) =>
          button('Remove', {
            sm: true,
            onClick: action(async () => {
              await api('DELETE', 'share/people', { path: r.path, user: r.grantee });
              refresh();
            }),
          }),
      },
    ],
    mine.people,
    { empty: 'You have not shared anything with people yet. Use Share in the CAD app.' },
  );
  const linkTable = table(
    [
      { label: 'Drawing', render: (l) => h('span.mono', l.path) },
      { label: 'Access', render: (l) => badge(l.mode === 'edit' ? 'Anyone can edit' : 'Anyone can view', l.mode === 'edit' ? 'warning' : 'neutral') },
      { label: 'Expires', render: (l) => (l.expired ? badge('Expired', 'danger') : l.expires ? when(l.expires) : 'Never') },
      { label: 'Uses', className: 'num hide-sm', render: (l) => String(l.uses) },
      { label: 'Last used', className: 'hide-sm', render: (l) => when(l.lastUsed) },
      {
        label: '',
        className: 'actions',
        render: (l) =>
          h(
            'span',
            l.url ? copyButton(l.url, 'Copy link') : null,
            button('Revoke', {
              sm: true,
              kind: 'danger',
              onClick: action(async () => {
                if (!(await confirmDialog('Revoke this link?', 'Anyone using it is disconnected and the link stops working.', { confirm: 'Revoke', danger: true }))) return false;
                await api('DELETE', `share/links/${l.token}`);
                refresh();
              }),
            }),
          ),
      },
    ],
    mine.links,
    { empty: 'No public links.' },
  );
  return h('div.page', section('Shared with people', 'Files and folders you share with other accounts on this server.', peopleTable), section('Public links', 'Links to drawings that work for anyone who has them.', linkTable));
}

export async function connectedApps({ refresh }) {
  const list = await api('GET', 'account/apps');
  if (!list.length) return h('div.page', section('Connected apps', 'Web apps hosted on this server that you gave access to files or email.', h('div.empty', icon('plug', 16), h('span', 'No app has access to anything of yours.'))));
  return h(
    'div.page',
    list.map((app) =>
      sectionWithActions(
        app.title,
        `Hosted app "${app.app}".`,
        button('Remove all access', {
          kind: 'danger',
          sm: true,
          onClick: action(async () => {
            if (!(await confirmDialog(`Disconnect ${app.title}?`, 'The app loses access to the files you picked and to sending email. Its own app folder stays.', { confirm: 'Disconnect', danger: true }))) return false;
            for (const g of app.grants) await api('DELETE', `account/grants/${g.id}`);
            refresh();
          }),
        }),
        table(
          [
            { label: 'Access', render: (g) => (g.mode === 'email' ? h('span.row', icon('mail', 14), 'Send email as CAD Home') : h('span.row', icon(g.mode === 'edit' ? 'pencil' : 'eye', 14), h('span.mono', g.path))) },
            { label: 'Mode', render: (g) => (g.mode === 'email' ? badge('Email') : badge(g.mode === 'edit' ? 'Read and write' : 'Read only', 'neutral')) },
            { label: 'Since', render: (g) => when(g.created) },
            {
              label: '',
              className: 'actions',
              render: (g) =>
                button('Remove', {
                  sm: true,
                  onClick: action(async () => {
                    await api('DELETE', `account/grants/${g.id}`);
                    refresh();
                  }),
                }),
            },
          ],
          app.grants,
        ),
      ),
    ),
  );
}

export async function hubApps({ refresh }) {
  let grants = [];
  try {
    grants = await api('GET', 'hub/grants');
  } catch {
    grants = [];
  }
  const byApp = new Map();
  for (const g of grants) {
    if (!byApp.has(g.app)) byApp.set(g.app, { app: g.app, title: g.title, grants: [] });
    byApp.get(g.app).grants.push(g);
  }
  const apps = [...byApp.values()];

  return h(
    'div.page',
    section(
      'Hub app data',
      'Apps from the hub keep their own data in your storage. When an app looks at your files — for example after you picked a folder — that is listed here and stays until you remove it.',
      button('Export my hub app data', {
        sm: true,
        onClick: action(async () => {
          const res = await fetch('/api/hub/data/export', { credentials: 'same-origin', headers: { 'X-CAD-Request': '1' } });
          if (!res.ok) {
            toast('The export did not work. Try again.', 'danger');
            return false;
          }
          const blob = await res.blob();
          const name = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'hub-data.zip';
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = name;
          document.body.append(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        }),
      }),
    ),
    apps.length
      ? apps.map((app) =>
          sectionWithActions(
            app.title,
            `Hub app "${app.app}" sees:`,
            button('Revoke all', {
              kind: 'danger',
              sm: true,
              onClick: action(async () => {
                if (!(await confirmDialog(`Revoke ${app.title}'s access?`, 'The app loses the file access you granted. Its own app data folder stays.', { confirm: 'Revoke', danger: true }))) return false;
                for (const g of app.grants) await api('DELETE', `hub/grants/${g.id}`);
                toast('Access revoked.');
                refresh();
              }),
            }),
            table(
              [
                { label: 'Path', render: (g) => h('span.row', icon(g.path.includes('.') ? 'file' : 'folder', 14), h('span.mono', g.path)) },
                { label: 'Access', render: (g) => badge(g.perms === 'write' ? 'Read and write' : 'Read only', 'neutral') },
                { label: 'How', render: (g) => (g.source && g.source.startsWith('picker') ? 'File picker' : 'Default') },
                { label: 'Since', render: (g) => when(g.grantedAt) },
                {
                  label: '',
                  className: 'actions',
                  render: (g) =>
                    button('Revoke', {
                      sm: true,
                      onClick: action(async () => {
                        await api('DELETE', `hub/grants/${g.id}`);
                        toast('Access revoked.');
                        refresh();
                      }),
                    }),
                },
              ],
              app.grants,
            ),
          ),
        )
      : h('div.empty', icon('lock', 16), h('span', 'No hub app has access to your files. App data folders are included in the export and in storage quotas.')),
  );
}

export { notice };
