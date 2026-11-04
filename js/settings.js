// Settings: what to track, AI provider, Fitbit, data import/export.
import { h, modal, toast, confirmDialog, shareOrDownload, download, ymd } from './util.js';
import { loadMetrics, saveMetrics, loadSettings, saveSettings, GROUPS, TYPES, slug } from './metrics.js';
import { dailyCSV, foodCSV, backupJSON, importBackup, importDailyCSV, wipeAll } from './io.js';
import { testAI, listGeminiModels } from './ai.js';
import { connectHealth, syncHealth, healthConnected, disconnectHealth, redirectUri } from './health.js';
import { requestPersist } from './db.js';

export async function renderSettings(root) {
  const settings = await loadSettings();
  const metrics = await loadMetrics();
  const save = async () => { await saveSettings(settings); toast('Saved'); };
  const stamp = ymd(new Date());

  // ---- metrics ----
  const mlist = h('div', { class: 'mlist' });
  const paintMetrics = () => {
    mlist.replaceChildren(...GROUPS.flatMap((g) => {
      const list = metrics.filter((m) => (GROUPS.includes(m.group) ? m.group : 'Other') === g);
      if (!list.length) return [];
      return [h('h4', {}, g), ...list.map((m) => h('div', { class: `mitem${m.archived ? ' archived' : ''}` },
        h('div', { class: 'grow' }, m.name, h('small', {}, ` ${TYPES[m.type] || m.type}${m.derived ? ' · auto' : ''}${m.source ? ` · ${m.source}` : ''}`)),
        h('button', { class: 'icon-btn', 'aria-label': 'Move up', onclick: () => move(m, -1) }, '↑'),
        h('button', { class: 'icon-btn', 'aria-label': 'Edit', onclick: () => editMetric(m) }, '✎'),
        h('button', { class: 'chip small' + (m.archived ? '' : ' on'), onclick: async () => { m.archived = !m.archived; await saveMetrics(metrics); paintMetrics(); } }, m.archived ? 'off' : 'on')))];
    }));
  };
  const move = async (m, dir) => {
    const i = metrics.indexOf(m);
    // swap with the previous metric in the same group
    for (let j = i + dir; j >= 0 && j < metrics.length; j += dir) {
      if (metrics[j].group === m.group) { [metrics[i], metrics[j]] = [metrics[j], metrics[i]]; break; }
    }
    await saveMetrics(metrics); paintMetrics();
  };
  async function editMetric(m) {
    const isNew = !m;
    const d = m ? { ...m } : { name: '', type: 'scale', group: 'Check-in', min: 1, max: 10, polarity: 1 };
    const f = {
      name: h('input', { type: 'text', value: d.name }),
      type: h('select', {}, Object.entries(TYPES).map(([k, l]) => h('option', { value: k, selected: d.type === k }, l))),
      group: h('select', {}, GROUPS.map((g) => h('option', { value: g, selected: d.group === g }, g))),
      max: h('input', { type: 'number', value: d.max ?? 10, min: 2, max: 10 }),
      step: h('input', { type: 'number', value: d.step ?? '', step: 'any', placeholder: 'default' }),
      unit: h('input', { type: 'text', value: d.unit || '' }),
      polarity: h('select', {}, [[1, 'More is better'], [0, 'Neutral'], [-1, 'Less is better']].map(([v, l]) => h('option', { value: v, selected: Number(d.polarity) === v }, l))),
    };
    const body = h('div', { class: 'form' },
      h('label', {}, 'Name', f.name), h('label', {}, 'Type', f.type), h('label', {}, 'Group', f.group),
      h('label', {}, 'Scale top (scale only)', f.max), h('label', {}, 'Step for +/−', f.step),
      h('label', {}, 'Unit', f.unit), h('label', {}, 'Direction', f.polarity),
      m?.derived ? h('p', { class: 'small muted' }, 'This one is calculated automatically.') : null);
    const ok = await modal(isNew ? 'New thing to track' : 'Edit', body, [
      !isNew ? { label: 'Delete', value: 'delete' } : null,
      { label: 'Save', value: 'save', primary: true }].filter(Boolean));
    if (ok === 'delete') {
      if (await confirmDialog(`Delete "${d.name}"? Logged values stay in your days but stop showing. Turning it off is usually better.`, 'Delete')) {
        metrics.splice(metrics.indexOf(m), 1); await saveMetrics(metrics); paintMetrics();
      }
      return;
    }
    if (ok !== 'save' || !f.name.value.trim()) return;
    Object.assign(d, {
      name: f.name.value.trim(), type: f.type.value, group: f.group.value, unit: f.unit.value.trim() || undefined,
      polarity: Number(f.polarity.value), step: f.step.value ? Number(f.step.value) : undefined,
    });
    if (d.type === 'scale') { d.min = d.min ?? 1; d.max = Math.max(2, Math.min(10, Number(f.max.value) || 10)); }
    if (isNew) {
      d.id = slug(d.name);
      while (metrics.some((x) => x.id === d.id)) d.id += '_';
      metrics.push(d);
    } else Object.assign(m, d);
    await saveMetrics(metrics); paintMetrics();
  }
  paintMetrics();

  // ---- AI ----
  const ai = settings.ai;
  const aiStatus = h('small', { class: 'muted' });
  const aiBox = h('section', { class: 'card' },
    h('h3', {}, 'Food photo AI'),
    h('label', {}, 'Provider', h('select', { onchange: (e) => { ai.provider = e.target.value; save(); } },
      [['none', 'Off (type numbers yourself)'], ['gemini', 'Google Gemini (free key)'], ['claude', 'Anthropic Claude (paid key)']].map(([v, l]) => h('option', { value: v, selected: ai.provider === v }, l)))),
    h('label', {}, 'Gemini API key', h('input', { type: 'password', value: ai.geminiKey, autocomplete: 'off', onchange: (e) => { ai.geminiKey = e.target.value.trim(); save(); } })),
    h('label', {}, 'Gemini model', h('input', { type: 'text', value: ai.geminiModel, list: 'gemini-models', onchange: (e) => { ai.geminiModel = e.target.value.trim(); save(); } })),
    h('datalist', { id: 'gemini-models' }),
    h('button', { class: 'btn', onclick: async (e) => {
      try {
        const names = await listGeminiModels(ai.geminiKey);
        document.getElementById('gemini-models').replaceChildren(...names.map((n) => h('option', { value: n })));
        e.target.textContent = `${names.length} models loaded: tap the model box`;
      } catch (err) { e.target.textContent = err.message; }
    } }, 'Load Gemini model list'),
    h('label', {}, 'Claude API key', h('input', { type: 'password', value: ai.claudeKey, autocomplete: 'off', onchange: (e) => { ai.claudeKey = e.target.value.trim(); save(); } })),
    h('label', {}, 'Claude model', h('select', { onchange: (e) => { ai.claudeModel = e.target.value; save(); } },
      [['claude-opus-5-5', 'Claude Opus 5.5 (best)'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5'], ['claude-haiku-5-5', 'Claude Haiku 5.5 (cheapest)']].map(([v, l]) => h('option', { value: v, selected: ai.claudeModel === v }, l)))),
    h('p', { class: 'small muted' }, "Keys stay on this phone. Only the food photo and food text go to the provider you pick, only when you press Estimate. Gemini's free tier may use inputs for training and lets human reviewers read them (about 20 requests a day); Claude costs roughly $0.0003 (Haiku) to $0.01 (Opus) per photo and is not used for training."),
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => {
      aiStatus.textContent = 'Testing…';
      try { aiStatus.textContent = `Works: ${await testAI(settings)}`; } catch (e) { aiStatus.textContent = e.message; }
    } }, 'Test'), aiStatus));

  // ---- Fitbit via Google Health API ----
  const hs = settings.health;
  const fbStatus = h('small', { class: 'muted' }, healthConnected(settings) ? `Connected${hs.lastSync ? `, last sync ${hs.lastSync}` : ''}` : 'Not connected');
  const runSync = async (days) => {
    fbStatus.textContent = 'Syncing…';
    try {
      const r = await syncHealth(days);
      fbStatus.textContent = `Synced ${r.days} days (${r.start} → ${r.end})${r.errors.length ? `. Partly failed: ${r.errors.join('; ')}` : ''}`;
    } catch (e) { fbStatus.textContent = e.message; }
  };
  const fbBox = h('section', { class: 'card' },
    h('h3', {}, 'Fitbit (Google Health)'),
    h('p', { class: 'small muted' }, "Pulls steps, sleep and resting heart rate. Fitbit's own API shuts down 2026-11-02, so this uses Google's Health API. One-time setup is in docs/SETUP-health.md. Authorized redirect URI:"),
    h('code', { class: 'copy' }, redirectUri()),
    h('label', {}, 'OAuth client ID', h('input', { type: 'text', value: hs.clientId, onchange: (e) => { hs.clientId = e.target.value.trim(); save(); } })),
    h('label', {}, 'OAuth client secret', h('input', { type: 'password', value: hs.clientSecret, autocomplete: 'off', onchange: (e) => { hs.clientSecret = e.target.value.trim(); save(); } })),
    h('div', { class: 'row' },
      healthConnected(settings)
        ? [h('button', { class: 'btn primary', onclick: () => runSync() }, 'Sync now'),
          h('button', { class: 'btn', onclick: () => runSync(90) }, 'Backfill 90d'),
          h('button', { class: 'btn', onclick: async () => { await disconnectHealth(settings); renderSettings(root); } }, 'Disconnect')]
        : h('button', { class: 'btn primary', onclick: () => connectHealth().catch((e) => { fbStatus.textContent = e.message; }) }, 'Connect'),
      fbStatus));

  // ---- day & goals ----
  const dayBox = h('section', { class: 'card' },
    h('h3', {}, 'Day & goals'),
    h('label', {}, 'A new day starts at', h('select', { onchange: (e) => { settings.dayStartHour = Number(e.target.value); save(); } },
      [0, 2, 3, 4, 5, 6].map((v) => h('option', { value: v, selected: settings.dayStartHour === v }, `${v}:00${v === 0 ? ' (midnight)' : ''}`)))),
    h('label', {}, 'Daily calorie target (0 = none)', h('input', { type: 'number', value: settings.kcalGoal || 0, onchange: (e) => { settings.kcalGoal = Number(e.target.value) || 0; save(); } })),
    h('label', {}, 'Daily protein target, g (0 = none)', h('input', { type: 'number', value: settings.proteinGoal || 0, onchange: (e) => { settings.proteinGoal = Number(e.target.value) || 0; save(); } })));

  // ---- data ----
  const fileIn = h('input', { type: 'file', accept: '.json,.csv,application/json,text/csv', class: 'hidden', onchange: async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      const r = f.name.endsWith('.csv') ? await importDailyCSV(text) : await importBackup(text);
      toast(`Imported ${r.days} days${r.food ? `, ${r.food} food entries` : ''}`, 3500);
      renderSettings(root);
    } catch (err) { toast(`Import failed: ${err.message}`, 5000); }
  } });
  const persistInfo = h('small', { class: 'muted' });
  if (navigator.storage?.persisted) navigator.storage.persisted().then((p) => { persistInfo.textContent = p ? 'Storage is protected from automatic clearing.' : 'Storage may be cleared by Chrome if space runs low; export backups.'; });
  const dataBox = h('section', { class: 'card' },
    h('h3', {}, 'Your data'),
    h('div', { class: 'btn-grid' },
      h('button', { class: 'btn', onclick: async () => shareOrDownload(`daybook-daily-${stamp}.csv`, await dailyCSV()) }, 'Daily CSV'),
      h('button', { class: 'btn', onclick: async () => shareOrDownload(`daybook-food-${stamp}.csv`, await foodCSV()) }, 'Food CSV'),
      h('button', { class: 'btn', onclick: async () => download(`daybook-backup-${stamp}.json`, await backupJSON(), 'application/json') }, 'Full backup'),
      h('button', { class: 'btn', onclick: () => fileIn.click() }, 'Import file'), fileIn),
    h('p', { class: 'small muted' }, 'Backups leave out API keys and Google tokens. Import accepts a Daybook backup (.json) or a daily CSV with a date column.'),
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { await requestPersist(); renderSettings(root); } }, 'Protect storage'), persistInfo),
    h('button', { class: 'btn danger', onclick: async () => {
      if (await confirmDialog('Erase ALL data on this phone? Export a backup first.', 'Erase everything')) { await wipeAll(); location.hash = '#/today'; location.reload(); }
    } }, 'Erase everything'));

  root.replaceChildren(
    h('h2', { class: 'page-title' }, 'Settings'),
    h('section', { class: 'card' },
      h('h3', {}, 'What you track'),
      h('p', { class: 'small muted' }, 'Turn things off rather than deleting them; history is kept either way.'),
      mlist,
      h('button', { class: 'btn primary', onclick: () => editMetric(null) }, '+ Add something to track')),
    aiBox, fbBox, dayBox, dataBox,
    h('p', { class: 'small muted center' }, 'Daybook · everything is stored on this device'));
}
