// Trends: an overview of every metric (7-day vs prior-30-day average + sparkline, arrows only
// when the change beats the noise), and a detail view per metric with the daily chart (plus an
// optional second metric overlaid), calendar heatmap, weekday pattern and weekly totals/averages.
import { h, addDays, logicalToday, fmtNum, minsToClock, parseYmd, daysBetween, svgEl as s } from './util.js';
import { loadMetrics, activeMetrics, loadSettings, GROUPS, isChartable } from './metrics.js';
import { loadSeries } from './data.js';
import { lineChart, barChart, heatmap, rolling } from './charts.js';
import { mean, sd, streak, strengthScore } from './stats.js';

const RANGES = { '30d': 30, '90d': 90, '1y': 365, All: 0 };
const SUM_TYPES = ['count', 'hours', 'minutes', 'money', 'bool'];
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch {} return v; };
let range = store('trendRange') || '90d';
let weeklyMode = store('trendWeekly') || 'sum';
let compareId = '';

const fmtV = (m, v) => (v == null ? '–' : m.type === 'time' ? minsToClock(v) : m.type === 'bool' ? `${Math.round(v * 100)}%` : fmtNum(v));
const kindOf = (m) => (m.type === 'time' ? 'time' : m.type === 'scale' && (m.step || 1) === 1 ? 'int' : null);
const scaleMin = (m) => (m.type === 'scale' ? (m.min ?? 1) : undefined);
const scaleMax = (m) => (m.type === 'scale' ? (m.max ?? 10) : undefined);
// habit-like: something you do or don't do on a day (yes/no, counts, durations, money, 0-based scales)
const habitLike = (m) => !m.source && (SUM_TYPES.includes(m.type) || (m.type === 'scale' && m.min === 0));

export async function renderTrends(root, metricId) {
  const settings = await loadSettings();
  const today = logicalToday(settings.dayStartHour);
  const metrics = (await loadMetrics()).filter(isChartable);
  const series = await loadSeries(metrics);
  if (!series.length) {
    root.replaceChildren(h('h2', { class: 'page-title' }, 'Trends'), h('p', { class: 'empty' }, 'No data yet. Log a few days, or import your spreadsheet history in Settings.'));
    return;
  }
  // "today" for an imported history that ended long ago: anchor on the last logged day
  const past = series.filter((r) => r.date <= today);
  const lastDate = (past.length ? past : series)[(past.length ? past : series).length - 1].date;
  const anchor = lastDate < addDays(today, -30) ? lastDate : today;
  if (metricId) return detail(root, metrics.find((m) => m.id === metricId), activeMetrics(metrics), series, anchor);
  overview(root, activeMetrics(metrics), series, anchor, today);
}

function pts(series, id, from, to) {
  return series.filter((r) => r.v[id] != null && (!from || r.date >= from) && (!to || r.date <= to)).map((r) => ({ date: r.date, y: r.v[id] }));
}

function overview(root, metrics, series, anchor, today) {
  const rows = [];
  for (const g of GROUPS) {
    const list = metrics.filter((m) => (GROUPS.includes(m.group) ? m.group : 'Other') === g);
    if (!list.length) continue;
    rows.push(h('h3', { class: 'ch-group-title' }, g));
    for (const m of list) {
      const last7 = pts(series, m.id, addDays(anchor, -6), anchor).map((p) => p.y);
      const prev30 = pts(series, m.id, addDays(anchor, -36), addDays(anchor, -7)).map((p) => p.y);
      const a7 = mean(last7), a30 = mean(prev30);
      // arrow only when the 7-day mean moved by more than one standard error of a 7-day mean;
      // a constant prior month (se 0) means any change at all is real
      let arrow = '', cls = '';
      const se = prev30.length >= 5 ? sd(prev30) / Math.sqrt(7) : null;
      if (a7 != null && a30 != null && se != null && m.type !== 'time') {
        if (Math.abs(a7 - a30) > se) {
          arrow = a7 > a30 ? '▲' : '▼';
          cls = m.polarity === 0 ? '' : (a7 > a30) === (m.polarity > 0) ? 'good' : 'bad';
        } else arrow = '≈';
      }
      rows.push(h('a', { class: 'ch-trend-row', href: `#/trends/${m.id}` },
        h('div', { class: 'ch-tr-name' }, m.name),
        spark(pts(series, m.id, addDays(anchor, -60), anchor)),
        h('div', { class: 'ch-tr-val' }, h('b', {}, fmtV(m, a7)), h('small', { class: `ch-arrow ${cls}` }, ` ${arrow}`), h('small', { class: 'muted' }, a30 != null ? ` vs ${fmtV(m, a30)}` : ''))));
    }
  }
  root.replaceChildren(
    h('h2', { class: 'page-title' }, 'Trends'),
    h('p', { class: 'muted small' }, anchor !== today ? `Showing the 7 days up to your last entry (${anchor}) vs the 30 days before.` : 'Last 7 days vs the 30 days before. ',
      'Arrows appear only when the change is bigger than the usual week-to-week noise; ≈ means within it. Tap a row for detail.'),
    h('section', { class: 'card' }, rows));
}

