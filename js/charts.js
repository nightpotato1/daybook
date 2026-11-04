// Hand-rolled SVG charts (no library, works offline). Colours come from CSS variables.
import { svgEl as s, parseYmd, addDays, daysBetween, minsToClock, fmtNum } from './util.js';

const W = 360; // viewBox width; charts scale to the container

function fmtY(v, kind) {
  if (kind === 'time') return minsToClock(v);
  return fmtNum(v, Math.abs(v) < 10 ? 1 : 0);
}

function niceTicks(lo, hi, n = 4) {
  if (lo === hi) { lo -= 1; hi += 1; }
  const span = hi - lo;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => span / x <= n) || mag * 10;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

export function rolling(points, window) {
  // points sorted by date [{date, y}], gaps allowed; average of non-null values in the trailing window
  const out = [];
  const q = [];
  let sum = 0;
  for (const p of points) {
    q.push(p); sum += p.y;
    while (daysBetween(q[0].date, p.date) >= window) sum -= q.shift().y;
    if (q.length >= Math.min(3, window)) out.push({ date: p.date, y: sum / q.length });
  }
  return out;
}

// points: [{date, y}] (nulls removed). opts: {from, to, kind, rollingDays, height, goal}
export function lineChart(points, opts = {}) {
  const H = opts.height || 180, padL = 34, padR = 8, padT = 10, padB = 22;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img' });
  if (!points.length) { svg.append(s('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'chart-empty' }, 'No data in this range')); return svg; }
  const from = opts.from || points[0].date, to = opts.to || points[points.length - 1].date;
  const span = Math.max(1, daysBetween(from, to));
  const ys = points.map((p) => p.y);
  let lo = Math.min(...ys), hi = Math.max(...ys);
  if (opts.min != null) lo = Math.min(lo, opts.min);
  if (opts.max != null) hi = Math.max(hi, opts.max);
  const ticks = niceTicks(lo, hi);
  lo = Math.min(lo, ticks[0]); hi = Math.max(hi, ticks[ticks.length - 1]);
  const x = (d) => padL + (daysBetween(from, d) / span) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo || 1)) * (H - padT - padB);

  for (const t of ticks) {
    svg.append(s('line', { x1: padL, x2: W - padR, y1: y(t), y2: y(t), class: 'grid' }));
    svg.append(s('text', { x: padL - 4, y: y(t) + 3, 'text-anchor': 'end', class: 'tick' }, fmtY(t, opts.kind)));
  }
  // x labels: first, middle, last
  for (const d of [from, addDays(from, Math.round(span / 2)), to]) {
    svg.append(s('text', { x: x(d), y: H - 6, 'text-anchor': 'middle', class: 'tick' },
      parseYmd(d).toLocaleDateString(undefined, span > 400 ? { month: 'short', year: '2-digit' } : { month: 'short', day: 'numeric' })));
  }
  if (opts.goal != null) svg.append(s('line', { x1: padL, x2: W - padR, y1: y(opts.goal), y2: y(opts.goal), class: 'goal-line' }));

  const r = points.length > 200 ? 1.2 : points.length > 60 ? 1.8 : 2.6;
  const dots = s('g', { class: 'dots' });
  for (const p of points) dots.append(s('circle', { cx: x(p.date), cy: y(p.y), r }, s('title', {}, `${p.date}: ${fmtY(p.y, opts.kind)}`)));
  svg.append(dots);

  const roll = rolling(points, opts.rollingDays || 7);
  if (roll.length > 1) {
    // break the line across gaps longer than the window
    let d = '';
    roll.forEach((p, i) => {
      const gap = i > 0 && daysBetween(roll[i - 1].date, p.date) > (opts.rollingDays || 7);
      d += `${i === 0 || gap ? 'M' : 'L'}${x(p.date).toFixed(1)},${y(p.y).toFixed(1)}`;
    });
    svg.append(s('path', { d, class: 'trend' }));
  }
  return svg;
}

// bars: [{label, y}] e.g. weekday averages or weekly totals
export function barChart(bars, opts = {}) {
  const H = opts.height || 150, padL = 34, padR = 6, padT = 10, padB = 22;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img' });
  const vals = bars.map((b) => b.y).filter((v) => v != null);
  if (!vals.length) return svg;
  let lo = Math.min(0, ...vals), hi = Math.max(...vals);
  if (opts.kind === 'time') lo = Math.min(...vals) - 30;
  const ticks = niceTicks(lo, hi);
  hi = Math.max(hi, ticks[ticks.length - 1]);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo || 1)) * (H - padT - padB);
  const bw = (W - padL - padR) / bars.length;
  for (const t of ticks) {
    svg.append(s('line', { x1: padL, x2: W - padR, y1: y(t), y2: y(t), class: 'grid' }));
    svg.append(s('text', { x: padL - 4, y: y(t) + 3, 'text-anchor': 'end', class: 'tick' }, fmtY(t, opts.kind)));
  }
  bars.forEach((b, i) => {
    const bx = padL + i * bw + bw * 0.15;
    if (b.y != null) {
      svg.append(s('rect', { x: bx, y: y(b.y), width: bw * 0.7, height: Math.max(0, y(lo) - y(b.y)), rx: 2, class: b.highlight ? 'bar hi' : 'bar' },
        s('title', {}, `${b.label}: ${fmtY(b.y, opts.kind)}${b.n ? ` (n=${b.n})` : ''}`)));
    }
    if (bars.length <= 12 || i % Math.ceil(bars.length / 8) === 0) {
      svg.append(s('text', { x: bx + bw * 0.35, y: H - 6, 'text-anchor': 'middle', class: 'tick' }, b.label));
    }
  });
  return svg;
}

