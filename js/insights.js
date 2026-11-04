// Insights: one primary analysis (what goes with the target, weekday-adjusted, all data, effect
// sizes with confidence intervals, FDR-labelled "probable"), and an explicitly uncorrected
// Explore mode for other targets, ranges, raw values and next-day comparisons.
import { h, fmtNum, minsToClock } from './util.js';
import { loadMetrics, loadSettings, saveSettings, isChartable, activeMetrics } from './metrics.js';
import { loadSeries } from './data.js';
import { analyze, weekdayMeans } from './stats.js';
import { scatter, barChart } from './charts.js';

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const explore = { open: false, targetId: '', rangeDays: 0, adjust: true, lag: 0 };
const cache = new Map(); // analysis results keyed by target|range|adjust|lag for this page load

const fmtV = (m, v) => (v == null ? '–' : m.type === 'time' ? minsToClock(v) : m.type === 'bool' ? `${Math.round(v * 100)}%` : fmtNum(v));
const kindOf = (m) => (m.type === 'time' ? 'time' : m.type === 'bool' || (m.type === 'scale' && (m.step || 1) === 1) ? 'int' : null);
const lower = (m) => m.name.toLowerCase();

function signed(v, digits) {
  if (v == null || isNaN(v)) return '?';
  const d = digits ?? (Math.abs(v) >= 100 ? 0 : Math.abs(v) < 0.1 && v !== 0 ? 2 : 1);
  return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d);
}
// a number in the target's own units, and the same with the unit word: "+0.9 mood", "+35 min", "+12% gratitude written"
const num = (v, target) => (target.type === 'time' ? signed(v, 0) : target.type === 'bool' ? `${signed(v * 100, 0)}%` : signed(v));
function effect(v, target) {
  if (v == null) return '?';
  return `${num(v, target)} ${target.type === 'time' ? 'min' : target.unit || lower(target)}`;
}
const ciText = (ci, target) => (ci ? `95% CI ${num(ci[0], target)} to ${num(ci[1], target)}` : 'no interval: too few days');
const excludesZero = (ci) => ci && (ci[0] > 0 || ci[1] < 0);
// unsigned size: "0.4 mood"
const size = (v, target) => effect(v == null ? null : Math.abs(v), target).replace(/^[+−]/, '');

function run(series, metrics, targetId, rangeDays, adjust, lag) {
  const fp = series.reduce((a, r) => a + (r.day && r.day.updatedAt ? r.day.updatedAt % 1e7 : 0), series.length);
  const key = `${targetId}|${rangeDays}|${adjust}|${lag}|${fp}`;
  if (cache.has(key)) return cache.get(key);
  let s = series;
  if (rangeDays && s.length > rangeDays) s = s.slice(s.length - rangeDays);
  const out = analyze(s, metrics, { targetId, adjustWeekday: adjust, lag });
  out.days = s.length;
  cache.set(key, out);
  return out;
}

