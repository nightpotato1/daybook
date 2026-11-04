// Read-side helpers: turn stored days + food into resolved per-day values for charts/insights.
import { db } from './db.js';
import { resolveValues, numericValue, isCheckedIn, activeMetrics } from './metrics.js';
import { validYmd, parseYmd, addDays, fmtNum } from './util.js';

export function foodTotals(entries) {
  const t = { kcal: 0, protein: 0, carbs: 0, fat: 0, n: 0 };
  for (const e of entries) {
    t.kcal += Number(e.kcal) || 0;
    t.protein += Number(e.protein) || 0;
    t.carbs += Number(e.carbs) || 0;
    t.fat += Number(e.fat) || 0;
    t.n++;
  }
  return t;
}

export async function foodByDate() {
  const all = await db.all('food');
  const by = new Map();
  for (const e of all) {
    if (!by.has(e.date)) by.set(e.date, []);
    by.get(e.date).push(e);
  }
  return by;
}

// Returns [{date, v:{metricId:number|null}, day, checkedIn}] sorted by date, one entry per day that
// has a day record or food. Rows keyed by something that is not a real date are ignored.
export async function loadSeries(metrics) {
  const [days, foods] = await Promise.all([db.all('days'), foodByDate()]);
  const dates = new Set(days.map((d) => d.date));
  for (const d of foods.keys()) dates.add(d);
  const dayMap = new Map(days.map((d) => [d.date, d]));
  const out = [];
  for (const date of [...dates].filter(validYmd).sort()) {
    const day = dayMap.get(date) || { date, values: {} };
    const ft = foods.has(date) ? foodTotals(foods.get(date)) : null;
    const raw = resolveValues(day, metrics, ft);
    const v = {};
    for (const m of metrics) v[m.id] = numericValue(m, raw[m.id]);
    out.push({ date, v, day, checkedIn: isCheckedIn(day, metrics) });
  }
  return out;
}

// Monday of the week containing the given date.
function weekStart(date) {
  const d = parseYmd(date);
  return addDays(date, -((d.getDay() + 6) % 7));
}

// Progress on each active metric that has a goal {per:'day'|'week', op:'>='|'<=', value}.
// per 'week' covers Monday..today: count/hours/minutes/money/bool are summed, scales averaged;
// per 'day' uses today's value only. Returns [{metric, value, target, op, per, met, label}].
// Nothing logged counts as 0 for summable metrics (so a "max" goal is met, not failed, on a day
// that is not checked in yet). A scale metric with no data keeps value null and met null
// ("not known yet"): callers must treat value == null / met == null as neutral, not as failed.
export function weeklyGoalProgress(series, metrics, today) {
  const out = [];
  const from = weekStart(today);
  const rows = series.filter((r) => r.date <= today && (r.date >= from));
  const todayRow = series.find((r) => r.date === today);
  for (const m of activeMetrics(metrics)) {
    const g = m.goal;
    if (!g || typeof g.value !== 'number' || isNaN(g.value)) continue;
    const per = g.per === 'day' ? 'day' : 'week';
    const op = g.op === '<=' ? '<=' : '>=';
    let value;
    if (per === 'day') {
      value = todayRow ? todayRow.v[m.id] : null;
    } else {
      const vals = rows.map((r) => r.v[m.id]).filter((x) => x != null);
      if (m.type === 'scale') value = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      else value = vals.reduce((a, b) => a + b, 0);
    }
    if (value == null && m.type !== 'scale') value = 0;
    const shown = value == null ? null : Math.round(value * 100) / 100;
    const met = shown == null ? null : (op === '>=' ? shown >= g.value : shown <= g.value);
    const unit = m.type === 'bool' ? '' : (m.unit ? ` ${m.unit}` : '');
    const span = per === 'day' ? 'today' : 'this week';
    const label = `${fmtNum(shown)} / ${op === '<=' ? 'max ' : ''}${fmtNum(g.value)}${unit} ${span}`;
    out.push({ metric: m, value: shown, target: g.value, op, per, met, label });
  }
  return out;
}
