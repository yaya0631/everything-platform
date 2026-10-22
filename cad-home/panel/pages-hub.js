/** Admin → Hub: the apps installed from the HeyPuter/everything clone — enable, gate, scan, remove. */
import { h, api, field, input, button, iconButton, action, table, sectionWithActions, section, notice, badge, bytes, when, openDialog, confirmDialog, checkbox, select, toast, copyButton } from './ui.js';


const INSTALL_HINT = 'Install and update from the terminal, one app at a time: “npm run hub -- install <name>” builds it from the pristine clone and scans nothing at runtime — all external calls are stripped when the app is served.';

async function scanDialog(app) {
  const scan = await api('GET', `hub/apps/${app.name}/scan`);
  const body = scan.urls.length
    ? table(
        [
          { label: 'External URL (what the build would reach)', render: (u) => h('span.mono', u.url) },
          { label: 'Hits', width: '70px', render: (u) => String(u.count) },
          { label: 'Where', render: (u) => h('span.muted', u.files.join(', ')) },
        ],
        scan.urls,
        { empty: 'No external URLs found.' },
      )
    : h('p.muted', 'No external URLs found anywhere in the build.');
  return openDialog({
    title: `External URLs — ${app.name}`,
    size: 'lg',
    body: h(
      'div.stack',
      notice('info', `From ${scan.sha ? `clone commit ${scan.sha.slice(0, 8)}` : 'the imported build'}. These are the URLs in the built files; the /hub/ loader URL is rewritten and analytics/CDN tags are stripped when the app is served — the rest are blocked by the strict CSP. Anything you want served locally must be listed in the README’s honest-diffs section.`),
      body,
    ),
    actions: [{ label: 'Close' }],
  });
}

function accessControl(app, refresh) {
  const wrap = h('div.row2');
  const mode = select(
    [
      ['all', 'Everyone who signs in'],
      ['users', 'Only people on the list'],
    ],
    app.access,
  );
  const users = input({ value: app.users.join(', '), placeholder: 'names, comma separated' });
  users.style.minWidth = '180px';
  users.disabled = app.access !== 'users';
  const save = button('Save', { sm: true, onClick: action(async () => {
    const list = users.value.split(',').map((n) => n.trim()).filter(Boolean);
    await api('PUT', `hub/apps/${app.name}`, { access: mode.value, users: mode.value === 'all' ? null : list });
    toast(`Access updated for ${app.name}.`, { kind: 'success' });
    refresh();
  }) });
  mode.addEventListener('change', () => {
    users.disabled = mode.value !== 'users';
  });
  wrap.append(mode, users, save);
  return wrap;
}

export async function page({ me, refresh }) {
  const info = await api('GET', 'hub/apps');
  const apps = info.apps;

  const rows = table(
    [
      { label: 'App', render: (a) => h('div.cell-main', h('span.mono', a.name), h('small', a.title)) },
      { label: 'Built', render: (a) => h('span', { title: a.sha ? `clone commit ${a.sha}` : 'imported' }, `${when(a.builtAt)} · ${a.source === 'import' ? 'imported' : a.sha ? a.sha.slice(0, 8) : ''}`) },
      { label: 'Size', render: (a) => `${bytes(a.size)} · ${a.files} file(s)` },
      {
        label: 'On',
        render: (a) => {
          const cb = checkbox('', a.enabled, '');
          cb.el.querySelector('small')?.remove();
          cb.input.addEventListener('change', action(async () => {
            await api('PUT', `hub/apps/${a.name}`, { enabled: cb.input.checked });
            toast(`${a.name} ${cb.input.checked ? 'enabled' : 'disabled'}.`, { kind: 'success' });
            refresh();
          }));
          return cb.el;
        },
      },
      { label: 'Who can open it', render: (a) => accessControl(a, refresh) },
      {
        label: '',
        render: (a) =>
          h(
            'div.row',
            button('Scan', { sm: true, onClick: action(() => scanDialog(a)) }),
            button('Remove', { sm: true, kind: 'danger', onClick: action(async () => {
              if (!(await confirmDialog(`Remove ${a.name}? This deletes the installed build; the upstream clone is untouched.`))) return false;
              await api('DELETE', `hub/apps/${a.name}`);
              toast(`${a.name} removed.`, { kind: 'success' });
              refresh();
            }) }),
          ),
      },
    ],
    apps,
    { empty: 'No hub apps installed yet.' },
  );

  const ai = await api('GET', 'hub/ai-settings');
  const aiDefault = input({ value: String(ai.defaultModel || ''), placeholder: 'ollama:llama3.2 — left empty, puter.ai.chat refuses calls' });
  const aiAliases = h('textarea.input', { rows: 3, spellcheck: false, placeholder: '{"gpt-4o": "ollama:llama3.2"}' });
  aiAliases.value = String(ai.aliases || '');
  const aiSection = sectionWithActions(
    'Hub AI (puter.ai.chat)',
    'Hub apps talk to this server\u2019s own AI providers. Set the model that answers by default, and map cloud model names apps ask for onto it.',
    [
      button('Save', {
        sm: true,
        onClick: action(async () => {
          try {
            await api('PUT', 'hub/ai-settings', { defaultModel: aiDefault.value, aliases: aiAliases.value });
            toast('Hub AI settings saved.');
          } catch (e) {
            toast(e?.message || 'That did not save.', 'danger');
            return false;
          }
        }),
      }),
    ],
    field('Default model', aiDefault, 'provider:model — apps that pass an unknown cloud name get this'),
    field('Cloud model aliases (JSON)', aiAliases, 'cloudName → provider:model, one per line pair'),
  );

  const reports = await api('GET', 'hub/csp-reports');  const reportsSection = section(
    'CSP violation reports',
    'When a page or script tries something the strict CSP forbids, the browser reports it here. An empty list after using an app means it made every request from this server only.',
    reports.length
      ? table(
          [
            { label: 'When', render: (r) => h('span', { title: String(r.at) }, when(r.at)) },
            { label: 'Where', render: (r) => h('span.mono', r.app) },
            { label: 'Blocked', render: (r) => h('span.mono', r.blocked || r.directive) },
            { label: 'Directive', render: (r) => badge(r.directive) },
          ],
          reports,
          { empty: 'No violations reported.' },
        )
      : h('p.muted', 'No reports since the server started. Good sign.'),
  );

  return h(
    'div.page',
    sectionWithActions('Hub apps', `Everything dir: ${info.everythingDir} (pristine git clone; builds live in this server's data folder; apps run at /h/<name>/)`, [copyButton('npm run hub -- status', 'Copy the status command')]),
    rows,
    aiSection,
    reportsSection,
    notice('info', INSTALL_HINT),
  );
}
