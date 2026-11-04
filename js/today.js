// Daily entry screen, two stages: "Check-in" (core metrics + a title) and "What happened"
// (a chip grid of event metrics; untouched chips cost nothing). Stored data stays blank
// when nothing was entered; zeros for blank event metrics on checked-in days are derived
// at read time by resolveValues, never written here.
import { h, addDays, parseYmd, ymd, prettyDate, logicalToday, minsToClock, clockToMins, fmtNum, debounce, toast } from './util.js';
import { getDay, saveDay, db } from './db.js';
import { loadMetrics, activeMetrics, loadSettings, resolveValues, numericValue, tierOf, isCheckedIn, scaleValues } from './metrics.js';
import { foodTotals, loadSeries, weeklyGoalProgress } from './data.js';
import { aiReady } from './ai.js';

const SAVE_MS = 250;
const LONG_PRESS_MS = 550;

// The flush of whichever day is currently on screen, so unload can commit pending edits.
let activeFlush = null;
const flushActive = () => { if (activeFlush) activeFlush(); };
window.addEventListener('pagehide', flushActive);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushActive(); });

let moreOpen = false;
try { moreOpen = localStorage.getItem('todayMore') === '1'; } catch {}

export async function renderToday(root, date) {
  flushActive();
  const settings = await loadSettings();
  const today = logicalToday(settings.dayStartHour);
  date = date || today;
  const metrics = activeMetrics(await loadMetrics());
  const day = await getDay(date);
  if (!day.values) day.values = {};
  if (!day.src) day.src = {};
  const food = await db.byIndex('food', 'date', date);
  const ft = foodTotals(food);
  // Earlier records: last values, medians, recent titles, missed days.
  const lo = addDays(date < today ? date : today, -30);
  const recent = (await db.range('days', lo, today)).filter((r) => r.date !== date);
  const before = recent.filter((r) => r.date < date).reverse(); // newest first
  const yearAgo = await db.get('days', yearAgoOf(date));

  const goalMetrics = metrics.filter((m) => m.goal && !m.archived);
  let series = null; // loaded after first paint; paintWeek() is a no-op until then

  // ---- saving ----
  let dirty = false;
  const flush = async () => {
    if (!dirty) return;
    dirty = false;
    try { await saveDay(day); }
    catch (e) { dirty = true; toast(`Not saved: ${e && e.message ? e.message : e}`, 4000); }
  };
  const persist = debounce(flush, SAVE_MS);
  activeFlush = flush;
  const markDirty = () => {
    if (!day.loggedAt) day.loggedAt = Date.now();
    dirty = true;
    persist();
  };
  const setVal = (id, val) => {
    if (val == null || val === '') delete day.values[id];
    else day.values[id] = val;
    delete day.src[id];
    markDirty();
    afterChange(id);
  };

  const go = (d) => { location.hash = `#/today/${d}`; };
  const entryMetrics = metrics.filter((m) => !m.derived);
  const coreMetrics = entryMetrics.filter((m) => tierOf(m) === 'core');
  const eventMetrics = entryMetrics.filter((m) => tierOf(m) === 'event');
  const moreMetrics = entryMetrics.filter((m) => tierOf(m) === 'more');
  const derivedMetrics = metrics.filter((m) => m.derived);

  // ---- header: ‹ date › with a native date picker over the title ----
  const datePick = h('input', { type: 'date', value: date, max: today, 'aria-label': 'Pick a day',
    onchange: (e) => { if (e.target.value && e.target.value <= today) go(e.target.value); } });
  const header = h('header', { class: 'day-head' },
    h('button', { class: 'icon-btn', onclick: () => go(addDays(date, -1)), 'aria-label': 'Previous day' }, '‹'),
    h('div', { class: 'day-title' },
      h('h2', {}, date === today ? 'Today' : date === addDays(today, -1) ? 'Yesterday' : prettyDate(date)),
      h('small', {}, prettyDate(date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })),
      datePick),
    h('button', { class: 'icon-btn', onclick: () => go(addDays(date, 1)), disabled: date >= today, 'aria-label': 'Next day' }, '›'));

  // Missed days in the last week (relative to today) and copy-yesterday.
  const byDate = new Map(recent.map((r) => [r.date, r]));
  const missed = [];
  const everLogged = isCheckedIn(day, metrics) || recent.some((r) => isCheckedIn(r, metrics));
  for (let i = everLogged && date === today ? 7 : 0; i >= 1; i--) {
    const d = addDays(today, -i);
    if (d === date) continue;
    const r = byDate.get(d);
    if (!r || !isCheckedIn(r, metrics)) missed.push(d);
  }
  const yesterday = byDate.get(addDays(date, -1));
  const copyable = yesterday ? eventMetrics.filter((m) => yesterday.values && yesterday.values[m.id] != null) : [];
  const strip = (missed.length || copyable.length) ? h('div', { class: 'day-tools' },
    missed.length ? h('div', { class: 'missed' }, h('small', { class: 'muted' }, 'Missed: '),
      missed.map((d) => h('button', { class: 'chip small', onclick: () => go(d) }, prettyDate(d, { weekday: 'short' })))) : h('span', { class: 'grow' }),
    copyable.length ? h('button', { class: 'chip small', onclick: () => {
      let n = 0;
      for (const m of copyable) {
        if (day.values[m.id] != null) continue;
        day.values[m.id] = yesterday.values[m.id];
        delete day.src[m.id];
        n++;
      }
      if (!n) { toast('Nothing to copy: today already has those values'); return; }
      markDirty();
      flush().then(() => renderToday(root, date));
      toast(`Copied ${n} value${n === 1 ? '' : 's'} from yesterday`);
    } }, 'Copy yesterday') : null) : null;

  // ---- repaint plumbing ----
  const derivedEls = new Map();   // metric id -> value element
  const chipPaint = new Map();    // metric id -> fn
  const checkMark = h('span', { class: 'check-mark', 'aria-label': 'Checked in' }, '✓');
  const weekBody = h('div', { class: 'week-rows' });
  const weekCard = h('section', { class: 'card week-card hidden' }, h('h3', {}, 'This week'), weekBody);

  function paintDerived() {
    const rv = resolveValues(day, metrics, ft);
    for (const [id, el] of derivedEls) {
      const m = metrics.find((x) => x.id === id);
      const v = rv[id];
      el.textContent = m.type === 'bool' ? (v == null ? '–' : v ? 'yes' : 'no') : v == null ? '–' : `${fmtNum(v)}${m.unit ? ` ${m.unit}` : ''}`;
    }
    checkMark.classList.toggle('hidden', !isCheckedIn(day, metrics));
  }
  function paintWeek() {
    if (!series) return;
    let entry = series.find((s) => s.date === date);
    if (!entry) {
      entry = { date, v: {}, day, checkedIn: false };
      const i = series.findIndex((s) => s.date > date);
      if (i < 0) series.push(entry); else series.splice(i, 0, entry);
    }
    entry.day = day;
    entry.checkedIn = isCheckedIn(day, metrics);
    const raw = resolveValues(day, metrics, ft);
    entry.v = {};
    for (const m of metrics) entry.v[m.id] = numericValue(m, raw[m.id]);
    const rows = weeklyGoalProgress(series, metrics, date);
    weekCard.classList.toggle('hidden', !rows.length);
    weekBody.replaceChildren(...rows.map((r) => h('div', { class: `week-row${r.met ? ' met' : ''}` },
      h('span', { class: 'grow' }, r.metric.name),
      h('span', { class: 'week-label' }, r.label, r.met ? ' ✓' : ''))));
  }
  function afterChange(id) {
    paintDerived();
    paintWeek();
    const p = chipPaint.get(id);
    if (p) p();
  }

  // ---- stage 1: check-in ----
  const titleField = h('input', { type: 'text', value: day.title || '', placeholder: 'One line about today',
    oninput: (e) => { day.title = e.target.value; markDirty(); } });
  const titles = [];
  for (const r of before) {
    const t = (r.title || '').trim();
    if (t && t !== (day.title || '').trim() && !titles.includes(t)) titles.push(t);
    if (titles.length >= 3) break;
  }
  const checkin = h('section', { class: 'card checkin' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Check-in'), checkMark),
    coreMetrics.length ? coreMetrics.map((m) => metricRow(m)) : h('p', { class: 'muted small' }, 'No core metrics. Mark some as core in Settings.'),
    h('div', { class: 'title-row' },
      titleField,
      titles.length ? h('div', { class: 'title-suggest' },
        titles.map((t) => h('button', { class: 'chip small', onclick: () => { titleField.value = t; day.title = t; markDirty(); } }, t))) : null));

  // ---- stage 2: what happened (chip grid + inline editor) ----
  const grid = h('div', { class: 'chips' });
  const editorSlot = h('div', { class: 'chip-editor-slot' });
  let editing = null;
  const closeEditor = () => { editing = null; editorSlot.replaceChildren(); grid.querySelectorAll('.chip.editing').forEach((c) => c.classList.remove('editing')); };
  function openEditor(m, chip) {
    if (editing === m.id) { closeEditor(); return; }
    closeEditor();
    editing = m.id;
    chip.classList.add('editing');
    editorSlot.replaceChildren(chipEditor(m));
  }
  for (const m of eventMetrics) {
    const chip = h('button', { class: 'chip' });
    const paint = () => {
      const v = day.values[m.id];
      const isOn = v != null && (m.type === 'text' ? String(v).trim() !== '' : Number(v) !== 0);
      chip.className = `chip${isOn ? ' on' : v != null ? ' zero' : ''}${editing === m.id ? ' editing' : ''}`;
      chip.replaceChildren(m.name);
      if (v != null) chip.append(h('b', {}, chipValue(m, v)));
    };
    chipPaint.set(m.id, paint);
    paint();
    longPress(chip, () => {
      if (day.values[m.id] == null) return;
      setVal(m.id, null);
      if (editing === m.id) closeEditor();
      toast(`${m.name} cleared`);
    }, () => {
      if (m.type === 'bool') { setVal(m.id, day.values[m.id] ? null : 1); return; }
      openEditor(m, chip);
    });
    grid.append(chip);
  }
  const happened = h('section', { class: 'card happened' },
    h('div', { class: 'card-head' }, h('h3', {}, 'What happened'), h('small', { class: 'muted' }, 'tap · hold to clear')),
    eventMetrics.length ? grid : h('p', { class: 'muted small' }, 'No event metrics yet. Add some in Settings.'),
    editorSlot);

  function chipEditor(m) {
    const cur = () => day.values[m.id];
    const shown = h('span', { class: 'mval' });
    const head = h('div', { class: 'ed-head' }, h('b', {}, m.name), m.unit && m.type !== 'scale' && m.type !== 'time' ? h('small', { class: 'muted' }, ` ${m.unit}`) : null, shown, h('span', { class: 'grow' }),
      h('button', { class: 'btn small', onclick: () => { setVal(m.id, null); closeEditor(); } }, 'Clear'),
      h('button', { class: 'btn small primary', onclick: closeEditor }, 'Done'));
    const last = lastValue(before, m.id);
    const lastChip = last != null ? h('button', { class: 'chip small', onclick: () => { setVal(m.id, last); closeEditor(); } }, `last: ${chipValue(m, last)}`) : null;
    let body;
    if (m.type === 'scale') body = scaleControl(m, cur(), (v) => setVal(m.id, v), shown);
    else if (m.type === 'time') body = timeControl(m, cur(), (v) => setVal(m.id, v), shown);
    else if (m.type === 'text') body = h('input', { type: 'text', value: cur() || '', placeholder: m.name,
      oninput: debounce((e) => setVal(m.id, e.target.value.trim() || null), 300) });
    else {
      const presets = m.type === 'hours' ? [0.5, 1, 2, 4] : m.type === 'minutes' ? [15, 30, 60] : m.type === 'money' ? [5, 10, 20, 50] : [1, 2, 3, 5];
      body = h('div', { class: 'ed-body' },
        h('div', { class: 'presets' },
          presets.map((p) => h('button', { class: `chip small${cur() === p ? ' on' : ''}`, onclick: () => { setVal(m.id, p); closeEditor(); } }, chipValue(m, p))),
          lastChip),
        stepper(m, cur(), (v) => setVal(m.id, v)));
      return h('div', { class: 'chip-editor' }, head, body);
    }
    return h('div', { class: 'chip-editor' }, head, body, lastChip ? h('div', { class: 'presets' }, lastChip) : null);
  }

  // ---- food ----
  const foodCard = h('section', { class: 'card food-card' },
    h('div', { class: 'food-head' },
      h('h3', {}, 'Food'),
      h('div', { class: 'food-totals' },
        h('b', {}, ft.n ? fmtNum(ft.kcal, 0) : '–'), h('small', {}, ' kcal  '),
        h('b', {}, ft.n ? fmtNum(ft.protein, 0) : '–'), h('small', {}, ' g protein'),
        ft.n ? h('small', {}, `  · ${ft.n} ${ft.n === 1 ? 'entry' : 'entries'}`) : null)),
    h('div', { class: 'food-actions' },
      aiReady(settings)
        ? h('a', { class: 'btn primary', href: `#/food/${date}/photo` }, '📷 Photo')
        : h('a', { class: 'btn primary setup', href: '#/settings' }, 'Set up free photo estimates'),
      h('a', { class: 'btn', href: `#/food/${date}/add` }, '+ Add'),
      h('a', { class: 'btn', href: `#/food/${date}` }, 'Log')));

  // ---- notes ----
  const yearFull = yearAgo ? [yearAgo.title, yearAgo.gratitude, yearAgo.note].map((t) => (t || '').trim()).filter(Boolean).join(' · ') : '';
  const yearText = yearFull.length > 140 ? `${yearFull.slice(0, 139)}…` : yearFull;
  const notes = h('section', { class: 'card notes' },
    h('h3', {}, 'Notes'),
    h('label', {}, 'Grateful for',
      h('textarea', { rows: 2, placeholder: 'One thing is enough', oninput: (e) => { day.gratitude = e.target.value; markDirty(); afterChange('gratitude'); } }, day.gratitude || '')),
    h('label', {}, 'Journal',
      h('textarea', { rows: 4, placeholder: 'Anything else', oninput: (e) => { day.note = e.target.value; markDirty(); } }, day.note || '')),
    yearText ? h('a', { class: 'year-ago', href: `#/today/${yearAgoOf(date)}` }, h('small', { class: 'muted' }, 'One year ago: '), h('small', {}, yearText)) : null);

  // ---- more: times, device metrics, derived rows ----
  const more = h('details', { class: 'card more', open: moreOpen || undefined },
    h('summary', {}, h('span', {}, 'More')),
    moreMetrics.map((m) => metricRow(m)),
    derivedMetrics.map((m) => {
      const val = h('span', { class: 'derived-val' });
      derivedEls.set(m.id, val);
      return h('div', { class: 'mrow derived' }, h('div', { class: 'mlabel' }, m.name), h('div', {}, val, h('small', { class: 'muted' }, ' auto')));
    }));
  more.addEventListener('toggle', () => { moreOpen = more.open; try { localStorage.setItem('todayMore', moreOpen ? '1' : '0'); } catch {} });

  paintDerived();
  root.replaceChildren(...[header, strip, checkin, happened, weekCard, foodCard, notes, more].filter(Boolean));
  if (goalMetrics.length) loadSeries(metrics).then((s) => { series = s; paintWeek(); }).catch(() => {});

  // ---- row controls (check-in and More) ----
  function metricRow(m) {
    const val = day.values[m.id];
    const badge = day.src[m.id] ? h('span', { class: 'badge' }, day.src[m.id]) : null;
    const shown = h('span', { class: 'mval' });
    const label = h('div', { class: 'mlabel' }, m.name, badge, m.unit && m.type !== 'scale' && m.type !== 'time' ? h('small', { class: 'muted' }, ` ${m.unit}`) : null, shown);
    const set = (v) => { setVal(m.id, v); if (badge) badge.remove(); };
    switch (m.type) {
      case 'scale':
        return h('div', { class: 'mrow scale-row' }, label, scaleControl(m, val, set, shown));
      case 'time':
        return h('div', { class: 'mrow time-row' }, label, timeControl(m, val, set, shown));
      case 'bool': {
        const chip = h('button', { class: `chip${val ? ' on' : ''}`, onclick: () => { const nv = day.values[m.id] ? null : 1; set(nv); chip.classList.toggle('on', !!nv); } }, 'Yes');
        return h('div', { class: 'mrow' }, label, chip);
      }
      case 'text':
        return h('div', { class: 'mrow' }, label, h('input', { type: 'text', value: val || '', oninput: debounce((e) => set(e.target.value.trim() || null), 300) }));
      default:
        return h('div', { class: 'mrow' }, label, stepper(m, val, set));
    }
  }

  function timeControl(m, val, set, shown) {
    const clear = h('button', { class: 'chip small clear', 'aria-label': `Clear ${m.name}`, onclick: () => { set(null); paintShown(null); } }, '✕');
    const paintShown = (v) => { shown.textContent = v != null ? minsToClock(v) : ''; clear.classList.toggle('hidden', v == null); };
    paintShown(val);
    const last = lastValue(before, m.id);
    const week = before.filter((r) => r.date >= addDays(date, -7)).map((r) => r.values && r.values[m.id]).filter((v) => v != null);
    const usual = median(week);
    const pick = h('input', { type: 'time', 'aria-label': `Pick ${m.name}`, onchange: (e) => { const v = clockToMins(e.target.value, !!m.night); set(v); paintShown(v); } });
    const chips = h('div', { class: 'time-chips' },
      last != null ? h('button', { class: 'chip small', onclick: () => { set(last); paintShown(last); } }, `last ${minsToClock(last)}`) : null,
      usual != null && usual !== last ? h('button', { class: 'chip small', onclick: () => { set(usual); paintShown(usual); } }, `usual ${minsToClock(usual)}`) : null,
      h('span', { class: 'chip small pick' }, 'pick…', pick),
      clear);
    return chips;
  }
}