// GitHub-style calendar: one square per day for the last `weeks` weeks.
export function heatmap(byDate, opts = {}) {
  const weeks = opts.weeks || 26, cell = 12, gap = 2;
  const end = opts.to;
  const endD = parseYmd(end);
  const start = addDays(end, -(weeks * 7 - 1) - endD.getDay());
  const vals = [...byDate.values()].filter((v) => v != null);
  const lo = opts.min ?? Math.min(0, ...vals), hi = opts.max ?? Math.max(1, ...vals);
  const Wd = weeks * (cell + gap) + 24, Hd = 7 * (cell + gap) + 14;
  const svg = s('svg', { viewBox: `0 0 ${Wd + cell + gap} ${Hd}`, class: 'chart heat', role: 'img' });
  ['M', 'W', 'F'].forEach((l, i) => svg.append(s('text', { x: 0, y: 14 + (i * 2 + 1) * (cell + gap) + 9, class: 'tick' }, l)));
  let d = start, col = 0;
  while (d <= end) {
    const wd = parseYmd(d).getDay();
    if (wd === 0 && d !== start) col++;
    const v = byDate.get(d);
    let level = v == null ? -1 : (v - lo) / (hi - lo || 1);
    if (opts.polarity === -1 && level >= 0) level = 1 - level;
    const cls = level < 0 ? 'hc none' : `hc l${Math.min(4, Math.floor(level * 4.999))}`;
    svg.append(s('rect', { x: 20 + col * (cell + gap), y: 14 + wd * (cell + gap), width: cell, height: cell, rx: 2, class: cls },
      s('title', {}, `${d}: ${v == null ? 'no data' : fmtY(v, opts.kind)}`)));
    if (parseYmd(d).getDate() === 1) svg.append(s('text', { x: 20 + col * (cell + gap), y: 10, class: 'tick' }, parseYmd(d).toLocaleDateString(undefined, { month: 'short' })));
    d = addDays(d, 1);
  }
  return svg;
}

// pairs: [{x, y}] ; draws points + least-squares line
export function scatter(pairs, opts = {}) {
  const H = opts.height || 220, padL = 34, padR = 8, padT = 10, padB = 30;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img' });
  if (pairs.length < 3) return svg;
  const xs = pairs.map((p) => p.x), ys = pairs.map((p) => p.y);
  const xt = niceTicks(Math.min(...xs), Math.max(...xs)), yt = niceTicks(Math.min(...ys), Math.max(...ys));
  const xlo = Math.min(xt[0], ...xs), xhi = Math.max(xt[xt.length - 1], ...xs);
  const ylo = Math.min(yt[0], ...ys), yhi = Math.max(yt[yt.length - 1], ...ys);
  const X = (v) => padL + ((v - xlo) / (xhi - xlo || 1)) * (W - padL - padR);
  const Y = (v) => padT + (1 - (v - ylo) / (yhi - ylo || 1)) * (H - padT - padB);
  for (const t of yt) { svg.append(s('line', { x1: padL, x2: W - padR, y1: Y(t), y2: Y(t), class: 'grid' })); svg.append(s('text', { x: padL - 4, y: Y(t) + 3, 'text-anchor': 'end', class: 'tick' }, fmtY(t, opts.yKind))); }
  for (const t of xt) svg.append(s('text', { x: X(t), y: H - 16, 'text-anchor': 'middle', class: 'tick' }, fmtY(t, opts.xKind)));
  if (opts.xLabel) svg.append(s('text', { x: (W + padL) / 2, y: H - 3, 'text-anchor': 'middle', class: 'axis-label' }, opts.xLabel));
  // jitter discrete values a little so stacks are visible
  const jit = (i) => ((i * 9301 + 49297) % 233280) / 233280 - 0.5;
  const xr = (xhi - xlo) || 1, yr = (yhi - ylo) || 1;
  pairs.forEach((p, i) => svg.append(s('circle', { cx: X(p.x + jit(i) * xr * 0.015), cy: Y(p.y + jit(i + 7) * yr * 0.02), r: 2.2, class: 'sdot' })));
  const n = pairs.length, mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
  let sxy = 0, sxx = 0;
  pairs.forEach((p) => { sxy += (p.x - mx) * (p.y - my); sxx += (p.x - mx) ** 2; });
  if (sxx > 0) {
    const b = sxy / sxx, a = my - b * mx;
    svg.append(s('line', { x1: X(xlo), y1: Y(a + b * xlo), x2: X(xhi), y2: Y(a + b * xhi), class: 'fit' }));
  }
  return svg;
}
