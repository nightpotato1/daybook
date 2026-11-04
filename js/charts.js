// Hand-rolled SVG charts (no library, works offline). Colours come from CSS variables in
// css/charts.css; every class is prefixed ch-. Value kinds: 'time' (minutes after midnight,
// night-normalised allowed), 'int' (small integer scale such as mood 1-10), or null (decimal).
import { h, svgEl as s, parseYmd, addDays, daysBetween, minsToClock, fmtNum, prettyDate } from './util.js';

const W = 360; // viewBox width; charts scale to the container

export function fmtY(v, kind) {
  if (v == null) return '–';
  if (kind === 'time') return minsToClock(v);
  return fmtNum(v, Math.abs(v) < 10 ? 1 : 0);
}

// Tick values for [lo, hi]. time: 15/30/60/120/180/240/360-minute steps on the clock grid;
// int: whole numbers that land on both ends of a <=10 span; otherwise decimal 1/2/2.5/5 steps.
export function niceTicks(lo, hi, n = 4, kind = null) {
  if (lo === hi) { lo -= 1; hi += 1; }
  let span = hi - lo;
  if (kind === 'time') {
    const step = [15, 30, 60, 120, 180, 240, 360].find((x) => span / x <= n) || 720;
    const out = [];
    for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + 1e-9; v += step) out.push(v);
    return out;
  }
  if (kind === 'int') {
    lo = Math.floor(lo); hi = Math.ceil(hi); span = hi - lo;
    if (span <= 10) {
      const cands = [1, 2, 3, 5].filter((x) => span / x <= 5);
      const step = cands.find((x) => span % x === 0) || cands[0] || 5;
      const out = [];
      for (let v = lo; v <= hi + 1e-9; v += step) out.push(v);
      if (out[out.length - 1] < hi) out.push(hi);
      return out;
    }
  }
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => span / x <= n) || mag * 10;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
  if (out.length < 2) out.push(Math.round((out[0] + step) * 1e6) / 1e6);
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

const empty = (svg, H, msg = 'No data in this range') => { svg.append(s('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'ch-empty' }, msg)); return svg; };

function axisRange(values, min, max, kind) {
  let lo = Math.min(...values), hi = Math.max(...values);
  if (min != null) lo = Math.min(lo, min);
  if (max != null) hi = Math.max(hi, max);
  const ticks = niceTicks(lo, hi, 4, kind);
  return { lo: Math.min(lo, ticks[0]), hi: Math.max(hi, ticks[ticks.length - 1]), ticks };
}

function rollingPath(points, x, y, window) {
  const roll = rolling(points, window);
  if (roll.length < 2) return null;
  let d = '';
  roll.forEach((p, i) => {
    const gap = i > 0 && daysBetween(roll[i - 1].date, p.date) > window; // break the line across gaps
    d += `${i === 0 || gap ? 'M' : 'L'}${x(p.date).toFixed(1)},${y(p.y).toFixed(1)}`;
  });
  return d;
}

// points: [{date, y}] (nulls removed).
// opts: {from, to, kind, min, max, rollingDays, height, goal,
//        overlay: {points, kind, min, max}}  second metric's 7-day line on a right-hand axis
export function lineChart(points, opts = {}) {
  const ov = opts.overlay && opts.overlay.points && opts.overlay.points.length > 2 ? opts.overlay : null;
  const H = opts.height || 180, padL = 36, padR = ov ? 38 : 8, padT = 10, padB = 22;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'ch-chart', role: 'img' });
  if (!points.length) return empty(svg, H);
  const from = opts.from || points[0].date, to = opts.to || points[points.length - 1].date;
  const span = Math.max(1, daysBetween(from, to));
  const win = opts.rollingDays || 7;
  const { lo, hi, ticks } = axisRange(points.map((p) => p.y), opts.min, opts.max, opts.kind);
  const x = (d) => padL + (daysBetween(from, d) / span) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo || 1)) * (H - padT - padB);

  for (const t of ticks) {
    svg.append(s('line', { x1: padL, x2: W - padR, y1: y(t), y2: y(t), class: 'ch-grid' }));
    svg.append(s('text', { x: padL - 4, y: y(t) + 3, 'text-anchor': 'end', class: 'ch-tick' }, fmtY(t, opts.kind)));
  }
  for (const d of [from, addDays(from, Math.round(span / 2)), to]) {
    svg.append(s('text', { x: x(d), y: H - 6, 'text-anchor': 'middle', class: 'ch-tick' },
      parseYmd(d).toLocaleDateString(undefined, span > 400 ? { month: 'short', year: '2-digit' } : { month: 'short', day: 'numeric' })));
  }
  if (opts.goal != null) svg.append(s('line', { x1: padL, x2: W - padR, y1: y(opts.goal), y2: y(opts.goal), class: 'ch-goal' }));

  const r = points.length > 200 ? 1.2 : points.length > 60 ? 1.8 : 2.6;
  const dots = s('g', { class: 'ch-dots' });
  for (const p of points) dots.append(s('circle', { cx: x(p.date), cy: y(p.y), r }, s('title', {}, `${p.date}: ${fmtY(p.y, opts.kind)}`)));
  svg.append(dots);
  const d = rollingPath(points, x, y, win);
  if (d) svg.append(s('path', { d, class: 'ch-trend' }));

  if (ov) {
    const inRange = ov.points.filter((p) => p.date >= from && p.date <= to);
    if (inRange.length > 2) {
      const o = axisRange(inRange.map((p) => p.y), ov.min, ov.max, ov.kind);
      const oy = (v) => padT + (1 - (v - o.lo) / (o.hi - o.lo || 1)) * (H - padT - padB);
      for (const t of o.ticks) svg.append(s('text', { x: W - padR + 4, y: oy(t) + 3, class: 'ch-tick ch-overlay-tick' }, fmtY(t, ov.kind)));
      const od = rollingPath(inRange, x, oy, win);
      if (od) svg.append(s('path', { d: od, class: 'ch-overlay' }));
    }
  }
  return svg;
}