// Integer buttons in rows (0-10 → 6+5, or 5+5+1 when a +½ toggle shares the first row).
// A stored value that is not on the grid (6.6) highlights the nearest integer and is shown
// as text in the label; tapping any button snaps to the grid.
function scaleControl(m, val, set, shown) {
  const vals = scaleValues(m);
  const min = vals.length ? vals[0] : (m.min ?? 1), max = vals.length ? vals[vals.length - 1] : (m.max ?? 10);
  const half = (m.step ?? 1) === 0.5;
  const ints = [];
  for (let i = Math.ceil(min); i <= Math.floor(max); i++) ints.push(i);
  let cur = val == null || val === '' || isNaN(val) ? null : Number(val);
  let halfOn = false;
  const btns = new Map();
  const halfBtn = half ? h('button', { class: 'scale-btn half', 'aria-label': 'Add a half' }, '+½') : null;
  const label = shown || h('span');

  const paint = () => {
    let hi = null;
    halfOn = false;
    if (cur != null) {
      const frac = cur - Math.floor(cur);
      if (half && Math.abs(frac - 0.5) < 1e-9) { hi = Math.floor(cur); halfOn = true; }
      else hi = Math.round(cur);
    }
    for (const [i, b] of btns) b.classList.toggle('on', hi === i);
    if (halfBtn) halfBtn.classList.toggle('on', halfOn);
    label.textContent = cur == null ? '' : halfOn ? `${Math.floor(cur)}½` : fmtNum(cur);
  };
  const commit = (v) => { cur = v; set(v); paint(); };

  for (const i of ints) {
    btns.set(i, h('button', { class: 'scale-btn', onclick: () => {
      let v = i;
      if (half && halfOn && i + 0.5 <= max) v = i + 0.5;
      commit(cur === v ? null : v);
    } }, i));
  }
  if (halfBtn) halfBtn.addEventListener('click', () => {
    if (cur == null) { halfOn = !halfOn; halfBtn.classList.toggle('on', halfOn); return; }
    const frac = cur - Math.floor(cur);
    if (Math.abs(frac - 0.5) < 1e-9) commit(Math.floor(cur));
    else if (Math.floor(cur) + 0.5 <= max) commit(Math.floor(cur) + 0.5);
  });
  paint();

  const n = ints.length;
  const rowCount = n <= 5 ? 1 : Math.ceil(n / (half ? 5 : 6));
  const rows = [];
  const base = Math.floor(n / rowCount), extra = n % rowCount;
  let at = 0;
  for (let r = 0; r < rowCount; r++) {
    const size = base + (r < extra ? 1 : 0);
    const row = h('div', { class: 'scale-row-btns' }, ints.slice(at, at + size).map((i) => btns.get(i)));
    at += size;
    if (r === 0 && halfBtn) row.append(halfBtn);
    rows.push(row);
  }
  return h('div', { class: 'scale' }, rows);
}

