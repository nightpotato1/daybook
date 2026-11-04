// Trends: an overview of every metric (7-day vs 30-day average + sparkline), and a detail view
// per metric with the daily chart, calendar heatmap, weekday pattern and weekly averages.
import { h, addDays, logicalToday, fmtNum, minsToClock, parseYmd, daysBetween } from './util.js';
import { loadMetrics, activeMetrics, loadSettings, GROUPS, isChartable } from './metrics.js';
import { loadSeries } from './data.js';
import { lineChart, barChart, heatmap, rolling } from './charts.js';
import { mean, streak } from './stats.js';
import { svgEl as s } from './util.js';

const RANGES = { '30d': 30, '90d': 90, '1y': 365, All: 0 };
let range = (() => { try { return localStorage.getItem('trendRange') || '90d'; } catch { return '90d'; } })();

const fmtV = (m, v) => (v == null ? '–' : m.type === 'time' ? minsToClock(v) : m.type === 'bool' ? `${Math.round(v * 100)}%` : fmtNum(v));

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
  if (metricId) return detail(root, metrics.find((m) => m.id === metricId), series, anchor);
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
    rows.push(h('h3', { class: 'group-title' }, g));
    for (const m of list) {
      const last7 = pts(series, m.id, addDays(anchor, -6), anchor).map((p) => p.y);
      const prev30 = pts(series, m.id, addDays(anchor, -36), addDays(anchor, -7)).map((p) => p.y);
      const a7 = mean(last7), a30 = mean(prev30);
      let arrow = '', cls = '';
      if (a7 != null && a30 != null && a30 !== 0 && m.type !== 'time') {
        const ch = (a7 - a30) / Math.abs(a30);
        if (Math.abs(ch) >= 0.1) {
          arrow = ch > 0 ? '▲' : '▼';
          cls = m.polarity === 0 ? '' : (ch > 0) === (m.polarity > 0) ? 'good' : 'bad';
        }
      }
      rows.push(h('a', { class: 'trend-row', href: `#/trends/${m.id}` },
        h('div', { class: 'tr-name' }, m.name),
        spark(pts(series, m.id, addDays(anchor, -60), anchor), m),
        h('div', { class: 'tr-val' }, h('b', {}, fmtV(m, a7)), h('small', { class: cls }, ` ${arrow}`), h('small', { class: 'muted' }, a30 != null ? ` vs ${fmtV(m, a30)}` : ''))));
    }
  }
  root.replaceChildren(
    h('h2', { class: 'page-title' }, 'Trends'),
    h('p', { class: 'muted small' }, anchor !== today ? `Showing the 7 days up to your last entry (${anchor}) vs the 30 days before.` : 'Last 7 days vs the 30 days before. Tap a row for detail.'),
    h('section', { class: 'card' }, rows));
}

function spark(points, m) {
  const W = 90, H = 24;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'spark' });
  if (points.length < 2) return svg;
  const roll = rolling(points, 7);
  const use = roll.length > 1 ? roll : points;
  const ys = use.map((p) => p.y), lo = Math.min(...ys), hi = Math.max(...ys);
  const first = use[0].date, span = Math.max(1, daysBetween(first, use[use.length - 1].date));
  const d = use.map((p, i) => `${i ? 'L' : 'M'}${((daysBetween(first, p.date) / span) * W).toFixed(1)},${(H - 2 - ((p.y - lo) / (hi - lo || 1)) * (H - 4)).toFixed(1)}`).join('');
  svg.append(s('path', { d, class: 'spark-line' }));
  return svg;
}

function detail(root, m, series, anchor) {
  if (!m) { location.hash = '#/trends'; return; }
  const days = RANGES[range];
  const from = days ? addDays(anchor, -days + 1) : series[0].date;
  const p = pts(series, m.id, from, anchor);
  const vals = p.map((x) => x.y);
  const kind = m.type === 'time' ? 'time' : null;

  const rangeBar = h('div', { class: 'seg' }, Object.keys(RANGES).map((k) =>
    h('button', { class: k === range ? 'on' : '', onclick: () => { range = k; try { localStorage.setItem('trendRange', k); } catch {} detail(root, m, series, anchor); } }, k)));

  // weekday pattern over the selected range
  const wd = [[], [], [], [], [], [], []];
  p.forEach((x) => wd[parseYmd(x.date).getDay()].push(x.y));
  const wdBars = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((l, i) => ({ label: l, y: mean(wd[i]), n: wd[i].length }));

  // weekly averages (last 16 weeks of the range)
  const weeks = new Map();
  p.forEach((x) => {
    const d = parseYmd(x.date); d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const k = `${d.getMonth() + 1}/${d.getDate()}`;
    if (!weeks.has(k)) weeks.set(k, []);
    weeks.get(k).push(x.y);
  });
  const wkBars = [...weeks.entries()].slice(-16).map(([k, a]) => ({ label: k, y: mean(a), n: a.length }));

  const stats = [
    ['Average', fmtV(m, mean(vals))],
    ['Days logged', `${vals.length}${days ? ` / ${Math.min(days, daysBetween(series[0].date, anchor) + 1)}` : ''}`],
  ];
  if (m.type !== 'time' && vals.length) {
    stats.push(['Range', `${fmtV(m, Math.min(...vals))} – ${fmtV(m, Math.max(...vals))}`]);
  }
  if (m.type === 'bool' || ['count', 'minutes', 'hours'].includes(m.type)) {
    const st = streak(series, m.id, m.polarity < 0 ? (v) => v === 0 : (v) => v > 0, anchor);
    stats.push([m.polarity < 0 ? 'Days without, streak' : 'Streak', `${st.current} now · best ${st.best}`]);
  }

  const heat = new Map(series.map((r) => [r.date, r.v[m.id]]));
  root.replaceChildren(
    h('header', { class: 'day-head' },
      h('a', { class: 'icon-btn', href: '#/trends', 'aria-label': 'Back' }, '‹'),
      h('div', { class: 'day-title' }, h('h2', {}, m.name), h('small', {}, `${m.group}${m.unit ? ` · ${m.unit}` : ''}`)),
      h('a', { class: 'icon-btn', href: `#/insights/${m.id}`, title: 'What goes with this?' }, '⚯')),
    rangeBar,
    h('section', { class: 'card' },
      h('div', { class: 'stat-grid' }, stats.map(([k, v]) => h('div', {}, h('small', {}, k), h('b', {}, v)))),
      lineChart(p, { from, to: anchor, kind, min: m.type === 'scale' ? m.min : undefined, max: m.type === 'scale' ? m.max : undefined }),
      h('small', { class: 'muted' }, 'Dots are days; the line is the 7-day average.')),
    h('section', { class: 'card' }, h('h3', {}, 'Calendar'), heatmap(heat, { to: anchor, weeks: 26, kind, polarity: m.polarity, min: m.type === 'scale' ? m.min : undefined, max: m.type === 'scale' ? m.max : undefined })),
    h('section', { class: 'card' }, h('h3', {}, 'By weekday'), barChart(wdBars, { kind })),
    ...(wkBars.length > 1 ? [h('section', { class: 'card' }, h('h3', {}, 'Weekly average'), barChart(wkBars, { kind }))] : []));
}
