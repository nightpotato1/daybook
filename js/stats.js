// Statistics for n-of-1 daily data. Deliberately simple and conservative:
// Spearman correlation on weekday-adjusted series, a circular-shift permutation p
// (keeps autocorrelation and weekly structure in the null), a moving-block bootstrap
// CI for the with-minus-without difference, a minimum arm size before anything is
// tested, and Benjamini-Hochberg over the family actually tested.
import { addDays, parseYmd, minsToClock } from './util.js';

export const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

export function sd(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}

export function ranks(a) {
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

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// Small deterministic PRNG (mulberry32) so p-values and CIs are stable between renders.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (str) => { let x = 2166136261; for (const c of str) x = Math.imul(x ^ c.charCodeAt(0), 16777619); return x >>> 0; };

const weekday = (date) => parseYmd(date).getDay();

// Per-weekday means of a date->value map, computed on whatever days are available.
function weekdayMeansOf(map) {
  const sums = new Array(7).fill(0), ns = new Array(7).fill(0);
  for (const [d, v] of map) { const w = weekday(d); sums[w] += v; ns[w]++; }
  return sums.map((s, i) => ({ wd: i, mean: ns[i] ? s / ns[i] : null, n: ns[i] }));
}

// Subtract each weekday's own mean (a weekday with no data contributes nothing).
function adjustMap(map) {
  const wm = weekdayMeansOf(map);
  const out = new Map();
  for (const [d, v] of map) { const m = wm[weekday(d)].mean; if (m != null) out.set(d, v - m); }
  return out;
}

function seriesMap(series, id, shift = 0) {
  const map = new Map();
  for (const r of series) { const v = r.v[id]; if (v != null) map.set(shift ? addDays(r.date, shift) : r.date, v); }
  return map;
}

export const weekdayMeans = (series, id) => weekdayMeansOf(seriesMap(series, id));

// Map date -> value minus that weekday's mean, for one metric of a loadSeries() result.
export const weekdayAdjust = (series, id) => adjustMap(seriesMap(series, id));

const fmtNum = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

// Which days count as "with" and "without" for a metric. Bool: yes/no. Zero-heavy: any/none.
// Otherwise top vs bottom tertile (the middle third is left out), never a median split.
// Arm labels use clock times for time metrics (1560 would otherwise mean 02:00).
function armRule(m, xs) {
  const n = xs.length;
  const zeros = xs.filter((v) => v === 0).length;
  const fmt = (v) => (m.type === 'time' ? minsToClock(v) : fmtNum(v));
  if (m.type === 'bool') return { hi: (v) => v >= 0.5, lo: (v) => v < 0.5, hiLabel: 'yes', loLabel: 'no' };
  if (zeros / n > 0.3) return { hi: (v) => v > 0, lo: (v) => v === 0, hiLabel: `any ${m.name.toLowerCase()}`, loLabel: 'none' };
  const sorted = [...xs].sort((a, b) => a - b);
  let q1 = quantile(sorted, 1 / 3), q2 = quantile(sorted, 2 / 3);
  if (q1 === q2) return { hi: (v) => v > q1, lo: (v) => v < q1, hiLabel: `above ${fmt(q1)}`, loLabel: `below ${fmt(q1)}` };
  const late = m.type === 'time';
  return { hi: (v) => v >= q2, lo: (v) => v <= q1, hiLabel: `${late ? 'late' : 'high'} (≥ ${fmt(q2)})`, loLabel: `${late ? 'early' : 'low'} (≤ ${fmt(q1)})` };
}

// Moving-block bootstrap over an ordered row list: resample blocks of `block` consecutive rows,
// apply stat to the resampled rows, return the 95% percentile interval (null if too few succeed).
function blockBootstrap(rows, stat, random, B = 300, block = 7) {
  const n = rows.length;
  if (n < block * 2) return null;
  const out = [];
  const nb = Math.ceil(n / block);
  for (let b = 0; b < B; b++) {
    const sample = [];
    for (let k = 0; k < nb; k++) {
      const start = Math.floor(random() * (n - block + 1));
      for (let i = 0; i < block && sample.length < n; i++) sample.push(rows[start + i]);
    }
    const s = stat(sample);
    if (s != null && !isNaN(s)) out.push(s);
  }
  if (out.length < B * 0.8) return null;
  out.sort((a, b) => a - b);
  return [quantile(out, 0.025), quantile(out, 0.975)];
}

// Circular-shift permutation p for Spearman: shift the target ranks by a random offset along the
// paired sequence so day-to-day carryover and weekly rhythm survive in the null.
// 300 shifts normally; when none beats the observed rho the floor (1/301) is too coarse for BH over
// a few dozen tests, so those few metrics get 1000 more.
function shiftP(rx, ry, rho, random, shifts = 300) {
  const n = rx.length;
  const shifted = new Array(n);
  let worse = 0, done = 0;
  while (done < shifts) {
    const k = 1 + Math.floor(random() * (n - 1));
    for (let i = 0; i < n; i++) shifted[i] = ry[(i + k) % n];
    const r = pearson(rx, shifted);
    if (r != null && Math.abs(r) >= Math.abs(rho) - 1e-12) worse++;
    done++;
    if (done === shifts && worse === 0 && shifts === 300) shifts = 1300;
  }
  return { p: (worse + 1) / (done + 1), shifts: done };
}

// hi-minus-lo mean of a row list, using row.y (target) and row.x (raw metric) with an arm rule
function armDiff(rows, rule, yKey = 'y') {
  let sh = 0, nh = 0, sl = 0, nl = 0;
  for (const r of rows) {
    if (r.x == null || r[yKey] == null) continue;
    if (rule.hi(r.x)) { sh += r[yKey]; nh++; } else if (rule.lo(r.x)) { sl += r[yKey]; nl++; }
  }
  if (!nh || !nl) return null;
  return sh / nh - sl / nl;
}

function gradeOf(diff, targetSd) {
  if (diff == null || !targetSd) return 'negligible';
  const d = Math.abs(diff) / targetSd;
  return d < 0.2 ? 'negligible' : d < 0.5 ? 'small' : d < 0.8 ? 'moderate' : 'large';
}

// Benjamini-Hochberg: returns a Set of indexes rejected at q.
function bh(ps, q = 0.05) {
  const order = ps.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  let cutoff = -1;
  order.forEach(([p], i) => { if (p <= ((i + 1) / order.length) * q) cutoff = i; });
  return new Set(order.slice(0, cutoff + 1).map(([, i]) => i));
}

// One correlation of a paired row list [{x, y, ax, ay}] (ax/ay = weekday-adjusted when enabled).
function testPairs(rows, rule, random, targetSd) {
  const xs = rows.map((r) => r.ax), ys = rows.map((r) => r.ay);
  const rx = ranks(xs), ry = ranks(ys);
  const rho = pearson(rx, ry);
  if (rho == null) return null;
  const { p, shifts } = shiftP(rx, ry, rho, random);
  const diff = armDiff(rows, rule, 'ay');
  const ci = blockBootstrap(rows, (sample) => armDiff(sample, rule, 'ay'), random);
  return { rho, p, shifts, diff, ci, grade: gradeOf(diff, targetSd) };
}

// first-half vs second-half hi-minus-lo difference of an ordered row list
function splitOf(rows, rule) {
  const half = Math.floor(rows.length / 2);
  return {
    first: { diff: armDiff(rows.slice(0, half), rule, 'ay'), n: half },
    second: { diff: armDiff(rows.slice(half), rule, 'ay'), n: rows.length - half },
  };
}

// series: loadSeries() output. metrics: the candidate metrics (target included or not).
// opts: { targetId, adjustWeekday = true, lag: 0 | 1 }
// lag 1 computes forward (X today -> target tomorrow) and reverse (target today -> X tomorrow);
// the top-level rho/p/diff/ci are then the forward ones.
export function analyze(series, metrics, { targetId, adjustWeekday = true, lag = 0 } = {}) {
  const target = metrics.find((m) => m.id === targetId);
  const results = [], skipped = [];
  if (!target) return { results, skipped, targetSd: null, tested: 0 };
  const tRaw = seriesMap(series, targetId, target.when === 'night-before' ? -1 : 0);
  const tAdj = adjustWeekday ? adjustMap(tRaw) : tRaw;
  const targetSd = sd([...tRaw.values()]);

  for (const m of metrics) {
    if (m.id === targetId || m.type === 'text') continue;
    // a night-before metric (bedtime, logged in the morning) belongs to the previous evening
    const xRaw = seriesMap(series, m.id, m.when === 'night-before' ? -1 : 0);
    const xAdj = adjustWeekday ? adjustMap(xRaw) : xRaw;
    // one row per date that has X: same-day target, tomorrow's target, tomorrow's X
    const rows = [];
    for (const d of [...xRaw.keys()].sort()) {
      const d1 = addDays(d, 1);
      rows.push({ date: d, x: xRaw.get(d), ax: xAdj.get(d), y: tRaw.get(d), ay: tAdj.get(d),
        y1: tRaw.get(d1), ay1: tAdj.get(d1), x1: xRaw.get(d1), ax1: xAdj.get(d1) });
    }
    const same = rows.filter((r) => r.ax != null && r.ay != null);
    const n = same.length;
    if (n < 14) { skipped.push({ metric: m, reason: `only ${n} days logged together` }); continue; }
    if (new Set(same.map((r) => r.x)).size < 2) { skipped.push({ metric: m, reason: 'never varies' }); continue; }
    const rule = armRule(m, same.map((r) => r.x));
    const hiN = same.filter((r) => rule.hi(r.x)).length, loN = same.filter((r) => rule.lo(r.x)).length;
    const minArm = Math.max(10, Math.ceil(0.05 * n));
    if (Math.min(hiN, loN) < minArm) {
      skipped.push({ metric: m, reason: `only ${Math.min(hiN, loN)} days ${hiN < loN ? 'with' : 'without'} (${rule.hiLabel} vs ${rule.loLabel}), need ${minArm}` });
      continue;
    }
    const random = rng(hash(`${targetId}|${m.id}|${lag}|${adjustWeekday}`) ^ n);
    const hiY = same.filter((r) => rule.hi(r.x)).map((r) => r.y), loY = same.filter((r) => rule.lo(r.x)).map((r) => r.y);
    const base = {
      metric: m, n, hiN, loN, hi: { label: rule.hiLabel, mean: mean(hiY), n: hiN }, lo: { label: rule.loLabel, mean: mean(loY), n: loN },
      pairs: same.map((r) => ({ x: r.x, y: r.y, date: r.date })), splitHalf: splitOf(same, rule), lagged: lag === 1,
    };
    if (lag === 0) {
      const t = testPairs(same, rule, random, targetSd);
      if (!t) { skipped.push({ metric: m, reason: 'no variation to correlate' }); continue; }
      results.push({ ...base, ...t });
      continue;
    }
    // lag 1: forward uses (x, y1), reverse uses (x1, y); both bootstrapped on the same date blocks
    const fwdRows = rows.filter((r) => r.ax != null && r.ay1 != null).map((r) => ({ date: r.date, x: r.x, ax: r.ax, y: r.y1, ay: r.ay1 }));
    const revRows = rows.filter((r) => r.ax1 != null && r.ay != null).map((r) => ({ x: r.x1, ax: r.ax1, y: r.y, ay: r.ay }));
    const okArms = (rs) => Math.min(rs.filter((r) => rule.hi(r.x)).length, rs.filter((r) => rule.lo(r.x)).length) >= minArm;
    if (fwdRows.length < 14 || revRows.length < 14 || !okArms(fwdRows) || !okArms(revRows)) {
      skipped.push({ metric: m, reason: 'not enough consecutive days for a next-day comparison' });
      continue;
    }
    const forward = testPairs(fwdRows, rule, random, targetSd);
    const reverse = testPairs(revRows, rule, random, targetSd);
    if (!forward || !reverse) { skipped.push({ metric: m, reason: 'no variation to correlate' }); continue; }
    // Direction = forward minus reverse, sign-aligned with the same-day effect so that a positive
    // value always means "the forward effect is the bigger one" (a negative association would
    // otherwise flip the label). Labelled only when the bootstrap CI of that difference excludes 0.
    const sgn = Math.sign(armDiff(same, rule, 'ay') ?? forward.diff ?? 1) || 1;
    const dirStat = (sample) => {
      const f = armDiff(sample.map((r) => ({ x: r.x, ay: r.ay1 })), rule, 'ay');
      const b = armDiff(sample.map((r) => ({ x: r.x1, ay: r.ay })), rule, 'ay');
      return f == null || b == null ? null : sgn * (f - b);
    };
    const dirCi = blockBootstrap(rows, dirStat, random);
    const dirDiff = forward.diff != null && reverse.diff != null ? sgn * (forward.diff - reverse.diff) : null;
    const direction = { diff: dirDiff, ci: dirCi, sign: sgn, label: dirCi && (dirCi[0] > 0 || dirCi[1] < 0) ? (dirDiff > 0 ? 'x-first' : 'target-first') : 'none' };
    const fHiY = fwdRows.filter((r) => rule.hi(r.x)).map((r) => r.y), fLoY = fwdRows.filter((r) => rule.lo(r.x)).map((r) => r.y);
    results.push({ ...base, ...forward, n: fwdRows.length, hiN: fHiY.length, loN: fLoY.length,
      hi: { label: rule.hiLabel, mean: mean(fHiY), n: fHiY.length }, lo: { label: rule.loLabel, mean: mean(fLoY), n: fLoY.length },
      pairs: fwdRows.map((r) => ({ x: r.x, y: r.y, date: r.date })), splitHalf: splitOf(fwdRows, rule),
      forward: { ...forward, n: fwdRows.length }, reverse: { ...reverse, n: revRows.length }, direction });
  }
  const rejected = bh(results.map((r) => r.p), 0.05);
  results.forEach((r, i) => { r.probable = rejected.has(i); });
  return { results, skipped, targetSd, tested: results.length };
}

// Loop-style habit strength: exponential decay with a 7-day half-life. Logged days pull the score
// toward 100 (done) or 0 (not done); unlogged days leave it untouched. Also counts done/logged in
// the last 7 and 30 days up to `today`.
export function strengthScore(series, id, test = (v) => v > 0, today) {
  const decay = Math.pow(0.5, 1 / 7);
  let score = 0, done7 = 0, logged7 = 0, done30 = 0, logged30 = 0;
  const from30 = addDays(today, -29), from7 = addDays(today, -6);
  for (const r of series) {
    if (r.date > today) break;
    const v = r.v[id];
    if (v == null) continue;
    const ok = test(v) ? 1 : 0;
    score = score * decay + (1 - decay) * ok * 100;
    if (r.date >= from30) { logged30++; done30 += ok; }
    if (r.date >= from7) { logged7++; done7 += ok; }
  }
  return { score: Math.round(score), done7, logged7, done30, logged30 };
}

// Streak over logged days: unlogged days are skipped (neutral); only a logged failing value breaks it.
export function streak(series, id, test = (v) => v > 0, today) {
  const logged = series.filter((r) => r.v[id] != null && (!today || r.date <= today));
  let cur = 0;
  for (let i = logged.length - 1; i >= 0 && test(logged[i].v[id]); i--) cur++;
  let best = 0, run = 0;
  for (const r of logged) { run = test(r.v[id]) ? run + 1 : 0; best = Math.max(best, run); }
  return { current: cur, best };
}
