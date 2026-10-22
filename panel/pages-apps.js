/** Admin → Apps (and the same page for people who host apps): list, deploy a folder, settings, rollback and delete. */
import { h, api, field, input, button, action, table, sectionWithActions, notice, badge, when, openDialog, confirmDialog, checkbox, select, toast } from './ui.js';

// Deploy -----------------------------------------------------------------------------------------

async function deployFolder(appName, files, { title, isPublic } = {}) {
  const rel = (file) => {
    const p = file.webkitRelativePath || file.name;
    // The selected folder itself is the site root; keep everything inside it.
    const parts = p.split('/');
    return parts.slice(1).join('/') || file.name;
  };
  const all = [...files].filter((f) => rel(f));
  if (!all.some((f) => rel(f) === 'index.html')) {
    throw new Error('The folder needs an index.html page. Pick the folder that holds the app itself.');
  }
  await api('DELETE', `admin/apps/${appName}/staging`).catch(() => {});
  for (const f of all) await api('PUT', `admin/apps/${appName}/staging?path=${encodeURIComponent(rel(f))}`, f);
  await api('POST', `admin/apps/${appName}/publish`, { title, visibility: isPublic ? 'public' : 'private' });
  return all.length;
}

function deploySection(refresh) {
  const name = input({ placeholder: 'my-catalog' });
  const title = input({ placeholder: 'Parts catalog (shown in lists)' });
  const pub = checkbox('Public', false, 'Anyone with the public (Funnel) address can use it at /p/<name>/.');
  const picker = h('input', { type: 'file', webkitdirectory: true, multiple: true, hidden: true });
  const progress = h('p.muted');
  const choose = button('Deploy folder…', { kind: 'primary', onClick: async () => picker.click() });
  picker.addEventListener('change', action(async () => {
    const appName = name.value.trim();
    if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(appName)) throw new Error('Pick a name of 2 to 32 lowercase letters, digits or dashes, starting with a letter or digit.');
    let n;
    try {
      progress.textContent = 'Uploading…';
      choose.disabled = true;
      n = await deployFolder(appName, picker.files, { title: title.value.trim() || appName, isPublic: pub.input.checked });
    } finally {
      choose.disabled = false;
      progress.textContent = '';
      picker.value = '';
    }
    toast(`Deployed ${n} file(s) to ${appName}.`, { kind: 'success' });
    refresh();
  }));
  return sectionWithActions(
    'Deploy an app',
    'Pick a folder that holds the app: an index.html page plus whatever it needs alongside it.',
    picker,
    progress,
    field('Name', name, 'The app lives at /apps/<name>/. Deploying to the same name replaces it, and the previous version stays ready for roll back.'),
    field('Title', title),
    pub.el,
    choose,
    notice('info', 'Apps run in a sealed frame: they only reach your files after you pick them, and they never see cookies or other people\'s data.'),
    notice('warning', NETWORK_WARNING),
  );
}

// Function logs -----------------------------------------------------------------------------------

/** Node's permission model keeps functions away from files and processes — but not from the network. */
const NETWORK_WARNING =
  'Serverless functions run in a locked-down child process: deployed only if you deploy a functions folder, no file writes, no child processes, no worker threads. Give env secrets only to apps you trust.';

async function logsDialog(app) {
  const rows = await api('GET', `admin/apps/${app.name}/logs`);
  return openDialog({
    title: `Function logs — ${app.name}`,
    size: 'lg',
    body: h(
      'div.stack',
      notice('warning', 'Network access is not restricted: the functions of this app can reach the internet and your LAN even though file writes and child processes are blocked by the sandbox.'),
      table(
        [
          { label: 'Time', render: (r) => when(r.at) },
          { label: 'Function', render: (r) => h('span.mono', r.fn || '') },
          { label: 'Level', render: (r) => badge(r.level || 'log', r.level === 'error' ? 'danger' : 'neutral') },
          { label: 'Message', render: (r) => r.message ?? '' },
        ],
        rows || [],
        { empty: 'The app\'s functions have not printed anything yet.' },
      ),
    ),
    actions: [{ label: 'Close' }],
  });
}

// Settings -----------------------------------------------------------------------------------------

