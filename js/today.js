// Daily entry screen. Every tap saves immediately; blank means "not recorded", which is
// different from 0 (the "Fill blanks" button turns the rest into 0 / no once you're done).
import { h, addDays, prettyDate, logicalToday, minsToClock, clockToMins, fmtNum, debounce, toast } from './util.js';
import { getDay, saveDay, db } from './db.js';
import { loadMetrics, activeMetrics, GROUPS, loadSettings, resolveValues } from './metrics.js';
import { foodTotals } from './data.js';

const openGroups = (() => {
  try { return JSON.parse(localStorage.getItem('openGroups') || 'null') || {}; } catch { return {}; }
})();
function rememberGroup(g, open) {
  openGroups[g] = open;
  try { localStorage.setItem('openGroups', JSON.stringify(openGroups)); } catch {}
}

export async function renderToday(root, date) {
  const settings = await loadSettings();
  const today = logicalToday(settings.dayStartHour);
  date = date || today;
  const metrics = activeMetrics(await loadMetrics());
  const day = await getDay(date);
  const food = await db.byIndex('food', 'date', date);
  const ft = foodTotals(food);

  const persist = debounce(() => saveDay(day), 250);
  const setVal = (id, val) => {
    if (val == null || val === '') delete day.values[id];
    else day.values[id] = val;
    if (day.src) delete day.src[id];
    persist();
    updateProgress();
  };

  const entryMetrics = metrics.filter((m) => !m.derived);
  const progress = h('div', { class: 'progress' });
  function updateProgress() {
    const done = entryMetrics.filter((m) => day.values[m.id] != null).length;
    const pct = entryMetrics.length ? done / entryMetrics.length : 0;
    progress.replaceChildren(
      h('div', { class: 'bar' }, h('span', { style: { width: `${Math.round(pct * 100)}%` } })),
      h('small', {}, `${done}/${entryMetrics.length} logged`));
  }
  updateProgress();

  const header = h('header', { class: 'day-head' },
    h('button', { class: 'icon-btn', onclick: () => go(addDays(date, -1)), 'aria-label': 'Previous day' }, '‹'),
    h('div', { class: 'day-title' },
      h('h2', {}, date === today ? 'Today' : date === addDays(today, -1) ? 'Yesterday' : prettyDate(date)),
      h('small', {}, prettyDate(date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }))),
    h('button', { class: 'icon-btn', onclick: () => go(addDays(date, 1)), disabled: date >= today, 'aria-label': 'Next day' }, '›'));

  function go(d) { location.hash = `#/today/${d}`; }

  const resolved = resolveValues(day, metrics, ft);
  const groups = new Map();
  for (const m of metrics) {
    const g = GROUPS.includes(m.group) ? m.group : 'Other';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(m);
  }

  const cards = [];
  for (const g of GROUPS) {
    const list = groups.get(g);
    if (g === 'Food') { cards.push(foodCard(date, ft, list || [], day, setVal)); continue; }
    if (!list) continue;
    const open = openGroups[g] ?? (g !== 'Substances' && g !== 'Other');
    const det = h('details', { class: 'card group', open },
      h('summary', {}, h('span', {}, g), h('small', { class: 'group-count' }, countText(list, day))),
      list.map((m) => metricRow(m, day, resolved, setVal, () => { det.querySelector('.group-count').textContent = countText(list, day); })));
    det.addEventListener('toggle', () => rememberGroup(g, det.open));
    cards.push(det);
  }

  const notes = h('section', { class: 'card notes' },
    h('h3', {}, 'Notes'),
    h('label', {}, 'One line about today',
      h('input', { type: 'text', value: day.title || '', placeholder: 'e.g. hike with Sam, rough day at work', oninput: (e) => { day.title = e.target.value; persist(); } })),
    h('label', {}, 'Grateful for',
      h('textarea', { rows: 2, placeholder: 'One thing is enough', oninput: (e) => { day.gratitude = e.target.value; persist(); } }, day.gratitude || '')),
    h('label', {}, 'Journal',
      h('textarea', { rows: 4, placeholder: 'Anything else', oninput: (e) => { day.note = e.target.value; persist(); } }, day.note || '')));

  const fill = h('button', { class: 'btn wide', onclick: () => {
    let n = 0;
    for (const m of entryMetrics) {
      if (day.values[m.id] != null) continue;
      if (['count', 'hours', 'minutes', 'money', 'bool'].includes(m.type) && !m.source) { day.values[m.id] = 0; n++; }
    }
    saveDay(day);
    toast(n ? `Set ${n} blank fields to 0 / no` : 'Nothing blank to fill');
    renderToday(root, date);
  } }, 'Done for today: fill blanks with 0 / no');

  root.replaceChildren(header, progress, ...cards, notes, fill);
}

