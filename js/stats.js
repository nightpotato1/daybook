// Statistics for n-of-1 daily data. Kept deliberately simple and conservative:
// Spearman correlation (robust to 0-heavy and ordinal data), an effective-sample-size
// correction for day-to-day autocorrelation, and Benjamini-Hochberg across all tests.
import { addDays } from './util.js';

export const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

function ranks(a) {
  const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
  const r = new Array(a.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

export function pearson(x, y) {
  const n = x.length;
  if (n < 3) return null;
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

export const spearman = (x, y) => pearson(ranks(x), ranks(y));

// lag-1 autocorrelation of a series that may have gaps: map date->value
function lag1(map) {
  const xs = [], ys = [];
  for (const [d, v] of map) { const n = map.get(addDays(d, 1)); if (n != null) { xs.push(v); ys.push(n); } }
  return xs.length > 10 ? (pearson(xs, ys) ?? 0) : 0;
}

function normCdf(z) {
  // Abramowitz-Stegun 26.2.17
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

// series: [{date, v:{id:num}}]; returns one result per other metric.
// lag = 0: X today vs target today; lag = 1: X today vs target tomorrow.
export function correlate(series, targetId, metrics, lag = 0) {
  const byDate = new Map(series.map((r) => [r.date, r.v]));
  const tMap = new Map(series.filter((r) => r.v[targetId] != null).map((r) => [r.date, r.v[targetId]]));
  const tAuto = lag1(tMap);
  const out = [];
  for (const m of metrics) {
    if (m.id === targetId || m.type === 'text') continue;
    const xs = [], ys = [], dates = [];
    const xMap = new Map();
    for (const r of series) {
      const xv = r.v[m.id];
      if (xv == null) continue;
      xMap.set(r.date, xv);
      const tv = lag ? byDate.get(addDays(r.date, lag))?.[targetId] : r.v[targetId];
      if (tv == null) continue;
      xs.push(xv); ys.push(tv); dates.push(r.date);
    }
    const n = xs.length;
    if (n < 14) continue;
    const distinct = new Set(xs).size;
    if (distinct < 2) continue;
    const rho = spearman(xs, ys);
    if (rho == null) continue;
    const xa = lag1(xMap);
    // only ever shrink n: negative products would claim more independence than we have
    const k = Math.max(0, Math.min(0.9, xa * tAuto));
    const nEff = Math.max(4, n * (1 - k) / (1 + k));
    const z = Math.atanh(Math.max(-0.999, Math.min(0.999, rho))) * Math.sqrt(nEff - 3);
    const p = 2 * (1 - normCdf(Math.abs(z)));
    // "with vs without": split at zero for 0-heavy metrics, otherwise at the median
    const zeros = xs.filter((v) => v === 0).length;
    let split, hiLabel, loLabel;
    if (m.type === 'bool') { split = 0.5; hiLabel = 'yes'; loLabel = 'no'; }
    else if (zeros / n > 0.3) { split = 1e-9; hiLabel = `any ${m.name.toLowerCase()}`; loLabel = 'none'; }
    else { const sorted = [...xs].sort((a, b) => a - b); split = sorted[Math.floor(n / 2)]; hiLabel = 'above median'; loLabel = 'at/below'; }
    const hiY = [], loY = [];
    xs.forEach((v, i) => ((m.type === 'bool' || zeros / n > 0.3 ? v >= split : v > split) ? hiY : loY).push(ys[i]));
    out.push({ metric: m, rho, n, nEff: Math.round(nEff), p, hi: { label: hiLabel, mean: mean(hiY), n: hiY.length }, lo: { label: loLabel, mean: mean(loY), n: loY.length }, pairs: xs.map((x, i) => ({ x, y: ys[i], date: dates[i] })) });
  }
  // Benjamini-Hochberg at q = 0.10
  const sorted = [...out].sort((a, b) => a.p - b.p);
  let cutoff = -1;
  sorted.forEach((r, i) => { if (r.p <= ((i + 1) / sorted.length) * 0.1) cutoff = i; });
  sorted.forEach((r, i) => { r.significant = i <= cutoff && Math.abs(r.rho) >= 0.1; });
  return out.sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho));
}

export function streak(series, id, test = (v) => v > 0, today) {
  const map = new Map(series.map((r) => [r.date, r.v[id]]));
  let d = today, cur = 0;
  if (map.get(d) == null) d = addDays(d, -1); // today not logged yet doesn't break the streak
  while (map.get(d) != null && test(map.get(d))) { cur++; d = addDays(d, -1); }
  let best = 0, run = 0, prev = null;
  for (const r of series) {
    const v = r.v[id];
    if (v != null && test(v) && (prev == null || addDays(prev, 1) === r.date)) run++;
    else run = v != null && test(v) ? 1 : 0;
    prev = v != null && test(v) ? r.date : null;
    best = Math.max(best, run);
  }
  return { current: cur, best };
}