function spark(points) {
  const W = 90, H = 24;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'ch-spark' });
  if (points.length < 2) return svg;
  const roll = rolling(points, 7);
  const use = roll.length > 1 ? roll : points;
  const ys = use.map((p) => p.y), lo = Math.min(...ys), hi = Math.max(...ys);
  const first = use[0].date, span = Math.max(1, daysBetween(first, use[use.length - 1].date));
  const d = use.map((p, i) => `${i ? 'L' : 'M'}${((daysBetween(first, p.date) / span) * W).toFixed(1)},${(H - 2 - ((p.y - lo) / (hi - lo || 1)) * (H - 4)).toFixed(1)}`).join('');
  svg.append(s('path', { d, class: 'ch-spark-line' }));
  return svg;
}

function weekStart(date) {
  const d = parseYmd(date); d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

function detail(root, m, metrics, series, anchor) {
  if (!m) { location.hash = '#/trends'; return; }
  const days = RANGES[range];
  const from = days ? addDays(anchor, -days + 1) : series[0].date;
  const p = pts(series, m.id, from, anchor);
  const vals = p.map((x) => x.y);
  const kind = kindOf(m);
  const sums = SUM_TYPES.includes(m.type);
  const rerender = () => detail(root, m, metrics, series, anchor);

  const rangeBar = h('div', { class: 'seg' }, Object.keys(RANGES).map((k) =>
    h('button', { class: k === range ? 'on' : '', onclick: () => { range = store('trendRange', k); rerender(); } }, k)));

  // weekday pattern over the selected range (min/max whiskers for scales)
  const wd = [[], [], [], [], [], [], []];
  p.forEach((x) => wd[parseYmd(x.date).getDay()].push(x.y));
  const wdBars = WD.map((l, i) => ({ label: l, y: mean(wd[i]), n: wd[i].length,
    ...(m.type === 'scale' && wd[i].length > 1 ? { lo: Math.min(...wd[i]), hi: Math.max(...wd[i]) } : {}) }));

  // weekly totals or averages (last 16 weeks of the range)
  const weeks = new Map();
  p.forEach((x) => {
    const d = weekStart(x.date), k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (!weeks.has(k)) weeks.set(k, { label: `${d.getMonth() + 1}/${d.getDate()}`, a: [] });
    weeks.get(k).a.push(x.y);
  });
  const useSum = sums && weeklyMode === 'sum';
  const wkBars = [...weeks.values()].slice(-16).map(({ label, a }) => ({ label, n: a.length,
    y: useSum ? a.reduce((x, y) => x + y, 0) : mean(a),
    ...(m.type === 'scale' && a.length > 1 ? { lo: Math.min(...a), hi: Math.max(...a) } : {}) }));

  const spanDays = Math.min(days || Infinity, daysBetween(series[0].date, anchor) + 1);
  const stats = [[sums ? 'Average per day' : 'Average', fmtV(m, mean(vals))]];
  if (sums && vals.length) stats.push(['Per week', `${fmtNum(vals.reduce((a, b) => a + b, 0) / Math.max(1, spanDays / 7))}${m.type === 'bool' ? ' days' : m.unit ? ` ${m.unit}` : ''}`]);
  stats.push(['Days logged', `${vals.length}${days ? ` / ${spanDays}` : ''}`]);
  if (m.type !== 'time' && !sums && vals.length) stats.push(['Range', `${fmtV(m, Math.min(...vals))} – ${fmtV(m, Math.max(...vals))}`]);
  if (habitLike(m)) {
    if (m.polarity < 0) {
      const st = streak(series, m.id, (v) => v === 0, anchor);
      stats.push(['Days without', `${st.current} now · best ${st.best}`]);
    } else {
      const sc = strengthScore(series, m.id, (v) => v > 0, anchor);
      stats.push(['Habit strength', h('span', {}, `${sc.score}%`, h('small', { class: 'muted' }, ` · ${sc.done7} of last ${sc.logged7} · ${sc.done30} of last ${sc.logged30} logged days`))]);
    }
  }

  // "Compare with…": a second metric's 7-day line on the right-hand axis
  const cmp = metrics.find((x) => x.id === compareId && x.id !== m.id);
  const cmpPick = h('select', { class: 'ch-compare', 'aria-label': 'Compare with', onchange: (e) => { compareId = e.target.value; rerender(); } },
    h('option', { value: '' }, 'Compare with…'),
    metrics.filter((x) => x.id !== m.id).map((x) => h('option', { value: x.id, selected: x.id === compareId }, x.name)));
  const overlay = cmp ? { points: pts(series, cmp.id, from, anchor), kind: kindOf(cmp), min: scaleMin(cmp), max: scaleMax(cmp) } : null;

  const weeklyHead = h('div', { class: 'ch-row-head' }, h('h3', {}, sums ? (useSum ? 'Weekly total' : 'Weekly average') : 'Weekly average'),
    sums ? h('div', { class: 'seg ch-mini-seg' }, [['sum', 'Sum'], ['avg', 'Average']].map(([v, l]) =>
      h('button', { class: weeklyMode === v ? 'on' : '', onclick: () => { weeklyMode = store('trendWeekly', v); rerender(); } }, l))) : null);

  const heat = new Map(series.map((r) => [r.date, r.v[m.id]]));
  root.replaceChildren(
    h('header', { class: 'day-head' },
      h('a', { class: 'icon-btn', href: '#/trends', 'aria-label': 'Back' }, '‹'),
      h('div', { class: 'day-title' }, h('h2', {}, m.name), h('small', {}, `${m.group}${m.unit ? ` · ${m.unit}` : ''}`)),
      h('a', { class: 'icon-btn', href: `#/insights/${m.id}`, title: 'What goes with this?', 'aria-label': 'What goes with this?' }, '⚯')),
    rangeBar,
    h('section', { class: 'card' },
      h('div', { class: 'ch-stat-grid' }, stats.map(([k, v]) => h('div', {}, h('small', {}, k), h('b', {}, v)))),
      lineChart(p, { from, to: anchor, kind, min: scaleMin(m), max: scaleMax(m), overlay }),
      h('div', { class: 'ch-legend small muted' },
        h('span', {}, h('i', { class: 'ch-sw ch-sw-main' }), `${m.name}: dots are days, line is the 7-day average`),
        cmp ? h('span', {}, h('i', { class: 'ch-sw ch-sw-overlay' }), `${cmp.name}: 7-day average, right axis`) : null),
      h('div', { class: 'row' }, cmpPick)),
    h('section', { class: 'card' }, h('h3', {}, 'Calendar'), heatmap(heat, { to: anchor, weeks: 26, kind, polarity: m.polarity, min: scaleMin(m), max: scaleMax(m) })),
    h('section', { class: 'card' }, h('h3', {}, 'By weekday'), barChart(wdBars, { kind }),
      m.type === 'scale' ? h('small', { class: 'muted' }, 'Bars are averages; whiskers span the lowest and highest day.') : null),
    ...(wkBars.length > 1 ? [h('section', { class: 'card' }, weeklyHead, barChart(wkBars, { kind: useSum && m.type !== 'time' ? (m.type === 'bool' || m.type === 'count' ? 'int' : null) : kind }))] : []));
}
