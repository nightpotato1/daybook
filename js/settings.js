// Settings: what to track (tiers, order, goals), food AI, Fitbit, reminders, day & goals, your data.
import { h, modal, toast, confirmDialog, shareOrDownload, download, ymd } from './util.js';
import { loadMetrics, saveMetrics, loadSettings, saveSettings, GROUPS, TYPES, slug, SYSTEM_IDS, tierOf } from './metrics.js';
import { dailyCSV, foodCSV, importBackup, importDailyCSV, wipeAll, backupNow, backupStatus } from './io.js';
import * as AI from './ai.js';
import { connectHealth, syncHealth, healthConnected, disconnectHealth, redirectUri } from './health.js';
import { requestPersist, db } from './db.js';

const APP_URL = 'https://nightpotato1.github.io/daybook/#/today';
const TIERS = [['core', 'core'], ['event', 'event'], ['more', 'more']];
const SECTIONS = [
  { key: 'core', title: 'Check-in', hint: 'asked every day' },
  { key: 'event', title: 'What happened', hint: 'tap if it happened' },
  { key: 'more', title: 'More', hint: 'folded away on Today' },
  { key: 'auto', title: 'Automatic', hint: 'calculated, never typed' },
  { key: 'off', title: 'Off', hint: 'hidden; history kept' },
];
const CLAUDE_MODELS = [
  ['claude-haiku-5-5', 'Claude Haiku 5.5 (cheapest, recommended)'],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
  ['claude-opus-5-5', 'Claude Opus 5.5'],
];
const GOAL_TYPES = ['count', 'hours', 'minutes', 'money', 'bool', 'scale'];
const STEPPER_TYPES = ['count', 'hours', 'minutes', 'money'];
const GEMINI_LIMIT = AI.GEMINI_DAILY_LIMIT ?? 20;
// Rarely touched sections start folded; the set survives repaints so a row just moved there stays visible.
const FOLDED = new Set(['auto', 'off']);

const sectionOf = (m) => (m.archived ? 'off' : m.derived ? 'auto' : (tierOf(m) || 'event'));
const isSystem = (m) => m.system === true || SYSTEM_IDS.includes(m.id);
const pad = (n) => String(n).padStart(2, '0');

function fmtDate(v) {
  if (!v) return 'never';
  const d = new Date(v);
  return isNaN(d) ? String(v) : ymd(d);
}