// bars: [{label, y, n?, lo?, hi?, highlight?}] e.g. weekday averages (lo/hi = min/max whiskers) or
// weekly totals. Bars rise from zero and hang below it for negatives; time values are drawn as
// lollipops on a clock grid because a bar from 00:00 means nothing for a bedtime.
export function barChart(bars, opts = {}) {
  const H = opts.height || 150, padL = 36, padR = 6, padT = 10, padB = 22;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'ch-chart', role: 'img' });
  const vals = bars.flatMap((b) => [b.y, b.lo, b.hi]).filter((v) => v != null);
  if (!vals.length) return empty(svg, H);
  const time = opts.kind === 'time';
  const { lo, hi, ticks } = axisRange(vals, time ? undefined : 0, time ? undefined : 0, opts.kind);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo || 1)) * (H - padT - padB);
  const bw = (W - padL - padR) / bars.length;
  for (const t of ticks) {
    svg.append(s('line', { x1: padL, x2: W - padR, y1: y(t), y2: y(t), class: t === 0 && !time ? 'ch-grid ch-zero' : 'ch-grid' }));
    svg.append(s('text', { x: padL - 4, y: y(t) + 3, 'text-anchor': 'end', class: 'ch-tick' }, fmtY(t, opts.kind)));
  }
  bars.forEach((b, i) => {
    const cx = padL + i * bw + bw / 2;
    const title = s('title', {}, `${b.label}: ${fmtY(b.y, opts.kind)}${b.n ? ` (n=${b.n})` : ''}${b.lo != null && b.hi != null ? `, ${fmtY(b.lo, opts.kind)}–${fmtY(b.hi, opts.kind)}` : ''}`);
    if (b.y != null) {
      if (time) {
        svg.append(s('line', { x1: cx, x2: cx, y1: y(lo), y2: y(b.y), class: 'ch-stem' }));
        svg.append(s('circle', { cx, cy: y(b.y), r: Math.min(6, bw * 0.3), class: b.highlight ? 'ch-lolli hi' : 'ch-lolli' }, title));
      } else {
        const top = y(Math.max(0, b.y)), hgt = Math.abs(y(0) - y(b.y));
        svg.append(s('rect', { x: cx - bw * 0.35, y: top, width: bw * 0.7, height: Math.max(hgt, 0.5), rx: 2, class: `ch-bar${b.y < 0 ? ' neg' : ''}${b.highlight ? ' hi' : ''}` }, title));
      }
    }
    if (b.lo != null && b.hi != null && b.hi > b.lo) {
      const cap = Math.min(5, bw * 0.2);
      svg.append(s('g', { class: 'ch-whisker' },
        s('line', { x1: cx, x2: cx, y1: y(b.lo), y2: y(b.hi) }),
        s('line', { x1: cx - cap, x2: cx + cap, y1: y(b.lo), y2: y(b.lo) }),
        s('line', { x1: cx - cap, x2: cx + cap, y1: y(b.hi), y2: y(b.hi) })));
    }
    if (bars.length <= 12 || i % Math.ceil(bars.length / 8) === 0) {
      svg.append(s('text', { x: cx, y: H - 6, 'text-anchor': 'middle', class: 'ch-tick' }, b.label));
    }
  });
  return svg;
}

