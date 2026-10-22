/** Admin → AI: provider keys, which models people can pick, prices and usage. */
import { h, clear, icon, api, field, input, button, checkbox, toast, action, table, section, sectionWithActions, notice, badge, select } from './ui.js';

const fmt = (n) => Number(n || 0).toLocaleString();
const money = (g) => (g.priced && g.cost ? `$${g.cost.toFixed(g.cost < 1 ? 4 : 2)}` : g.priced ? '$0' : '–');

function providerCard(p, onModels) {
  const key = input({ type: 'password', value: p.apiKey, autocomplete: 'off', placeholder: p.needsKey ? 'Paste an API key' : 'Not needed' });
  const base = input({ value: p.baseUrl, placeholder: p.defaultBaseUrl });
  const on = checkbox('Use Ollama on this PC', p.enabled);
  const status = h('div');
  const save = async () => {
    const body = { baseUrl: base.value };
    if (p.needsKey) body.apiKey = key.value;
    else body.enabled = on.input.checked;
    const r = await api('PUT', `admin/ai/providers/${p.id}`, body);
    if (p.needsKey) key.value = r.apiKey;
    p.enabled = r.enabled;
    clear(head.lastChild).append(p.enabled ? badge('On', 'success') : badge('Off', 'neutral'));
  };
  const head = h('div.provider-head', h('h3', p.label), h('span.grow'), h('span', p.enabled ? badge('On', 'success') : badge('Off', 'neutral')));
  return h(
    'section.card',
    h(
      'div.card-body.provider',
      head,
      p.needsKey ? field('API key', key, p.keyHint) : h('div', on.el, h('p.field-hint', p.keyHint)),
      field('Address', base, `Default ${p.defaultBaseUrl}`),
      status,
      h(
        'div.form-actions',
        button('Test', {
          sm: true,
          onClick: action(async () => {
            await save();
            try {
              const r = await api('POST', `admin/ai/providers/${p.id}/test`);
              clear(status).append(notice('success', r.message));
            } catch (err) {
              clear(status).append(notice('error', err.message));
            }
          }),
        }),
        button('Fetch models', {
          sm: true,
          icon: 'download',
          onClick: action(async () => {
            await save();
            try {
              const r = await api('POST', `admin/ai/providers/${p.id}/models`);
              onModels(r.models);
              clear(status).append(notice('success', `Found ${r.models.length} models. Turn on the ones people may use below.`));
            } catch (err) {
              clear(status).append(notice('error', err.message));
            }
          }),
        }),
        button('Save', { sm: true, kind: 'primary', onClick: action(save, { success: 'Saved' }) }),
      ),
    ),
  );
}