// − [number] +: the field is only written from the buttons, never while the user types.
function stepper(m, val, set) {
  const step = m.step ?? (m.type === 'hours' ? 0.5 : m.type === 'minutes' ? 10 : 1);
  let cur = val == null || val === '' ? null : Number(val);
  const field = h('input', { type: 'number', inputmode: 'decimal', step: 'any', min: 0, class: 'num', placeholder: '–', value: cur ?? '' });
  const commitTyped = () => {
    if (field.validity.badInput) return; // still typing ("1.")
    const v = field.value === '' ? null : Number(field.value);
    if (v !== cur) { cur = v; set(v); }
  };
  field.addEventListener('change', commitTyped);
  field.addEventListener('blur', commitTyped);
  const bump = (v) => { cur = v; field.value = v ?? ''; set(v); };
  return h('div', { class: 'stepper' },
    h('button', { class: 'step-btn', 'aria-label': `Less ${m.name}`, onclick: () => bump(cur == null ? 0 : Math.max(0, round(cur - step))) }, '−'),
    field,
    h('button', { class: 'step-btn', 'aria-label': `More ${m.name}`, onclick: () => bump(round((cur || 0) + step)) }, '+'));
}

// Tap → onTap; hold → onHold (and the following click is swallowed).
function longPress(el, onHold, onTap) {
  let timer = null, held = false, pressing = false;
  const cancel = () => { clearTimeout(timer); timer = null; };
  const hold = () => { cancel(); pressing = false; held = true; onHold(); };
  el.addEventListener('pointerdown', (e) => {
    if (e.button && e.button !== 0) return;
    held = false; pressing = true;
    cancel();
    timer = setTimeout(hold, LONG_PRESS_MS);
  });
  for (const ev of ['pointerup', 'pointerleave']) el.addEventListener(ev, () => { cancel(); pressing = false; });
  // Chrome Android runs its own long-press gesture at ~500 ms: a pointercancel (in some versions)
  // followed by contextmenu. Keep `pressing` through the cancel so the contextmenu counts as the hold;
  // the timer stays as the fallback for browsers that never fire contextmenu on touch.
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); if (pressing) hold(); });
  el.addEventListener('click', () => { pressing = false; if (held) { held = false; return; } onTap(); });
}

function chipValue(m, v) {
  if (m.type !== 'bool' && m.type !== 'text' && Number(v) === 0) return ''; // an explicit 0 reads like "didn't happen"
  switch (m.type) {
    case 'bool': return '✓';
    case 'time': return minsToClock(v);
    case 'hours': return `${fmtNum(v)}h`;
    case 'minutes': return `${fmtNum(v)}m`;
    case 'money': return `${m.unit && m.unit.length <= 2 ? m.unit : '$'}${fmtNum(v)}`;
    case 'text': return String(v).length > 14 ? `${String(v).slice(0, 13)}…` : String(v);
    default: return fmtNum(v);
  }
}

function lastValue(records, id) {
  for (const r of records) {
    const v = r.values && r.values[id];
    if (v != null && v !== '') return v;
  }
  return null;
}

function median(xs) {
  if (!xs.length) return null;
  const s = xs.map(Number).sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function yearAgoOf(date) {
  const d = parseYmd(date);
  d.setFullYear(d.getFullYear() - 1);
  return ymd(d);
}

const round = (x) => Math.round(x * 100) / 100;