export async function renderInsights(root, routeTarget) {
  const settings = await loadSettings();
  const metrics = activeMetrics((await loadMetrics()).filter(isChartable));
  if (!metrics.length) { root.replaceChildren(h('h2', { class: 'page-title' }, 'Insights'), h('p', { class: 'empty' }, 'No metrics to analyse.')); return; }
  const primary = metrics.find((m) => m.id === settings.insightsTarget) || metrics.find((m) => m.id === 'mood') || metrics[0];
  if (routeTarget && routeTarget !== primary.id && metrics.some((m) => m.id === routeTarget)) { explore.open = true; explore.targetId = routeTarget; }
  if (!metrics.some((m) => m.id === explore.targetId)) explore.targetId = primary.id;
  const series = await loadSeries(metrics);
  const rerender = () => renderInsights(root);

  const goals = (settings.goalsText || '').trim();
  const parts = [h('h2', { class: 'page-title' }, 'Insights')];
  if (goals) parts.push(h('section', { class: 'card ch-goals' }, h('h3', {}, 'Your goals'), h('p', { class: 'ch-pre' }, goals)));

  const loggedTarget = series.filter((r) => r.v[primary.id] != null).length;
  if (loggedTarget < 14) {
    parts.push(h('section', { class: 'card' }, h('p', { class: 'empty' }, `Need at least 14 days with ${lower(primary)} logged (have ${loggedTarget}). Keep checking in; the analysis switches on by itself.`)));
    root.replaceChildren(...parts);
    return;
  }

  // 1. the weekday effect on the target: the biggest regular pattern, and what the analysis removes
  const wm = weekdayMeans(series, primary.id);
  const order = [1, 2, 3, 4, 5, 6, 0];
  const known = order.filter((i) => wm[i].mean != null);
  const lo = Math.min(...known.map((i) => wm[i].mean)), hi = Math.max(...known.map((i) => wm[i].mean));
  parts.push(h('section', { class: 'card' },
    h('h3', {}, `${primary.name} by weekday`),
    h('p', { class: 'small' }, known.map((i) => `${WD[i]} ${fmtV(primary, wm[i].mean)}`).join(' · ')),
    barChart(order.map((i) => ({ label: WD[i], y: wm[i].mean, n: wm[i].n })), { kind: kindOf(primary), height: 120 }),
    h('p', { class: 'small muted' }, `${primary.name} differs by ${effect(hi - lo, primary).replace(/^[+−]/, '')} between the lowest and highest weekday. Weekend-linked things (drinking, friends, late mornings) would inherit that swing, so the analysis below removes each weekday's average first.`)));

  // 2. the primary analysis: same day, weekday-adjusted, all data; the next-day effect of every
  // line is filled in after the first paint (a second full run) so the list appears at once
  const prim = run(series, metrics, primary.id, 0, true, 0);
  const primDetail = h('div');
  const ctx = { series, metrics, target: primary, rangeDays: 0, adjust: true, lag: 0, box: primDetail, primary: true, nextSlots: new Map() };
  parts.push(h('section', { class: 'card' },
    h('h3', {}, `What goes with ${lower(primary)}`),
    h('p', { class: 'small muted' }, `Same day, adjusted for weekday, all ${prim.days} logged days. Each line is the difference in ${lower(primary)} between days with and without the thing, with a 95% confidence interval; sorted by the lower end of that interval. `,
      h('b', {}, 'probable'), ` = survives a 5% false-discovery-rate correction across the ${prim.tested} things tested here (about one in twenty such labels is still expected to be noise). `,
      h('b', {}, 'next day'), ` = the same thing today against ${lower(primary)} tomorrow, shown for context and not part of that correction.`),
    resultList(prim, ctx),
    skippedList(prim.skipped),
    h('p', { class: 'small muted' }, 'Correlation is not cause: a bad week can drive both drinking and low mood. Tap a line for the detail, including which of the two tends to come first (not why).')),
    primDetail);
  setTimeout(() => fillNextDay(prim, ctx), 30);

  // 3. explore: other targets, ranges, raw, next day; explicitly uncorrected
  const ex = run(series, metrics, explore.targetId, explore.rangeDays, explore.adjust, explore.lag);
  const exTarget = metrics.find((m) => m.id === explore.targetId);
  const exDetail = h('div');
  const exCtx = { series, metrics, target: exTarget, rangeDays: explore.rangeDays, adjust: explore.adjust, lag: explore.lag, box: exDetail, primary: false };
  const seg = (pairs, cur, set) => h('div', { class: 'seg' }, pairs.map(([v, l]) => h('button', { class: cur === v ? 'on' : '', onclick: () => { set(v); rerender(); } }, l)));
  parts.push(h('details', { class: 'card ch-explore', open: explore.open || null, ontoggle: (e) => { explore.open = e.target.open; } },
    h('summary', {}, h('span', {}, 'Explore'), h('small', { class: 'muted' }, 'uncorrected')),
    h('p', { class: 'small muted' }, 'Every combination you try here is a fresh set of tests, so nothing is marked probable. Treat these as hunches to check against the primary analysis above.'),
    h('label', {}, 'What goes with…', h('select', { onchange: (e) => { explore.targetId = e.target.value; rerender(); } },
      metrics.map((m) => h('option', { value: m.id, selected: m.id === explore.targetId }, m.name)))),
    seg([[0, 'All time'], [365, 'Last 365 logged'], [90, 'Last 90']], explore.rangeDays, (v) => { explore.rangeDays = v; }),
    seg([[true, 'Weekday-adjusted'], [false, 'Raw']], explore.adjust, (v) => { explore.adjust = v; }),
    seg([[0, 'Same day'], [1, 'Next day']], explore.lag, (v) => { explore.lag = v; }),
    exTarget && exTarget.id !== primary.id ? h('button', { class: 'btn', onclick: async () => { settings.insightsTarget = exTarget.id; await saveSettings(settings); rerender(); } }, `Make ${lower(exTarget)} the primary target`) : null,
    h('p', { class: 'small muted' }, `${ex.tested} things tested against ${exTarget ? lower(exTarget) : '?'}${explore.lag ? ' the next day' : ''}, ${ex.days} logged days, ${explore.adjust ? 'weekday-adjusted' : 'raw values (weekday not removed)'}.`),
    resultList(ex, exCtx),
    skippedList(ex.skipped)),
    exDetail);

  root.replaceChildren(...parts);
}

