// Insights: what moves with a target metric (mood by default), same day or the next day.
import { h, fmtNum, minsToClock } from './util.js';
import { loadMetrics, loadSettings, saveSettings, isChartable } from './metrics.js';
import { loadSeries } from './data.js';
import { correlate } from './stats.js';
import { scatter } from './charts.js';

let lag = 0;
let rangeDays = 0;

const fmtV = (m, v) => (v == null ? '–' : m.type === 'time' ? minsToClock(v) : fmtNum(v));

export async function renderInsights(root, targetId) {
  const settings = await loadSettings();
  const metrics = (await loadMetrics()).filter(isChartable);
  if (targetId && targetId !== settings.insightsTarget) { settings.insightsTarget = targetId; await saveSettings(settings); }
  const target = metrics.find((m) => m.id === (targetId || settings.insightsTarget)) || metrics[0];
  let series = await loadSeries(metrics);
  if (rangeDays && series.length) {
    const cut = series[Math.max(0, series.length - rangeDays)].date;
    series = series.filter((r) => r.date >= cut);
  }

  const pick = h('select', { onchange: (e) => { location.hash = `#/insights/${e.target.value}`; } },
    metrics.map((m) => h('option', { value: m.id, selected: m.id === target.id }, m.name)));
  const lagSeg = h('div', { class: 'seg' },
    [[0, 'Same day'], [1, 'Next day']].map(([v, l]) => h('button', { class: lag === v ? 'on' : '', onclick: () => { lag = v; renderInsights(root, target.id); } }, l)));
  const rangeSeg = h('div', { class: 'seg' },
    [[0, 'All time'], [365, 'Last 365 logged'], [90, 'Last 90']].map(([v, l]) => h('button', { class: rangeDays === v ? 'on' : '', onclick: () => { rangeDays = v; renderInsights(root, target.id); } }, l)));

  const results = correlate(series, target.id, metrics, lag);
  const tested = results.length;
  const solid = results.filter((r) => r.significant);
  const detailBox = h('div');

  const row = (r) => {
    const pct = Math.min(100, Math.abs(r.rho) * 200);
    const good = (r.rho > 0) === (target.polarity >= 0);
    return h('button', { class: `ins-row${r.significant ? ' sig' : ''}`, onclick: () => showDetail(r) },
      h('div', { class: 'ins-name' }, r.metric.name, r.significant ? h('span', { class: 'badge' }, 'solid') : null),
      h('div', { class: 'ins-bar' }, h('span', { class: r.rho > 0 ? 'pos' : 'neg', style: { width: `${pct / 2}%`, [r.rho > 0 ? 'left' : 'right']: '50%' } })),
      h('div', { class: `ins-r ${good ? 'good' : 'bad'}` }, (r.rho > 0 ? '+' : '') + r.rho.toFixed(2)));
  };

  function showDetail(r) {
    const m = r.metric;
    const tgt = lag ? `next-day ${target.name.toLowerCase()}` : target.name.toLowerCase();
    detailBox.replaceChildren(h('section', { class: 'card' },
      h('h3', {}, `${m.name} → ${tgt}`),
      h('p', {}, `On days with ${r.hi.label} (${r.hi.n} days) ${tgt} averaged `, h('b', {}, fmtV(target, r.hi.mean)),
        `; with ${r.lo.label} (${r.lo.n} days) it averaged `, h('b', {}, fmtV(target, r.lo.mean)), '.'),
      scatter(r.pairs, { xLabel: m.name, xKind: m.type === 'time' ? 'time' : null, yKind: target.type === 'time' ? 'time' : null }),
      h('p', { class: 'muted small' }, `Spearman ρ = ${r.rho.toFixed(2)} over ${r.n} days (≈${r.nEff} independent after day-to-day carryover), p ≈ ${r.p < 0.001 ? '<0.001' : r.p.toFixed(3)}. `,
        r.significant ? 'Survives the many-comparisons correction.' : 'Does not survive the many-comparisons correction: treat as a hunch.')));
    detailBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  root.replaceChildren(
    h('h2', { class: 'page-title' }, 'Insights'),
    h('section', { class: 'card' },
      h('label', {}, 'What goes with…', pick),
      lagSeg, rangeSeg),
    h('section', { class: 'card' },
      h('p', { class: 'small muted' }, `${tested} things tested against ${target.name.toLowerCase()}; ${solid.length} hold up after correcting for testing that many. `,
        'Correlation is not cause: a bad week can drive both drinking and low mood. Next-day view helps tell which came first.'),
      results.length ? results.map(row) : h('p', { class: 'empty' }, 'Need at least 14 days where both are logged.')),
    detailBox);
}