function browserName() {
  const brands = (navigator.userAgentData?.brands || []).map((b) => b.brand).filter((b) => !/not.?a.?brand|chromium/i.test(b));
  if (brands.length) return brands[0];
  const ua = navigator.userAgent;
  if (/SamsungBrowser/i.test(ua)) return 'Samsung Internet';
  if (/EdgA?\//.test(ua)) return 'Edge';
  if (/Firefox/i.test(ua)) return 'Firefox';
  if (/Chrome/i.test(ua)) return 'Chrome';
  if (/Safari/i.test(ua)) return 'Safari';
  return 'this browser';
}

function goalLabel(m) {
  const g = m.goal;
  if (!g) return '';
  return `${g.op === '<=' ? '≤' : '≥'} ${g.value}${m.unit ? ' ' + m.unit : ''} / ${g.per}`;
}

// RFC 5545 folding: physical lines of at most 75 octets, continuations start with a space.
function foldICS(line) {
  const enc = new TextEncoder();
  const out = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (bytes + b > 75) { out.push(cur); cur = ' '; bytes = 1; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n');
}

// A daily recurring event with a deep link; the user opens the downloaded file in Google Calendar.
// Stable UID + rising SEQUENCE so re-importing after a time change updates the event instead of adding a second series.
function reminderICS(time) {
  const [hh, mm] = (time || '21:30').split(':').map(Number);
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const day = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Daybook//Reminder//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    'UID:daybook-checkin@nightpotato1.github.io',
    `SEQUENCE:${Math.floor(now.getTime() / 1000)}`,
    `DTSTAMP:${stamp}`,
    `DTSTART;TZID=${tz}:${day}T${pad(hh || 0)}${pad(mm || 0)}00`,
    'DURATION:PT15M',
    'RRULE:FREQ=DAILY',
    'SUMMARY:Daybook check-in',
    `DESCRIPTION:How was today? Open Daybook: ${APP_URL}`,
    `URL:${APP_URL}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Daybook check-in', 'TRIGGER:PT0M', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].map(foldICS).join('\r\n') + '\r\n';
}

export async function renderSettings(root) {
  const settings = await loadSettings();
  let metrics = await loadMetrics();
  const save = async () => { await saveSettings(settings); toast('Saved'); };
  const stamp = ymd(new Date());

  // ================= What you track =================
  const mlist = h('div', { class: 'st-list' });

  // Rebuild the flat metric list from the on-screen section order and persist it.
  const commitOrder = async () => {
    const next = [];
    for (const rows of mlist.querySelectorAll('.st-rows')) for (const row of rows.children) next.push(row._m);
    for (const m of metrics) if (!next.includes(m)) next.push(m);
    metrics = next;
    await saveMetrics(metrics);
  };

  const moveRow = async (row, where) => {
    const rows = row.parentElement;
    if (where === 'top') rows.prepend(row);
    else if (where === -1 && row.previousElementSibling) rows.insertBefore(row, row.previousElementSibling);
    else if (where === 1 && row.nextElementSibling) rows.insertBefore(row.nextElementSibling, row);
    else return;
    await commitOrder();
  };

  const metricRow = (m) => {
    const row = h('div', { class: `st-row${m.archived ? ' st-off' : ''}` });
    row._m = m;
    const sub = [TYPES[m.type] || m.type];
    if (m.group) sub.push(m.group);
    if (m.derived) sub.push('auto');
    if (m.source) sub.push(m.source);
    if (isSystem(m)) sub.push('built-in');
    if (m.goal) sub.push(goalLabel(m));
    // Today's event stage has no clock editor, so time metrics are core or more only.
    const tiers = m.type === 'time' ? TIERS.filter(([v]) => v !== 'event') : TIERS;
    const tierSeg = m.derived ? null : h('div', { class: 'st-seg', role: 'group', 'aria-label': 'Tier' },
      tiers.map(([v, l]) => h('button', { type: 'button', class: tierOf(m) === v ? 'on' : '', 'aria-pressed': String(tierOf(m) === v),
        onclick: async () => { if (tierOf(m) === v) return; m.tier = v; await saveMetrics(metrics); paintMetrics(); } }, l)));
    row.append(
      h('div', { class: 'st-row-main' },
        h('button', { type: 'button', class: 'st-handle', 'aria-label': `Drag to reorder ${m.name}` }, '⋮⋮'),
        h('div', { class: 'st-name' }, h('span', { class: 'st-name-text' }, m.name), h('small', {}, sub.join(' · '))),
        h('button', { type: 'button', class: 'st-icon', 'aria-label': `Edit ${m.name}`, onclick: () => editMetric(m) }, '✎'),
        h('button', { type: 'button', class: `st-switch${m.archived ? '' : ' on'}`, 'aria-pressed': String(!m.archived), onclick: async () => {
          m.archived = !m.archived; if (m.archived) openSections.add('off'); await saveMetrics(metrics); paintMetrics();
        } }, m.archived ? 'off' : 'on')),
      h('div', { class: 'st-row-tools' },
        tierSeg || h('span', { class: 'small muted' }, 'automatic'),
        h('div', { class: 'st-order' },
          h('button', { type: 'button', class: 'st-icon', 'aria-label': 'Move up', onclick: () => moveRow(row, -1) }, '↑'),
          h('button', { type: 'button', class: 'st-icon', 'aria-label': 'Move down', onclick: () => moveRow(row, 1) }, '↓'),
          h('button', { type: 'button', class: 'st-icon', 'aria-label': 'Move to top', onclick: () => moveRow(row, 'top') }, '⤒'))));
    return row;
  };

  const openSections = new Set();
  const paintMetrics = () => {
    mlist.replaceChildren(...SECTIONS.flatMap((s) => {
      const list = metrics.filter((m) => sectionOf(m) === s.key);
      if (!list.length) return [];
      const rows = h('div', { class: 'st-rows' }, list.map(metricRow));
      if (!FOLDED.has(s.key)) return [h('h4', { class: 'st-sec' }, s.title, h('span', {}, ` · ${s.hint}`)), rows];
      return [h('details', { class: 'st-disc st-fold', open: openSections.has(s.key),
        ontoggle: (e) => { if (e.target.open) openSections.add(s.key); else openSections.delete(s.key); } },
        h('summary', {}, h('span', {}, `${s.title} (${list.length})`, h('span', { class: 'muted st-fold-hint' }, ` · ${s.hint}`))),
        rows)];
    }));
  };

  // Drag-to-reorder within a section with pointer events; the handle has touch-action: none.
  let drag = null;
  const placeDragged = () => {
    if (!drag) return;
    const { row, rows, y } = drag;
    let before = null;
    for (const sib of rows.children) {
      if (sib === row) continue;
      const r = sib.getBoundingClientRect();
      if (y < r.top + r.height / 2) { before = sib; break; }
    }
    if (before ? row.nextElementSibling !== before : rows.lastElementChild !== row) rows.insertBefore(row, before);
  };
  const endDrag = async () => {
    if (!drag) return;
    clearInterval(drag.timer);
    drag.row.classList.remove('st-dragging');
    drag = null;
    await commitOrder();
  };
  mlist.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.st-handle');
    if (!handle || drag) return;
    const row = handle.closest('.st-row');
    e.preventDefault();
    try { handle.setPointerCapture(e.pointerId); } catch { /* unsupported: buttons still work */ }
    drag = { row, rows: row.parentElement, y: e.clientY, timer: 0 };
    row.classList.add('st-dragging');
    drag.timer = setInterval(() => {
      if (!drag) return;
      const edge = 72;
      if (drag.y < edge) window.scrollBy(0, -14);
      else if (drag.y > window.innerHeight - edge) window.scrollBy(0, 14);
      placeDragged();
    }, 40);
  });
  mlist.addEventListener('pointermove', (e) => { if (drag) { drag.y = e.clientY; placeDragged(); } });
  mlist.addEventListener('pointerup', endDrag);
  mlist.addEventListener('pointercancel', endDrag);

  async function editMetric(m) {
    const isNew = !m;
    const d = m ? { ...m } : { name: '', type: 'scale', group: 'Other', min: 1, max: 10, step: 1, polarity: 1 };
    const locked = !!(m && (m.derived || isSystem(m)));
    const g = d.goal || {};
    const f = {
      name: h('input', { type: 'text', value: d.name, maxlength: 40 }),
      type: h('select', { disabled: locked }, Object.entries(TYPES).map(([k, l]) => h('option', { value: k, selected: d.type === k }, l))),
      group: h('select', {}, GROUPS.map((x) => h('option', { value: x, selected: d.group === x }, x))),
      min: h('input', { type: 'number', value: d.min ?? 1, min: 0, max: 9, step: 1, inputmode: 'numeric' }),
      max: h('input', { type: 'number', value: d.max ?? 10, min: 1, max: 10, step: 1, inputmode: 'numeric' }),
      scaleStep: h('select', {}, [[1, '1'], [0.5, '0.5 (half points)']].map(([v, l]) => h('option', { value: v, selected: Number(d.step) === v }, l))),
      step: h('input', { type: 'number', value: d.step ?? '', step: 'any', min: 0, placeholder: 'default', inputmode: 'decimal' }),
      unit: h('input', { type: 'text', value: d.unit || '', maxlength: 12 }),
      polarity: h('select', {}, [[1, 'More is better'], [0, 'Neutral'], [-1, 'Less is better']].map(([v, l]) => h('option', { value: v, selected: Number(d.polarity) === v }, l))),
      goalPer: h('select', {}, [['', 'No goal'], ['day', 'Per day'], ['week', 'Per week']].map(([v, l]) => h('option', { value: v, selected: (g.per || '') === v }, l))),
      goalOp: h('select', {}, [['>=', 'at least'], ['<=', 'at most']].map(([v, l]) => h('option', { value: v, selected: (g.op || '>=') === v }, l))),
      goalValue: h('input', { type: 'number', value: g.value ?? '', step: 'any', min: 0, inputmode: 'decimal' }),
    };
    const scaleBox = h('div', { class: 'st-grid3' },
      h('label', {}, 'Scale from', f.min), h('label', {}, 'to', f.max), h('label', {}, 'Step', f.scaleStep));
    const stepBox = h('label', {}, 'Stepper +/− step', f.step);
    const goalBox = h('div', {},
      h('div', { class: 'st-grid3' }, h('label', {}, 'Goal', f.goalPer), h('label', {}, 'Rule', f.goalOp), h('label', {}, 'Value', f.goalValue)),
      h('p', { class: 'small muted' }, 'Weekly goals add up counts, hours, minutes and yes/no days Monday to today and average scales.'));
    const syncType = () => {
      const t = f.type.value;
      scaleBox.classList.toggle('hidden', t !== 'scale');
      stepBox.classList.toggle('hidden', !STEPPER_TYPES.includes(t));
      goalBox.classList.toggle('hidden', !GOAL_TYPES.includes(t));
    };
    f.type.addEventListener('change', syncType);
    syncType();
    const body = h('div', { class: 'st-form' },
      h('label', {}, 'Name', f.name),
      h('label', {}, 'Type', f.type),
      locked ? h('p', { class: 'small muted' }, m.derived ? 'Calculated automatically; the type is fixed.' : 'Built in: the app depends on this one, so it can be turned off but not deleted.') : null,
      h('label', {}, 'Group (Trends and Insights)', f.group),
      scaleBox, stepBox,
      h('label', {}, 'Unit (shown after the value)', f.unit),
      h('label', {}, 'Direction (colours charts)', f.polarity),
      goalBox);
    const actions = [
      m && !locked ? { label: 'Delete', value: 'delete' } : null,
      { label: 'Save', value: 'save', primary: true }].filter(Boolean);
    let ok;
    for (;;) {
      ok = await modal(isNew ? 'New thing to track' : 'Edit', body, actions);
      if (ok === 'save' && !f.name.value.trim()) { toast('Give it a name'); setTimeout(() => f.name.focus(), 50); continue; }
      break;
    }
    if (ok === 'delete') {
      if (await confirmDialog(`Delete "${d.name}"? Logged values stay in your days but stop showing. Turning it off is usually better.`, 'Delete')) {
        metrics.splice(metrics.indexOf(m), 1); await saveMetrics(metrics); paintMetrics();
      }
      return;
    }
    if (ok !== 'save') return;
    const type = f.type.value;
    Object.assign(d, {
      name: f.name.value.trim(), type, group: f.group.value, unit: f.unit.value.trim() || undefined,
      polarity: Number(f.polarity.value),
    });
    if (type === 'scale') {
      const min = Math.max(0, Math.min(9, Math.round(Number(f.min.value) || 0)));
      d.min = min;
      d.max = Math.max(min + 1, Math.min(10, Math.round(Number(f.max.value) || 10)));
      d.step = Number(f.scaleStep.value) === 0.5 ? 0.5 : 1;
    } else {
      delete d.min; delete d.max;
      const st = Number(f.step.value);
      if (STEPPER_TYPES.includes(type) && st > 0) d.step = st; else delete d.step;
    }
    if (type === 'time' && d.tier === 'event') d.tier = 'more';
    const gv = Number(f.goalValue.value);
    if (GOAL_TYPES.includes(type) && f.goalPer.value && f.goalValue.value !== '' && gv >= 0) d.goal = { per: f.goalPer.value, op: f.goalOp.value, value: gv };
    else delete d.goal;
    for (const k of Object.keys(d)) if (d[k] === undefined) delete d[k];
    if (isNew) {
      d.id = slug(d.name);
      while (metrics.some((x) => x.id === d.id)) d.id += '_';
      d.tier = type === 'bool' || STEPPER_TYPES.includes(type) || (type === 'scale' && d.min === 0) ? 'event' : 'more';
      metrics.push(d);
    } else {
      for (const k of ['min', 'max', 'step', 'unit', 'goal']) if (!(k in d)) delete m[k];
      Object.assign(m, d);
    }
    await saveMetrics(metrics); paintMetrics();
  }
  paintMetrics();

  const trackBox = h('section', { class: 'card st-card' },
    h('h3', {}, 'What you track'),
    h('p', { class: 'small muted' }, 'core = asked every day · event = tap if it happened · more = folded away. Drag the handle to reorder. Turn things off rather than deleting them; history is kept either way.'),
    mlist,
    h('button', { class: 'btn primary wide', onclick: () => editMetric(null) }, '+ Add something to track'));

  // ================= Food photo AI =================
  const ai = settings.ai;
  const aiStatus = h('small', { class: 'muted st-status-line' });
  const usage = h('small', { class: 'muted' });
  Promise.resolve().then(() => AI.aiCallsToday()).then((r) => {
    const n = typeof r === 'number' ? r : (r && typeof r === 'object' ? r.n : 0) || 0;
    usage.textContent = `${n}/${GEMINI_LIMIT} used today`;
  }).catch(() => { usage.textContent = ''; });
  const modelList = h('datalist', { id: 'st-gemini-models' });
  const modelStatus = h('small', { class: 'muted st-status-line' });
  const claudeOptions = CLAUDE_MODELS.some(([v]) => v === ai.claudeModel) || !ai.claudeModel ? CLAUDE_MODELS : [...CLAUDE_MODELS, [ai.claudeModel, ai.claudeModel]];
  const claudeDisc = h('details', { class: 'st-disc', open: ai.provider === 'claude' },
    h('summary', {}, 'Other provider: Claude (paid, about $0.0003 a photo)'),
    h('label', {}, 'Claude API key', h('input', { type: 'password', value: ai.claudeKey || '', autocomplete: 'off', onchange: (e) => { ai.claudeKey = e.target.value.trim(); save(); } })),
    h('label', {}, 'Claude model', h('select', { onchange: (e) => { ai.claudeModel = e.target.value; save(); } },
      claudeOptions.map(([v, l]) => h('option', { value: v, selected: (ai.claudeModel || 'claude-haiku-5-5') === v }, l)))));
  const aiBox = h('section', { class: 'card st-card' },
    h('h3', {}, 'Food photo AI'),
    h('label', {}, 'Estimates from', h('select', { onchange: (e) => { ai.provider = e.target.value; if (ai.provider === 'claude') claudeDisc.open = true; save(); } },
      [['gemini', 'Google Gemini (free key)'], ['claude', 'Claude (paid key)'], ['none', 'Off: type the numbers yourself']].map(([v, l]) => h('option', { value: v, selected: ai.provider === v }, l)))),
    h('p', { class: 'small muted' }, 'Keys stay on this phone. Only the food photo and your food text are sent, only when you press Estimate. Free Gemini key: get one at ',
      h('a', { href: 'https://aistudio.google.com/apikey', target: '_blank', rel: 'noopener' }, 'aistudio.google.com/apikey'),
      ` and paste it here; about ${GEMINI_LIMIT} estimates a day.`),
    h('label', {}, h('span', { class: 'st-between' }, 'Gemini API key', usage),
      h('input', { type: 'password', value: ai.geminiKey || '', autocomplete: 'off', onchange: (e) => { ai.geminiKey = e.target.value.trim(); save(); } })),
    h('label', {}, 'Gemini model', h('input', { type: 'text', value: ai.geminiModel || '', list: 'st-gemini-models', onchange: (e) => { ai.geminiModel = e.target.value.trim(); save(); } })),
    modelList,
    h('button', { class: 'btn', onclick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      modelStatus.textContent = 'Loading…';
      try {
        const names = await AI.listGeminiModels(ai.geminiKey);
        modelList.replaceChildren(...names.map((n) => h('option', { value: n })));
        modelStatus.textContent = `${names.length} models loaded: tap the model box to pick one`;
      } catch (err) {
        modelStatus.textContent = '';
        toast(err.message || 'Could not load models', 4000);
      }
      btn.disabled = false;
    } }, 'Load Gemini model list'),
    modelStatus,
    h('label', {}, 'My usual foods and measures (sent with every estimate)',
      h('textarea', { rows: 3, placeholder: 'e.g. my dal is 1 cup cooked with 1 tsp ghee; chai = 150 ml whole milk, 1 tsp sugar',
        onchange: (e) => { ai.foodContext = e.target.value.trim(); save(); } }, ai.foodContext || '')),
    claudeDisc,
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => {
      aiStatus.textContent = 'Testing…';
      try { aiStatus.textContent = await AI.testAI(settings); } catch (e) { aiStatus.textContent = e.message || 'Test failed'; }
    } }, 'Test (free)'), aiStatus));

  // ================= Fitbit via Google Health API =================
  const hs = settings.health;
  const fbStatus = h('div', { class: 'small st-status-line' });
  const fbButtons = h('div', { class: 'row' });
  const paintHealth = () => {
    const on = healthConnected(settings);
    const lines = [];
    if (!on) lines.push(h('span', { class: 'muted' }, 'Not connected'));
    else if (hs.linked === false) lines.push(h('span', { class: 'bad' }, 'Connected, but this Google account has no Google Health profile: open the Google Health app, sign in with the same Google account, then press Sync.'));
    else lines.push(h('span', { class: 'good' }, `Connected${hs.linked ? ' and linked' : ''}${hs.lastSync ? `, last sync ${hs.lastSync}` : ''}`));
    if (hs.lastError) lines.push(h('span', { class: 'bad' }, `Last error: ${hs.lastError}`));
    fbStatus.replaceChildren(...lines.flatMap((l, i) => (i ? [h('br'), l] : [l])));
    fbButtons.replaceChildren(...(on
      ? [h('button', { class: 'btn primary', onclick: () => runSync() }, 'Sync now'),
        h('button', { class: 'btn', onclick: () => runSync(90) }, 'Backfill 90d'),
        h('button', { class: 'btn', onclick: async () => {
          try { await disconnectHealth(settings); } catch (e) { toast(e.message || 'Disconnect failed', 4000); }
          await refreshHealth();
        } }, 'Disconnect')]
      : [h('button', { class: 'btn primary', onclick: () => connectHealth().catch((e) => {
          paintHealth();
          fbStatus.prepend(h('span', { class: 'bad' }, e.message || 'Could not start sign-in'), h('br'));
        }) }, 'Connect')]));
  };
  // health.js saves its own copy of settings and disconnectHealth replaces settings.health with a new object:
  // pull the stored state back into the one object the inputs write to and re-point settings.health at it.
  const refreshHealth = async () => {
    let fresh = settings.health;
    try { fresh = (await loadSettings()).health || fresh; } catch { /* keep what we have */ }
    if (fresh && fresh !== hs) Object.assign(hs, fresh);
    settings.health = hs;
    paintHealth();
  };
  const runSync = async (days) => {
    fbStatus.textContent = 'Syncing…';
    try {
      const r = await syncHealth(days);
      await refreshHealth();
      fbStatus.prepend(h('span', {}, `Synced ${r.days} days (${r.start} → ${r.end})${r.errors?.length ? `. Partly failed: ${r.errors.join('; ')}` : ''}`), h('br'));
    } catch (e) {
      await refreshHealth();
      if (!hs.lastError) fbStatus.prepend(h('span', { class: 'bad' }, e.message || 'Sync failed'), h('br'));
    }
  };
  paintHealth();
  const fbBox = h('section', { class: 'card st-card' },
    h('h3', {}, 'Fitbit (Google Health)'),
    h('p', { class: 'small muted' }, "Pulls steps, sleep and resting heart rate through Google's Health API (Fitbit's own API shut down 2026-11-02). Setup steps: docs/SETUP-health.md in the project folder on your PC."),
    h('details', { class: 'st-disc', open: !healthConnected(settings) },
      h('summary', {}, 'Step 0: check before connecting'),
      h('ol', { class: 'small muted st-ol' },
        h('li', {}, 'Is the tracker supported? Zip, One, Flex, Charge, Charge HR, Surge and Ace are not visible to the API. Resting heart rate needs Alta HR, Charge 2 or newer, or Inspire HR or newer.'),
        h('li', {}, 'Was the Fitbit account moved to a Google account before 2026-05-19? If not, the old account and its history are gone: pair the tracker fresh in the Google Health app, and only new data will exist.'),
        h('li', {}, 'Does the tracker sync in the Google Health app on this phone? If nothing shows there, the API returns nothing either.'))),
    h('p', { class: 'small muted' }, 'Authorized redirect URI for the OAuth client:'),
    h('code', { class: 'copy' }, redirectUri()),
    h('label', {}, 'OAuth client ID', h('input', { type: 'text', value: hs.clientId || '', autocomplete: 'off', onchange: (e) => { hs.clientId = e.target.value.trim(); save(); } })),
    h('label', {}, 'OAuth client secret', h('input', { type: 'password', value: hs.clientSecret || '', autocomplete: 'off', onchange: (e) => { hs.clientSecret = e.target.value.trim(); save(); } })),
    fbButtons, fbStatus);

  // ================= Reminders =================
  const remBox = h('section', { class: 'card st-card' },
    h('h3', {}, 'Reminders'),
    h('p', { class: 'small muted' }, 'The app cannot ring on its own, so the reminder lives in your calendar or clock and opens Daybook with one tap.'),
    h('label', {}, 'Check-in time', h('input', { type: 'time', value: settings.reminderTime || '21:30', onchange: (e) => { settings.reminderTime = e.target.value || '21:30'; save(); } })),
    h('button', { class: 'btn primary wide', onclick: () => download('daybook-reminder.ics', reminderICS(settings.reminderTime), 'text/calendar') }, 'Add daily reminder to calendar'),
    h('p', { class: 'small muted' }, 'Downloads daybook-reminder.ics: tap Open on the download bar (or the file in Downloads), pick Google Calendar and save. The event repeats daily with a notification and opens Daybook.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => shareOrDownload('daybook-reminder.ics', reminderICS(settings.reminderTime), 'text/calendar') }, 'Share .ics instead'),
      h('small', { class: 'muted' }, 'if a calendar app is in the share sheet')),
    h('p', { class: 'small muted' }, 'Or: Samsung Clock → alarm named Daybook.'));

  // ================= Day & goals =================
  const dayBox = h('section', { class: 'card st-card' },
    h('h3', {}, 'Day & goals'),
    h('label', {}, 'A new day starts at', h('select', { onchange: (e) => { settings.dayStartHour = Number(e.target.value); save(); } },
      [0, 2, 3, 4, 5, 6].map((v) => h('option', { value: v, selected: Number(settings.dayStartHour) === v }, `${v}:00${v === 0 ? ' (midnight)' : ''}`)))),
    h('div', { class: 'st-grid2' },
      h('label', {}, 'Daily calories (0 = none)', h('input', { type: 'number', min: 0, inputmode: 'numeric', value: settings.kcalGoal || 0, onchange: (e) => { settings.kcalGoal = Math.max(0, Number(e.target.value) || 0); save(); } })),
      h('label', {}, 'Daily protein, g (0 = none)', h('input', { type: 'number', min: 0, inputmode: 'numeric', value: settings.proteinGoal || 0, onchange: (e) => { settings.proteinGoal = Math.max(0, Number(e.target.value) || 0); save(); } }))),
    h('label', {}, 'Life goals (shown at the top of Insights)',
      h('textarea', { rows: 4, placeholder: 'What you are tracking all this for.', onchange: (e) => { settings.goalsText = e.target.value.trim(); save(); } }, settings.goalsText || '')));

  // ================= Your data =================
  const status = h('div', { class: 'st-statusbox' }, h('small', { class: 'muted' }, 'Checking storage…'));
  const persistRow = h('div', {});
  const paintStatus = async () => {
    let bs = {};
    try { bs = (await backupStatus()) || {}; } catch (e) { bs = {}; }
    let persisted = bs.persisted;
    if (persisted == null) { try { persisted = await navigator.storage?.persisted?.(); } catch { persisted = undefined; } }
    let used = '';
    try { const est = await navigator.storage?.estimate?.(); if (est?.usage != null) used = `${(est.usage / 1048576).toFixed(1)} MB`; } catch { /* unsupported */ }
    let photos = null;
    try { photos = await db.tx(['photos'], 'readonly', (t) => db.wrap(t.objectStore('photos').count())); } catch { /* leave unknown */ }
    const installed = matchMedia('(display-mode: standalone)').matches;
    const line = (k, v) => h('div', { class: 'st-stat' }, h('span', { class: 'muted' }, k), h('b', {}, v));
    status.replaceChildren(
      line('Data lives in', `${browserName()} on this phone${installed ? ', installed as an app' : ' (not installed as an app)'}`),
      line('Protected from automatic clearing', persisted == null ? 'unknown' : persisted ? 'yes' : 'no'),
      line('Storage used', used || 'unknown'),
      line('Records', `${bs.days ?? '?'} days · ${bs.food ?? '?'} food entries · ${photos ?? '?'} photos`),
      line('Last backup', bs.lastBackupAt ? `${fmtDate(bs.lastBackupAt)}${bs.newSinceBackup ? ` · ${bs.newSinceBackup} new since` : ''}` : 'never'));
    persistRow.replaceChildren(persisted ? h('p', { class: 'small muted' }, 'Storage is protected against Chrome freeing space automatically. It does NOT protect against Clear browsing data or uninstalling. Keep a backup.')
      : h('div', {},
        h('button', { class: 'btn', onclick: async () => { const ok = await requestPersist(); toast(ok ? 'Storage protected' : 'Chrome refused for now; install the app and try again', 3500); paintStatus(); } }, 'Protect storage'),
        h('p', { class: 'small muted' }, 'Protects against Chrome freeing space automatically. Does NOT protect against Clear browsing data or uninstalling. Keep a backup.')));
  };
  paintStatus();
  const fileIn = h('input', { type: 'file', accept: '.json,.csv,application/json,text/csv', class: 'hidden', onchange: async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      if (/\.csv$/i.test(f.name) || (!/\.json$/i.test(f.name) && !text.trimStart().startsWith('{'))) {
        const r = await importDailyCSV(text);
        const unknown = r.unknownColumns || [];
        toast(`Imported ${r.days} days${unknown.length ? `. Not imported (no such metric): ${unknown.join(', ')}` : ''}`, unknown.length ? 7000 : 3500);
      } else {
        const r = await importBackup(text);
        toast(`Imported ${r.days} days, ${r.food || 0} food entries, ${r.metrics || 0} metrics, ${r.photos || 0} photos`, 4000);
      }
      renderSettings(root);
    } catch (err) { toast(`Import failed: ${err.message}`, 6000); }
    e.target.value = '';
  } });
  const dataBox = h('section', { class: 'card st-card' },
    h('h3', {}, 'Your data'),
    status,
    h('div', { class: 'btn-grid' },
      h('button', { class: 'btn primary', onclick: async () => { try { await backupNow(); } catch (e) { toast(e.message || 'Backup failed', 4000); } paintStatus(); } }, 'Back up now'),
      h('button', { class: 'btn', onclick: () => fileIn.click() }, 'Import file'),
      h('button', { class: 'btn', onclick: async () => shareOrDownload(`daybook-daily-${stamp}.csv`, await dailyCSV()) }, 'Daily CSV'),
      h('button', { class: 'btn', onclick: async () => shareOrDownload(`daybook-food-${stamp}.csv`, await foodCSV()) }, 'Food CSV'),
      fileIn),
    h('p', { class: 'small muted' }, 'Backup = everything including photos, minus keys and tokens; send it to Drive from the share sheet. Import takes a Daybook backup (.json) or the daily CSV. ',
      h('a', { href: '#/about' }, 'How this works')),
    persistRow,
    h('button', { class: 'btn danger wide', onclick: async () => {
      if (await confirmDialog('Erase ALL data on this phone? Back up first.', 'Erase everything')) { await wipeAll(); location.hash = '#/today'; location.reload(); }
    } }, 'Erase everything'));

  root.replaceChildren(
    h('h2', { class: 'page-title' }, 'Settings'),
    dataBox, trackBox, aiBox, fbBox, remBox, dayBox,
    h('p', { class: 'small muted center' }, 'Daybook · everything is stored on this phone'));
}