async function settingsDialog(app) {
  const detail = await api('GET', `admin/apps/${app.name}`);
  const title = input({ value: detail.title });
  const description = input({ value: detail.description });
  const visibility = select([['private', 'Private — people who sign in to this server'], ['public', 'Public — anyone with the public address']], detail.visibility);
  const publicAi = checkbox('Allow AI calls from public visitors', detail.publicAi, 'They still only see the models enabled in Admin → AI, and they are limited per person. When it is off, the SDK cannot use AI.');
  const publicEmail = checkbox('Let public visitors email the owner', detail.publicEmail, 'Public visitors may only send email to the address on the app owner, and they are limited.');
  const envList = h('div', { style: { display: 'grid', gap: '6px' } });
  const envAdd = (key = '', value = '') => {
    const k = input({ value: key, placeholder: 'Variable_name' });
    const v = input({ value, placeholder: 'value' });
    const row = h('div.row2', k, v, button('Remove', { sm: true, onClick: () => row.remove() }));
    envList.append(row);
  };
  for (const e of detail.env || []) envAdd(e.key, e.value);
  return openDialog({
    title: `Settings — ${detail.name}`,
    size: 'lg',
    body: h(
      'div.stack',
      field('Title', title),
      field('Description', description),
      field('Visibility', visibility),
      publicAi.el,
      publicEmail.el,
      h('fieldset', h('legend', 'Environment variables (secrets functions will get)'), h('div.stack', envList, button('Add variable', { sm: true, onClick: () => envAdd() }))),
    ),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Save',
        primary: true,
        onClick: () => {
          const env = {};
          for (const row of envList.querySelectorAll('.row2')) {
            const [k, v] = row.querySelectorAll('input');
            if (k.value.trim()) env[k.value.trim()] = v.value;
          }
          return api('PUT', `admin/apps/${detail.name}`, {
            title: title.value,
            description: description.value,
            visibility: visibility.value,
            publicAi: publicAi.input.checked,
            publicEmail: publicEmail.input.checked,
            env,
          }).then(() => true);
        },
      },
    ],
  });
}

// Page --------------------------------------------------------------------------------------------

export async function page({ me, refresh }) {
  if (!me.canHostApps) {
    return h('div.page', notice('info', 'You do not host apps. Ask an admin to switch "Can host apps" on for your account.'));
  }
  const list = await api('GET', 'admin/apps');
  return h(
    'div.page',
    sectionWithActions(
      'Hosted apps',
      'Web apps stored on this server, each opened in a sealed frame with scoped access only.',
      button('Refresh', { sm: true, onClick: action(refresh) }),
      table(
        [
          { label: 'App', render: (a) => h('div.cell-main', h('b', a.title || a.name), h('small.mono', a.name)) },
          { label: 'Owner', render: (a) => a.owner },
          {
            label: 'State',
            render: (a) =>
              h(
                'div.row2',
                a.published ? badge('Published') : badge('Not published', 'danger'),
                a.previous ? badge('Rollback ready', 'neutral') : null,
                a.visibility === 'public' ? badge('Public', 'success') : null,
                a.publicAi ? badge('Public AI', 'neutral') : null,
                a.publicEmail ? badge('Public email', 'neutral') : null,
              ),
          },
          { label: 'Updated', render: (a) => when(a.updated) },
          {
            label: '',
            className: 'actions',
            render: (a) =>
              h(
                'div.row2',
                button('Open', { sm: true, onClick: () => window.open(`/apps/${a.name}/`, '_blank', 'noopener') }),
                button('Settings', { sm: true, onClick: action(async () => { await settingsDialog(a); refresh(); }) }),
                button('Logs', { sm: true, onClick: action(() => logsDialog(a)) }),
                button('Roll back', { sm: true, disabled: !a.previous, onClick: action(() => api('POST', `admin/apps/${a.name}/rollback`), { success: 'The previous version is live again.' }) }),
                button('Delete', {
                  sm: true,
                  kind: 'danger',
                  onClick: action(async () => {
                    if (!(await confirmDialog(`Delete ${a.name}?`, 'The app, its data folder, its grants and its key-value data are removed. This cannot be undone.', { confirm: 'Delete', danger: true }))) return false;
                    await api('DELETE', `admin/apps/${a.name}`);
                    refresh();
                  }),
                }),
              ),
          },
        ],
        list,
        { empty: 'No apps yet. Deploy a folder below.' },
      ),
    ),
    deploySection(refresh),
  );
}
