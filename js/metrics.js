// Metric definitions: what gets tracked, how it's entered, and how it's derived.
// The list is user-editable in Settings and stored in meta 'metrics'. DEFAULT_METRICS is only
// the starting point for a fresh install; a personal list arrives with an imported backup.
import { getMeta, setMeta } from './db.js';

// Shape (docs/v2-design.md 3.1):
//   id, name, type, group, polarity
//   type:
//     scale   - tap a number. min (default 1), max (default 10), step 1 or 0.5 (default 1)
//     count   - +/- counter; step = increment (default 1)
//     hours   - duration in hours
//     minutes - duration in minutes
//     time    - clock time in minutes; night:true stores bedtimes past midnight as 24h+ (see util.clockToMins)
//     bool    - yes/no habit chip
//     money   - currency amount
//     text    - short free text (not charted)
//   polarity: 1 = more is better, -1 = more is worse, 0 = neutral. Only colours charts/insights.
//   derived:  computed from other data, never typed in ('sleep', 'food.kcal', 'food.protein', 'gratitude')
//   source:   'fitbit' means the value can be filled by Fitbit sync (still editable by hand)
//   tier:     'core' (check-in stage) | 'event' (what-happened chips) | 'more' (collapsed); see tierOf()
//   goal:     { per: 'day'|'week', op: '>='|'<=', value } habit target; see data.weeklyGoalProgress
//   when:     'night-before' = belongs to the previous evening for lag analysis (bed)
//   system:   code depends on this id; Settings may turn it off but never delete it

export const GROUPS = ['Check-in', 'Sleep', 'Body', 'Food', 'Mind', 'Social', 'Leisure', 'Habits', 'Substances', 'Other'];

export const TYPES = {
  scale: 'Scale (tap a number)',
  count: 'Count',
  hours: 'Hours',
  minutes: 'Minutes',
  time: 'Clock time',
  bool: 'Yes / no',
  money: 'Money',
  text: 'Short text',
};

// Ids the code reads directly (sleep derivation, food totals, Fitbit sync, insights target).
export const SYSTEM_IDS = ['mood', 'bed', 'wake', 'sleep_hours', 'kcal', 'protein', 'gratitude', 'steps', 'resting_hr'];

const CORE_IDS = ['mood', 'energy', 'anxiety', 'sleep_quality'];