export async function page({ refresh }) {
  const [info, usage] = await Promise.all([api('GET', 'admin/ai'), api('GET', 'admin/ai/usage?days=30')]);
  let list = info.models.map((m) => ({ ...m }));
  const prices = { ...info.prices };
  const modelsHolder = h('div');
  const search = input({ type: 'search', placeholder: 'Filter models' });

  const addModels = (found) => {
    for (const m of found) if (!list.some((x) => x.id === m.id)) list.push({ id: m.id, label: m.label && m.label !== m.id.split(':').slice(1).join(':') ? m.label : '', enabled: false, tools: true });
    renderModels();
  };

  const renderModels = () => {
    const q = search.value.trim().toLowerCase();
    const rows = list.filter((m) => !q || m.id.toLowerCase().includes(q) || (m.label || '').toLowerCase().includes(q));
    clear(modelsHolder).append(
      table(
        [
          {
            label: 'On',
            width: '48px',
            render: (m) => h('input', { type: 'checkbox', checked: m.enabled, 'aria-label': `Allow ${m.id}`, onChange: (e) => (m.enabled = e.target.checked) }),
          },
          { label: 'Model', render: (m) => h('div.cell-main', h('span.mono', m.id.slice(m.id.indexOf(':') + 1)), h('small', info.providers.find((p) => p.id === m.id.split(':')[0])?.label || '')) },
          { label: 'Name people see', render: (m) => h('input.input.sm', { value: m.label || '', placeholder: m.id.slice(m.id.indexOf(':') + 1), 'aria-label': 'Label', onInput: (e) => (m.label = e.target.value) }) },
          { label: 'Can edit drawings', className: 'hide-sm', render: (m) => h('input', { type: 'checkbox', checked: m.tools !== false, 'aria-label': 'Tool use', title: 'Turn off for models that cannot call tools', onChange: (e) => (m.tools = e.target.checked) }) },
          {
            label: '$ / 1M in',
            className: 'hide-sm',
            render: (m) => h('input.input.sm', { type: 'number', min: 0, step: 'any', value: prices[m.id]?.input ?? '', 'aria-label': 'Input price', onInput: (e) => (prices[m.id] = { ...prices[m.id], input: e.target.value }) }),
          },
          {
            label: '$ / 1M out',
            className: 'hide-sm',
            render: (m) => h('input.input.sm', { type: 'number', min: 0, step: 'any', value: prices[m.id]?.output ?? '', 'aria-label': 'Output price', onInput: (e) => (prices[m.id] = { ...prices[m.id], output: e.target.value }) }),
          },
          {
            label: '',
            className: 'actions',
            render: (m) =>
              h('button.icon-btn.sm', {
                type: 'button',
                'aria-label': `Remove ${m.id}`,
                title: 'Remove from the list',
                onClick: () => {
                  list = list.filter((x) => x !== m);
                  renderModels();
                },
              }, icon('trash', 14)),
          },
        ],
        rows,
        { empty: list.length ? 'No model matches.' : 'No models yet. Save a key above, then Fetch models, or add one by name.' },
      ),
    );
  };
  search.addEventListener('input', renderModels);
  renderModels();

  const providerPick = select(
    info.providers.map((p) => [p.id, p.label]),
    'glm',
    { 'aria-label': 'Provider', class: 'input sm' },
  );
  const newName = h('input.input.sm', { placeholder: 'model name, for example glm-4.6', 'aria-label': 'Model name' });
  const addByName = h(
    'div.row',
    providerPick,
    newName,
    button('Add', {
      sm: true,
      icon: 'plus',
      onClick: () => {
        const n = newName.value.trim();
        if (!n) return;
        addModels([{ id: `${providerPick.value}:${n}` }]);
        list.find((m) => m.id === `${providerPick.value}:${n}`).enabled = true;
        newName.value = '';
        renderModels();
      },
    }),
  );

  const max = Math.max(1, ...usage.byDay.map((d) => d.input + d.output));
  const usageTable = (rows, label) =>
    table(
      [
        { label, render: (g) => h('span.mono', g.key) },
        { label: 'Calls', className: 'num', render: (g) => fmt(g.calls) },
        { label: 'Errors', className: 'num hide-sm', render: (g) => (g.errors ? h('span', badge(fmt(g.errors), 'danger')) : '0') },
        { label: 'Input tokens', className: 'num', render: (g) => fmt(g.input) },
        { label: 'Output tokens', className: 'num', render: (g) => fmt(g.output) },
        { label: 'Estimated cost', className: 'num', render: money },
      ],
      rows,
      { empty: 'No AI calls in the last 30 days.' },
    );

  return h(
    'div.page',
    notice('info', 'Keys stay on this PC and are never sent to browsers. Everyone signed in can use the models you turn on, without limits; public apps only when you allow it per app. Usage is logged below.'),
    h('div.split', info.providers.map((p) => providerCard(p, addModels))),
    sectionWithActions(
      'Models',
      'Turn on the models people can pick in the CAD assistant and in apps. Ollama models appear automatically while Ollama runs.',
      [
        search,
        button('Save models', {
          kind: 'primary',
          onClick: action(async () => {
            await api('PUT', 'admin/ai/models', { models: list });
            await api('PUT', 'admin/ai/prices', { prices });
          }, { success: 'Models saved' }),
        }),
      ],
      modelsHolder,
    ),
    section('Add a model by name', 'For providers that do not list their models (GLM may need this).', addByName),
    sectionWithActions(
      'Usage, last 30 days',
      `${fmt(usage.totals.calls)} calls, ${fmt(usage.totals.input)} input and ${fmt(usage.totals.output)} output tokens. Estimated cost ${money(usage.totals)} (set prices per model above).`,
      h('a.btn', { href: '/api/admin/ai/usage.csv?days=30', download: '', onClick: (e) => (e.preventDefault(), downloadCsv()) }, icon('download', 16), 'Export CSV'),
      h(
        'div.stack',
        table(
          [
            { label: 'Day', render: (d) => d.key },
            { label: '', className: 'bar-cell hide-sm', render: (d) => h('div.bar', { style: { width: `${Math.round(((d.input + d.output) / max) * 100)}%` } }) },
            { label: 'Calls', className: 'num', render: (d) => fmt(d.calls) },
            { label: 'Tokens', className: 'num', render: (d) => fmt(d.input + d.output) },
            { label: 'Estimated cost', className: 'num', render: money },
          ],
          usage.byDay,
          { empty: 'No AI calls in the last 30 days.' },
        ),
      ),
    ),
    h('div.split', section('By person or app', null, usageTable(usage.byPerson, 'Who')), section('By model', null, usageTable(usage.byModel, 'Model'))),
  );

  async function downloadCsv() {
    try {
      const res = await api('GET', 'admin/ai/usage.csv?days=30', undefined, { raw: true });
      const blob = await res.blob();
      const a = h('a', { href: URL.createObjectURL(blob), download: `ai-usage-${new Date().toISOString().slice(0, 10)}.csv` });
      document.body.append(a);
      a.click();
      a.remove();
    } catch (err) {
      toast(err.message, { kind: 'error' });
    }
  }
}
