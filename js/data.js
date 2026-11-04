// Read-side helpers: turn stored days + food into resolved per-day values for charts/insights.
import { db } from './db.js';
import { resolveValues, numericValue } from './metrics.js';

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

// Returns [{date, v:{metricId:number|null}, day}] sorted by date.
export async function loadSeries(metrics) {
  const [days, foods] = await Promise.all([db.all('days'), foodByDate()]);
  const dates = new Set(days.map((d) => d.date));
  for (const d of foods.keys()) dates.add(d);
  const dayMap = new Map(days.map((d) => [d.date, d]));
  const out = [];
  for (const date of [...dates].sort()) {
    const day = dayMap.get(date) || { date, values: {} };
    const ft = foods.has(date) ? foodTotals(foods.get(date)) : null;
    const raw = resolveValues(day, metrics, ft);
    const v = {};
    for (const m of metrics) v[m.id] = numericValue(m, raw[m.id]);
    out.push({ date, v, day });
  }
  return out;
}