function countText(list, day) {
  const entry = list.filter((m) => !m.derived);
  const done = entry.filter((m) => day.values[m.id] != null).length;
  return entry.length ? `${done}/${entry.length}` : '';
}

function metricRow(m, day, resolved, setVal, onChange) {
  const val = day.values[m.id];
  const set = (v) => { setVal(m.id, v); onChange(); };
  const badge = day.src && day.src[m.id] ? h('span', { class: 'badge' }, day.src[m.id]) : null;
  const label = h('div', { class: 'mlabel' }, m.name, badge, m.unit && m.type !== 'scale' ? h('small', {}, ` ${m.unit}`) : null);

  if (m.derived) {
    const rv = resolved[m.id];
    const shown = m.type === 'bool' ? (rv ? 'yes' : '–') : fmtNum(rv);
    return h('div', { class: 'mrow derived' }, label, h('div', { class: 'derived-val' }, shown, h('small', {}, ' auto')));
  }

  let control;
  switch (m.type) {
    case 'scale': {
      // Tap a number to set it; tap the selected number again to clear.
      const min = m.min ?? 1, max = m.max ?? 10;
      let cur = val;
      const btns = [];
      for (let i = min; i <= max; i++) {
        btns.push(h('button', { class: `scale-btn${cur === i ? ' on' : ''}`, onclick: () => {
          cur = cur === i ? null : i;
          set(cur);
          btns.forEach((b, j) => b.classList.toggle('on', min + j === cur));
        } }, i));
      }
      control = h('div', { class: `scale n${max - min + 1}` }, btns);
      return h('div', { class: 'mrow scale-row' }, label, control);
    }
    case 'bool': {
      let cur = val;
      const chip = h('button', { class: `chip${cur ? ' on' : cur === 0 ? ' off' : ''}` });
      const paint = () => {
        chip.className = `chip${cur ? ' on' : cur === 0 ? ' off' : ''}`;
        chip.textContent = cur ? 'Yes' : cur === 0 ? 'No' : '–';
      };
      chip.addEventListener('click', () => { cur = cur ? 0 : cur === 0 ? null : 1; set(cur); paint(); });
      paint();
      control = chip;
      break;
    }
    case 'time': {
      control = h('input', { type: 'time', value: val != null ? minsToClock(val) : '', onchange: (e) => set(clockToMins(e.target.value, !!m.night)) });
      break;
    }
    case 'text': {
      control = h('input', { type: 'text', value: val || '', oninput: debounce((e) => set(e.target.value), 400) });
      break;
    }
    case 'money': {
      control = h('input', { type: 'number', inputmode: 'decimal', min: 0, step: 'any', value: val ?? '', placeholder: '–', class: 'num', oninput: debounce((e) => set(e.target.value === '' ? null : Number(e.target.value)), 400) });
      break;
    }
    default: {
      const step = m.step ?? (m.type === 'hours' ? 0.5 : m.type === 'minutes' ? 10 : 1);
      let cur = val;
      const field = h('input', { type: 'number', inputmode: 'decimal', step: 'any', min: 0, class: 'num', placeholder: '–', value: cur ?? '' });
      const commit = (v) => { cur = v; field.value = v ?? ''; set(v); };
      field.addEventListener('input', debounce(() => commit(field.value === '' ? null : Number(field.value)), 400));
      control = h('div', { class: 'stepper' },
        h('button', { class: 'step-btn', 'aria-label': `Less ${m.name}`, onclick: () => commit(cur == null ? 0 : Math.max(0, round(cur - step))) }, '−'),
        field,
        h('button', { class: 'step-btn', 'aria-label': `More ${m.name}`, onclick: () => commit(round((cur || 0) + step)) }, '+'));
    }
  }
  return h('div', { class: 'mrow' }, label, control);
}

const round = (x) => Math.round(x * 100) / 100;

function foodCard(date, ft, foodMetrics, day, setVal) {
  const resolved = resolveValues(day, foodMetrics, ft);
  const kcal = resolved.kcal, protein = resolved.protein;
  const others = foodMetrics.filter((m) => !m.derived);
  return h('section', { class: 'card food-card' },
    h('div', { class: 'food-head' },
      h('h3', {}, 'Food'),
      h('div', { class: 'food-totals' },
        h('b', {}, kcal != null ? fmtNum(kcal, 0) : '–'), h('small', {}, ' kcal  '),
        h('b', {}, protein != null ? fmtNum(protein, 0) : '–'), h('small', {}, ' g protein'),
        ft.n ? h('small', {}, `  · ${ft.n} items`) : null)),
    h('div', { class: 'food-actions' },
      h('a', { class: 'btn primary', href: `#/food/${date}/photo` }, '📷 Photo'),
      h('a', { class: 'btn', href: `#/food/${date}/add` }, '+ Add'),
      h('a', { class: 'btn', href: `#/food/${date}` }, 'Log')),
    others.map((m) => metricRow(m, day, resolved, setVal, () => {})));
}