// Second lag of the primary analysis: write "next day +0.2 (CI …)" into each primary row.
function fillNextDay(prim, ctx) {
  if (!ctx.nextSlots.size || !ctx.box.isConnected) return;
  const t = ctx.target;
  const lag1 = run(ctx.series, ctx.metrics, t.id, 0, true, 1);
  for (const [id, slot] of ctx.nextSlots) {
    const r = lag1.results.find((x) => x.metric.id === id);
    slot.replaceChildren(' · next day ', r ? h('span', { class: excludesZero(r.ci) ? '' : 'muted' }, `${num(r.diff, t)} (${r.ci ? `${num(r.ci[0], t)} to ${num(r.ci[1], t)}` : 'no CI'})`) : h('span', { class: 'muted' }, 'too few pairs'));
  }
}

function resultList(res, ctx) {
  if (!res.results.length) return h('p', { class: 'empty' }, 'Nothing has enough days with and without yet.');
  const rows = [...res.results].sort((a, b) => (b.ci ? b.ci[0] : -Infinity) - (a.ci ? a.ci[0] : -Infinity) || Math.abs(b.diff) - Math.abs(a.diff));
  const scale = Math.max(1e-9, ...rows.flatMap((r) => (r.ci ? r.ci.map(Math.abs) : [Math.abs(r.diff)])));
  const t = ctx.target, primary = ctx.primary;
  return h('div', { class: 'ch-ins-list' }, rows.map((r) => {
    const good = t.polarity === 0 ? '' : (r.diff > 0) === (t.polarity > 0) ? 'good' : 'bad';
    const pct = (v) => `${(50 + (v / scale) * 48).toFixed(1)}%`;
    let next = null;
    if (primary && ctx.nextSlots) { next = h('span', { class: 'ch-next' }, ' · next day ', h('span', { class: 'muted' }, '…')); ctx.nextSlots.set(r.metric.id, next); }
    return h('button', { class: `ch-ins-row${primary && r.probable ? ' probable' : ''}${excludesZero(r.ci) ? '' : ' weak'}`, onclick: () => showDetail(r, ctx) },
      h('div', { class: 'ch-ins-text' },
        h('b', {}, r.metric.name), ': ',
        h('span', { class: good }, effect(r.diff, t)),
        ` (${ciText(r.ci, t)}), ${r.hiN} vs ${r.loN} days, ${r.grade}`,
        primary && r.probable ? [', ', h('span', { class: 'badge' }, 'probable')] : null,
        ctx.lag ? h('span', { class: 'muted' }, ' · next day') : null,
        next),
      h('div', { class: 'ch-ci' },
        r.ci ? h('span', { class: 'ch-ci-bar', style: { left: pct(Math.min(r.ci[0], r.ci[1])), width: `calc(${pct(Math.max(r.ci[0], r.ci[1]))} - ${pct(Math.min(r.ci[0], r.ci[1]))})` } }) : null,
        h('span', { class: 'ch-ci-dot', style: { left: pct(r.diff) } })));
  }));
}

function skippedList(skipped) {
  if (!skipped.length) return null;
  return h('details', { class: 'ch-skipped' },
    h('summary', { class: 'small muted' }, `Not enough days with/without yet (${skipped.length})`),
    h('ul', { class: 'small muted' }, skipped.map((s) => h('li', {}, `${s.metric.name}: ${s.reason}`))));
}