// Calendar heatmap: one square per day, 13 weeks per row (26 weeks = two rows), newest at the
// bottom right. Colour spans m.min..m.max when given, else the 5th-95th percentile of the
// metric's own values. Tapping a day writes it into the caption with a link to that day.
// Returns a <div class="ch-heat"> holding the svg and the caption.
export function heatmap(byDate, opts = {}) {
  const weeks = opts.weeks || 26, perRow = opts.perRow || 13;
  const cell = 20, gap = 3, gutter = 22, top = 14, rowH = top + 7 * (cell + gap) + 8;
  const rows = Math.ceil(weeks / perRow);
  const end = opts.to;
  const start = addDays(end, -parseYmd(end).getDay() - 7 * (weeks - 1));
  const vals = [...byDate.values()].filter((v) => v != null).sort((a, b) => a - b);
  const pct = (q) => vals[Math.min(vals.length - 1, Math.max(0, Math.round((vals.length - 1) * q)))];
  let lo = opts.min ?? (vals.length ? pct(0.05) : 0), hi = opts.max ?? (vals.length ? pct(0.95) : 1);
  if (hi <= lo) { lo = vals.length ? vals[0] : 0; hi = vals.length ? vals[vals.length - 1] : 1; }
  if (hi <= lo) hi = lo + 1;
  const Wd = gutter + perRow * (cell + gap), Hd = rows * rowH;
  const svg = s('svg', { viewBox: `0 0 ${Wd} ${Hd}`, class: 'ch-chart ch-heatmap', role: 'img' });
  const caption = h('div', { class: 'ch-caption muted small' }, 'Tap a day');
  for (let r = 0; r < rows; r++) {
    ['M', 'W', 'F'].forEach((l, i) => svg.append(s('text', { x: 0, y: r * rowH + top + (i * 2 + 1) * (cell + gap) + cell * 0.7, class: 'ch-tick' }, l)));
  }
  let selected = null;
  let d = start;
  while (d <= end) {
    const dt = parseYmd(d), wd = dt.getDay();
    const col = Math.floor(daysBetween(start, d) / 7), r = Math.floor(col / perRow), cx = col % perRow;
    const x = gutter + cx * (cell + gap), y = r * rowH + top + wd * (cell + gap);
    const v = byDate.get(d);
    let level = v == null ? -1 : Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
    if (opts.polarity === -1 && level >= 0) level = 1 - level;
    const cls = level < 0 ? 'ch-hc ch-none' : `ch-hc ch-l${Math.min(4, Math.floor(level * 4.999))}`;
    const rect = s('rect', { x, y, width: cell, height: cell, rx: 3, class: cls, tabindex: 0, role: 'button', 'aria-label': `${d}: ${v == null ? 'no data' : fmtY(v, opts.kind)}` });
    const date = d;
    const pick = () => {
      if (selected) selected.classList.remove('ch-sel');
      selected = rect; rect.classList.add('ch-sel');
      caption.replaceChildren(h('a', { href: `#/today/${date}` }, `${prettyDate(date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}: ${v == null ? 'no data' : fmtY(v, opts.kind)}`), ' ›');
    };
    rect.addEventListener('click', pick);
    rect.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    svg.append(rect);
    if (dt.getDate() === 1 || d === start) svg.append(s('text', { x, y: r * rowH + 10, class: 'ch-tick' }, dt.toLocaleDateString(undefined, { month: 'short' })));
    d = addDays(d, 1);
  }
  return h('div', { class: 'ch-heat' }, svg, caption);
}

// pairs: [{x, y}] ; draws points + least-squares line. opts: {xLabel, xKind, yKind, height}
export function scatter(pairs, opts = {}) {
  const H = opts.height || 220, padL = 36, padR = 8, padT = 10, padB = 30;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'ch-chart', role: 'img' });
  if (pairs.length < 3) return empty(svg, H, 'Too few days');
  const xs = pairs.map((p) => p.x), ys = pairs.map((p) => p.y);
  const xa = axisRange(xs, undefined, undefined, opts.xKind), ya = axisRange(ys, undefined, undefined, opts.yKind);
  const X = (v) => padL + ((v - xa.lo) / (xa.hi - xa.lo || 1)) * (W - padL - padR);
  const Y = (v) => padT + (1 - (v - ya.lo) / (ya.hi - ya.lo || 1)) * (H - padT - padB);
  for (const t of ya.ticks) { svg.append(s('line', { x1: padL, x2: W - padR, y1: Y(t), y2: Y(t), class: 'ch-grid' })); svg.append(s('text', { x: padL - 4, y: Y(t) + 3, 'text-anchor': 'end', class: 'ch-tick' }, fmtY(t, opts.yKind))); }
  for (const t of xa.ticks) svg.append(s('text', { x: X(t), y: H - 16, 'text-anchor': 'middle', class: 'ch-tick' }, fmtY(t, opts.xKind)));
  if (opts.xLabel) svg.append(s('text', { x: (W + padL) / 2, y: H - 3, 'text-anchor': 'middle', class: 'ch-axis-label' }, opts.xLabel));
  // jitter discrete values a little so stacks are visible
  const jit = (i) => ((i * 9301 + 49297) % 233280) / 233280 - 0.5;
  const xr = (xa.hi - xa.lo) || 1, yr = (ya.hi - ya.lo) || 1;
  pairs.forEach((p, i) => svg.append(s('circle', { cx: X(p.x + jit(i) * xr * 0.015), cy: Y(p.y + jit(i + 7) * yr * 0.02), r: 2.2, class: 'ch-sdot' })));
  const n = pairs.length, mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
  let sxy = 0, sxx = 0;
  pairs.forEach((p) => { sxy += (p.x - mx) * (p.y - my); sxx += (p.x - mx) ** 2; });
  if (sxx > 0) {
    const b = sxy / sxx, a = my - b * mx;
    svg.append(s('line', { x1: X(xa.lo), y1: Y(a + b * xa.lo), x2: X(xa.hi), y2: Y(a + b * xa.hi), class: 'ch-fit' }));
  }
  return svg;
}
