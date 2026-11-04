// Metric definitions: what gets tracked, how it's entered, and how it's derived.
// The list is user-editable in Settings and stored in meta 'metrics'. DEFAULT_METRICS is only
// the starting point for a fresh install; a personal list arrives with an imported backup.
import { getMeta, setMeta } from './db.js';

// type:
//   scale   - tap 1..max (mood, energy). min/max define the range.
//   count   - integer-ish counter with +/- (drinks, cups, push-up sets)
//   hours   - duration in hours, step 0.25/0.5
//   minutes - duration in minutes
//   time    - clock time; night:true stores bedtimes past midnight as 24h+ (see util.clockToMins)
//   bool    - yes/no habit chip
//   money   - currency amount
//   text    - short free text (not charted)
// polarity: 1 = more is better, -1 = more is worse, 0 = neutral. Only colours charts/insights.
// derived: computed from other data, never typed in ('food.kcal', 'food.protein', 'sleep', 'gratitude')
// source: 'fitbit' means the value can be filled by Fitbit sync (still editable by hand).

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

export const DEFAULT_METRICS = [
  { id: 'mood', name: 'Mood', type: 'scale', min: 1, max: 10, group: 'Check-in', polarity: 1, core: true },
  { id: 'energy', name: 'Energy', type: 'scale', min: 1, max: 10, group: 'Check-in', polarity: 1, core: true },
  { id: 'anxiety', name: 'Anxiety / stress', type: 'scale', min: 1, max: 10, group: 'Check-in', polarity: -1, core: true },

  { id: 'bed', name: 'Bedtime (last night)', type: 'time', night: true, group: 'Sleep', polarity: 0, source: 'fitbit' },
  { id: 'wake', name: 'Wake up', type: 'time', group: 'Sleep', polarity: 0, source: 'fitbit' },
  { id: 'sleep_hours', name: 'Sleep', type: 'hours', group: 'Sleep', polarity: 1, derived: 'sleep', unit: 'h' },
  { id: 'sleep_quality', name: 'Sleep quality', type: 'scale', min: 1, max: 5, group: 'Sleep', polarity: 1 },

  { id: 'exercise', name: 'Exercise', type: 'minutes', group: 'Body', polarity: 1, unit: 'min' },
  { id: 'steps', name: 'Steps', type: 'count', step: 500, group: 'Body', polarity: 1, source: 'fitbit' },
  { id: 'resting_hr', name: 'Resting heart rate', type: 'count', group: 'Body', polarity: -1, source: 'fitbit', unit: 'bpm', archived: true },

  { id: 'diet', name: 'Diet quality', type: 'scale', min: 1, max: 10, group: 'Food', polarity: 1 },
  { id: 'kcal', name: 'Calories', type: 'count', group: 'Food', polarity: 0, derived: 'food.kcal', unit: 'kcal' },
  { id: 'protein', name: 'Protein', type: 'count', group: 'Food', polarity: 1, derived: 'food.protein', unit: 'g' },

  { id: 'meditation', name: 'Meditation', type: 'minutes', group: 'Mind', polarity: 1, unit: 'min' },
  { id: 'focused_work', name: 'Focused work', type: 'hours', group: 'Mind', polarity: 1, unit: 'h' },
  { id: 'reading', name: 'Reading', type: 'hours', group: 'Mind', polarity: 1, unit: 'h' },

  { id: 'friends_irl', name: 'Friends in person', type: 'hours', group: 'Social', polarity: 1, unit: 'h' },
  { id: 'friends_online', name: 'Friends online', type: 'hours', group: 'Social', polarity: 0, unit: 'h' },
  { id: 'family', name: 'Family', type: 'hours', group: 'Social', polarity: 1, unit: 'h' },

  { id: 'nature', name: 'Outdoors / nature', type: 'hours', group: 'Leisure', polarity: 1, unit: 'h' },
  { id: 'games', name: 'Video games', type: 'hours', group: 'Leisure', polarity: 0, unit: 'h' },

  { id: 'gratitude', name: 'Gratitude written', type: 'bool', group: 'Habits', polarity: 1, derived: 'gratitude' },
  { id: 'chores', name: 'Chores / errands', type: 'bool', group: 'Habits', polarity: 1 },
  { id: 'vitamins', name: 'Vitamins', type: 'bool', group: 'Habits', polarity: 1 },

  { id: 'alcohol', name: 'Alcohol', type: 'count', group: 'Substances', polarity: -1, unit: 'drinks' },
  { id: 'caffeine', name: 'Caffeine', type: 'count', group: 'Substances', polarity: 0, unit: 'cups' },

  { id: 'spending', name: 'Spending', type: 'money', group: 'Other', polarity: -1, unit: '$' },
];

export const DEFAULT_SETTINGS = {
  dayStartHour: 4,
  insightsTarget: 'mood',
  ai: {
    provider: 'gemini', // 'none' | 'gemini' | 'claude'; nothing is sent until a key is pasted
    geminiKey: '',
    geminiModel: 'gemini-2.5-flash',
    claudeKey: '',
    claudeModel: 'claude-opus-5-5',
  },
  health: { clientId: '', clientSecret: '', accessToken: '', refreshToken: '', expiresAt: 0, lastSync: '' },
  kcalGoal: 0,
  proteinGoal: 0,
};

let cache = null;

export async function loadMetrics() {
  if (cache) return cache;
  cache = await getMeta('metrics', null);
  if (!cache) { cache = structuredClone(DEFAULT_METRICS); await setMeta('metrics', cache); }
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
  const s = await getMeta('settings', {});
  return deepMerge(structuredClone(DEFAULT_SETTINGS), s);
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

// Fill in derived values for a day. foodTotals = {kcal, protein, carbs, fat, n} or null.
// A value typed by hand for a derived metric wins (lets imported history keep its totals).
export function resolveValues(day, metrics, foodTotals) {
  const v = { ...(day.values || {}) };
  for (const m of metrics) {
    if (!m.derived) continue;
    if (m.derived === 'sleep') {
      const bed = v.bed, wake = v.wake;
      if (v[m.id] == null && bed != null && wake != null) {
        let mins = wake + 1440 - bed; // bed is night-normalised, wake is same-morning
        if (mins > 1440) mins -= 1440;
        if (mins > 0 && mins < 20 * 60) v[m.id] = Math.round(mins / 6) / 10;
      }
    } else if (m.derived.startsWith('food.')) {
      const k = m.derived.slice(5);
      if (v[m.id] == null && foodTotals && foodTotals.n > 0) v[m.id] = Math.round(foodTotals[k] || 0);
    } else if (m.derived === 'gratitude') {
      if (v[m.id] == null && day.gratitude && day.gratitude.trim()) v[m.id] = 1;
    }
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