function showDetail(r, ctx) {
  const m = r.metric, t = ctx.target, tn = lower(t);
  const lagBox = h('div', { class: 'ch-lags' }, h('p', { class: 'small muted' }, 'Computing the next-day comparison…'));
  const sh = r.splitHalf;
  const halves = sh.first.diff != null && sh.second.diff != null;
  const sameSign = halves && Math.sign(sh.first.diff) === Math.sign(sh.second.diff);
  ctx.box.replaceChildren(h('section', { class: 'card ch-detail' },
    h('h3', {}, `${m.name} and ${tn}${ctx.lag ? ' the next day' : ''}`),
    h('p', {}, `On days with ${r.hi.label} (${r.hiN} days) ${ctx.lag ? 'next-day ' : ''}${tn} averaged `, h('b', {}, fmtV(t, r.hi.mean)),
      `; with ${r.lo.label} (${r.loN} days) `, h('b', {}, fmtV(t, r.lo.mean)), '. ',
      ctx.adjust ? 'Adjusted for weekday: ' : 'Raw difference: ', h('b', {}, effect(r.diff, t)), ` (${ciText(r.ci, t)}), ${r.grade} effect`,
      ctx.primary ? (r.probable ? ', probable.' : '; does not survive the correction for the number of things tested, so treat it as a hunch.') : ' (Explore: uncorrected).'),
    scatter(r.pairs, { xLabel: m.name, xKind: kindOf(m), yKind: kindOf(t) }),
    h('small', { class: 'muted' }, `Dots are raw days (not weekday-adjusted); the line is the plain straight-line fit.`),
    lagBox,
    h('p', { class: 'small' }, h('b', {}, `Split-half check${ctx.lag ? ' (next day)' : ''}: `), halves
      ? `first half of the data ${effect(sh.first.diff, t)} (${sh.first.n} days), second half ${effect(sh.second.diff, t)} (${sh.second.n} days). ${sameSign ? 'Same direction in both halves.' : 'The halves disagree, so this may be a phase rather than a pattern.'}`
      : 'not enough days in one of the halves.'),
    h('p', { class: 'small muted' }, `Spearman ρ = ${r.rho.toFixed(2)}${ctx.adjust ? ' (weekday-adjusted)' : ''} over ${r.n} days; permutation p = ${r.p < 0.01 ? r.p.toFixed(3) : r.p.toFixed(2)} from ${r.shifts} circular shifts of the ${tn} series, which keeps day-to-day carryover and the weekly rhythm in the comparison.`),
    m.when === 'night-before' || t.when === 'night-before' ? h('p', { class: 'small muted' }, `${(m.when === 'night-before' ? m : t).name} is logged in the morning and counted for the evening before.`) : null,
    !ctx.lag ? h('p', { class: 'small muted' }, `Same-day pairs cannot tell whether ${tn} was rated before or after ${lower(m)}; the next-day comparison above is the only ordering check.`) : null));
  ctx.box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => lagBox.replaceChildren(...lagLines(r, ctx)), 20);
}

function lagLines(r, ctx) {
  const m = r.metric, t = ctx.target, tn = lower(t);
  let lagged = r.lagged ? r : null;
  if (!lagged) {
    const res = run(ctx.series, ctx.metrics, t.id, ctx.rangeDays, ctx.adjust, 1);
    lagged = res.results.find((x) => x.metric.id === m.id);
    if (!lagged) {
      const why = res.skipped.find((x) => x.metric.id === m.id);
      return [h('h4', {}, 'Which comes first?'), h('p', { class: 'small muted' }, `No next-day comparison: ${why ? why.reason : 'not enough consecutive days'}.`)];
    }
  }
  const f = lagged.forward, b = lagged.reverse, d = lagged.direction;
  // d.diff and d.ci are forward minus reverse with the sign of the same-day effect, so a positive
  // value means the forward effect is the bigger one whichever way the association points
  const flipped = d.ci ? [-d.ci[1], -d.ci[0]] : null;
  const dirText = d.label === 'x-first' ? `${m.name} seems to come first: the forward effect is bigger by ${size(d.diff, t)} (${ciText(d.ci, t)}).`
    : d.label === 'target-first' ? `${t.name} seems to come first: the reverse effect is bigger by ${size(d.diff, t)} (${ciText(flipped, t)}).`
    : `No evidence of direction: forward minus reverse is ${effect(d.diff, t)} (${ciText(d.ci, t)}, measured in the direction of the same-day effect), which does not clearly favour either order.`;
  return [
    h('h4', {}, 'Which comes first?'),
    h('p', { class: 'small' }, `${m.name} today → ${tn} tomorrow: `, h('b', {}, effect(f.diff, t)), ` (${ciText(f.ci, t)}, ${f.n} days).`),
    h('p', { class: 'small' }, `${t.name} today → ${lower(m)} tomorrow: `, h('b', {}, effect(b.diff, t)), ` (${tn} on the day before ${r.hi.label} vs before ${r.lo.label}; ${ciText(b.ci, t)}, ${b.n} days).`),
    h('p', { class: 'small' }, h('b', {}, dirText)),
  ];
}