export const DEFAULT_METRICS = [
  { id: 'mood', name: 'Mood', type: 'scale', min: 1, max: 10, step: 0.5, group: 'Check-in', polarity: 1, tier: 'core', system: true },
  { id: 'energy', name: 'Energy', type: 'scale', min: 1, max: 10, group: 'Check-in', polarity: 1, tier: 'core' },
  { id: 'anxiety', name: 'Anxiety / stress', type: 'scale', min: 1, max: 10, group: 'Check-in', polarity: -1, tier: 'core' },
  { id: 'sleep_quality', name: 'Sleep quality', type: 'scale', min: 1, max: 5, group: 'Sleep', polarity: 1, tier: 'core' },

  { id: 'bed', name: 'Bedtime (last night)', type: 'time', night: true, group: 'Sleep', polarity: 0, source: 'fitbit', tier: 'more', when: 'night-before', system: true },
  { id: 'wake', name: 'Wake up', type: 'time', group: 'Sleep', polarity: 0, source: 'fitbit', tier: 'more', system: true },
  { id: 'sleep_hours', name: 'Sleep', type: 'hours', group: 'Sleep', polarity: 1, derived: 'sleep', unit: 'h', system: true },

  { id: 'exercise', name: 'Exercise', type: 'minutes', group: 'Body', polarity: 1, unit: 'min', tier: 'event', goal: { per: 'week', op: '>=', value: 90 } },
  { id: 'steps', name: 'Steps', type: 'count', step: 500, group: 'Body', polarity: 1, source: 'fitbit', tier: 'more', system: true },
  { id: 'resting_hr', name: 'Resting heart rate', type: 'count', group: 'Body', polarity: -1, source: 'fitbit', unit: 'bpm', tier: 'more', system: true, archived: true },

  { id: 'diet', name: 'Diet quality', type: 'scale', min: 1, max: 10, group: 'Food', polarity: 1, tier: 'event' },
  { id: 'kcal', name: 'Calories', type: 'count', group: 'Food', polarity: 0, derived: 'food.kcal', unit: 'kcal', system: true },
  { id: 'protein', name: 'Protein', type: 'count', group: 'Food', polarity: 1, derived: 'food.protein', unit: 'g', system: true },

  { id: 'meditation', name: 'Meditation', type: 'minutes', group: 'Mind', polarity: 1, unit: 'min', tier: 'event', goal: { per: 'week', op: '>=', value: 60 } },
  { id: 'focused_work', name: 'Focused work', type: 'hours', group: 'Mind', polarity: 1, unit: 'h', tier: 'event' },
  { id: 'reading', name: 'Reading', type: 'hours', group: 'Mind', polarity: 1, unit: 'h', tier: 'event' },

  { id: 'friends_irl', name: 'Friends in person', type: 'hours', group: 'Social', polarity: 1, unit: 'h', tier: 'event' },
  { id: 'friends_online', name: 'Friends online', type: 'hours', group: 'Social', polarity: 0, unit: 'h', tier: 'event' },
  { id: 'family', name: 'Family', type: 'hours', group: 'Social', polarity: 1, unit: 'h', tier: 'event' },

  { id: 'nature', name: 'Outdoors / nature', type: 'hours', group: 'Leisure', polarity: 1, unit: 'h', tier: 'event' },
  { id: 'games', name: 'Video games', type: 'hours', group: 'Leisure', polarity: 0, unit: 'h', tier: 'event' },

  { id: 'gratitude', name: 'Gratitude written', type: 'bool', group: 'Habits', polarity: 1, derived: 'gratitude', system: true },
  { id: 'chores', name: 'Chores / errands', type: 'bool', group: 'Habits', polarity: 1, tier: 'event' },
  { id: 'vitamins', name: 'Vitamins', type: 'bool', group: 'Habits', polarity: 1, tier: 'event' },

  { id: 'alcohol', name: 'Alcohol', type: 'count', group: 'Substances', polarity: -1, unit: 'drinks', tier: 'event' },
  { id: 'caffeine', name: 'Caffeine', type: 'count', group: 'Substances', polarity: 0, unit: 'cups', tier: 'event' },

  { id: 'spending', name: 'Spending', type: 'money', group: 'Other', polarity: -1, unit: '$', tier: 'event' },
];

export const DEFAULT_SETTINGS = {
  dayStartHour: 4,
  insightsTarget: 'mood',
  ai: {
    provider: 'gemini', // 'none' | 'gemini' | 'claude'; nothing is sent until a key is pasted
    geminiKey: '',
    geminiModel: 'gemini-3.8-flash',
    claudeKey: '',
    claudeModel: 'claude-haiku-5-5',
    foodContext: '', // "my usual foods and measures", injected into the food prompt
  },
  health: { clientId: '', clientSecret: '', accessToken: '', refreshToken: '', expiresAt: 0, lastSync: '', lastError: '', linked: null },
  kcalGoal: 0,
  proteinGoal: 0,
  reminderTime: '21:30',
  goalsText: '', // the user's life goals, free text, shown on Insights
};

let cache = null;

export async function loadMetrics() {
  if (cache) return cache;
  let list = await getMeta('metrics', null);
  if (!Array.isArray(list) || !list.length) {
    list = structuredClone(DEFAULT_METRICS);
    await setMeta('metrics', list);
  } else if (list.some((m) => SYSTEM_IDS.includes(m.id) && !m.system)) {
    // Lists saved before the system flag existed: mark the ids the code depends on.
    for (const m of list) if (SYSTEM_IDS.includes(m.id)) m.system = true;
    await setMeta('metrics', list);
  }
  cache = list;
  return cache;
}

export async function saveMetrics(list) {
  cache = list;
  await setMeta('metrics', list);
}

export function activeMetrics(list) {
  return list.filter((m) => !m.archived);
}

export async function loadSettings() {
  const stored = await getMeta('settings', {});
  const s = deepMerge(structuredClone(DEFAULT_SETTINGS), stored);
  let changed = false;
  if (['gemini-2.5-flash', 'gemini-2.5-flash-lite'].includes(s.ai.geminiModel)) { s.ai.geminiModel = 'gemini-3.8-flash'; changed = true; }
  // The v1 default was Opus; only replace it when Claude was never set up (no key), so a real choice stays.
  if (s.ai.claudeModel === 'claude-opus-5-5' && !s.ai.claudeKey) { s.ai.claudeModel = 'claude-haiku-5-5'; changed = true; }
  if ('fitbit' in s) { delete s.fitbit; changed = true; }
  if (changed) await saveSettings(s);
  return s;
}

export const saveSettings = (s) => setMeta('settings', s);

function deepMerge(base, over) {
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') deepMerge(base[k], v);
    else base[k] = v;
  }
  return base;
}

export function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'metric';
}

const TIERS = ['core', 'event', 'more'];

// Which stage of the Today screen a metric belongs to. null for derived metrics (they are shown
// as auto rows). Falls back to the v1 `core` flag and to the type when `tier` is not set.
export function tierOf(m) {
  if (m.derived) return null;
  if (TIERS.includes(m.tier)) return m.tier;
  if (m.core || CORE_IDS.includes(m.id)) return 'core';
  if (m.type === 'time' || m.source === 'fitbit') return 'more';
  return 'event';
}

// Metrics where "not mentioned" on a checked-in day means "did not happen" (resolves to 0).
export function isEventLike(m) {
  if (m.source || m.derived) return false;
  if (['bool', 'count', 'hours', 'minutes', 'money'].includes(m.type)) return true;
  return m.type === 'scale' && m.min === 0;
}

const hasValue = (x) => x != null && x !== '';

// A day is checked in once any core-tier metric (mood, energy, ...) has a stored value.
export function isCheckedIn(day, metrics) {
  const vals = (day && day.values) || {};
  return metrics.some((m) => !m.derived && tierOf(m) === 'core' && hasValue(vals[m.id]));
}

// Selectable values of a scale metric, honouring min/max/step (step 0.5 gives half points).
export function scaleValues(m) {
  const min = m.min ?? 1, max = m.max ?? 10;
  const step = m.step === 0.5 ? 0.5 : 1;
  const out = [];
  for (let i = 0; out.length < 200; i++) {
    const v = Math.round((min + i * step) * 100) / 100;
    if (v > max + 1e-9) break;
    out.push(v);
  }
  return out;
}

// Resolve a day's values for charts, insights, CSV and the Today auto rows.
// foodTotals = {kcal, protein, carbs, fat, n} or null.
// Rules (contract 3.1): stored values first; a stored value for a derived metric is never read;
// sleep from bed/wake; kcal/protein from the food log when it has entries; gratitude 1 when the day
// has gratitude text, 0 when checked in without text, else null; every event-like metric that is
// blank resolves to 0 on a checked-in day and stays null otherwise.
export function resolveValues(day, metrics, foodTotals) {
  const stored = (day && day.values) || {};
  const v = { ...stored };
  const checked = isCheckedIn(day, metrics);
  for (const m of metrics) {
    if (m.derived) {
      delete v[m.id];
      if (m.derived === 'sleep') {
        const bed = Number(stored.bed), wake = Number(stored.wake);
        // The tracker's own "minutes asleep" beats bed-to-wake arithmetic when the device supplied it.
        if (day && day.src && day.src[m.id] === 'fitbit' && hasValue(stored[m.id])) v[m.id] = Number(stored[m.id]);
        else if (hasValue(stored.bed) && hasValue(stored.wake) && !isNaN(bed) && !isNaN(wake)) {
          let mins = wake + 1440 - bed; // bed is night-normalised, wake is same-morning
          if (mins > 1440) mins -= 1440;
          if (mins > 0 && mins < 20 * 60) v[m.id] = Math.round(mins / 6) / 10;
        }
      } else if (m.derived.startsWith('food.')) {
        const k = m.derived.slice(5);
        if (foodTotals && foodTotals.n > 0) v[m.id] = Math.round(foodTotals[k] || 0);
      } else if (m.derived === 'gratitude') {
        if (day && day.gratitude && String(day.gratitude).trim()) v[m.id] = 1;
        else if (checked) v[m.id] = 0;
      }
      continue;
    }
    if (checked && isEventLike(m) && !hasValue(v[m.id])) v[m.id] = 0;
  }
  return v;
}

export function numericValue(m, val) {
  if (val == null || val === '') return null;
  if (m.type === 'text') return null;
  if (m.type === 'bool') return val ? 1 : 0;
  const n = Number(val);
  return isNaN(n) ? null : n;
}

export function isChartable(m) {
  return m.type !== 'text';
}
