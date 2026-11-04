// Fitbit data through the Google Health API (the legacy Fitbit Web API was switched off on
// 2026-11-02). Runs entirely on the phone: Google OAuth 2.0 authorization code + PKCE. Google's
// "Web application" clients still require the client secret at token exchange, so the user pastes
// it into Settings; it never leaves this device except to Google's token endpoint.
//
// Prerequisites (one time, decision tree in docs/SETUP-health.md):
//   0. A tracker the Health API can see, and a Fitbit account that was moved to a Google account.
//   1. The tracker syncs into the Google Health app signed in with that Google account.
//   2. Google Cloud project with the Google Health API enabled, OAuth consent screen published
//      (Testing status = refresh tokens die after 7 days), Web OAuth client whose authorized
//      redirect URI is exactly this app's URL.
//
// Request shapes checked against the v4 reference and the filters guide (2026-11-04): filter
// identifiers are snake_case; sleep can only be filtered on interval.end_time / civil_end_time;
// daily types filter on {data_type}.date; dailyRollUp pages are capped at 90 one-day buckets.
// Still not run against a live account.
import { loadSettings, saveSettings, loadMetrics, saveMetrics } from './metrics.js';
import { db } from './db.js';
import { addDays, logicalToday, toast } from './util.js';

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const API = 'https://health.googleapis.com/v4/users/me';
const SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
].join(' ');
const PKCE_KEY = 'healthPkce';
const PKCE_MAX_AGE = 10 * 60 * 1000;
const NOT_LINKED_MSG = 'Google account has no Google Health profile: open the Google Health app, sign in with this Google account, sync once, then press Sync';

export const redirectUri = () => location.origin + location.pathname;

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HEALTH_DEFAULTS = { clientId: '', clientSecret: '', accessToken: '', refreshToken: '', expiresAt: 0, lastSync: '', lastError: '', linked: null };

// Fills in missing keys in place (never replaces the object: callers hold a reference to it).
function healthState(s) {
  if (!s.health) s.health = {};
  for (const [k, v] of Object.entries(HEALTH_DEFAULTS)) if (s.health[k] === undefined) s.health[k] = v;
  return s.health;
}

async function setError(s, msg) {
  healthState(s).lastError = msg;
  await saveSettings(s);
}

export async function connectHealth() {
  const s = await loadSettings();
  const hs = healthState(s);
  if (!hs.clientId || !hs.clientSecret) throw new Error('Enter the OAuth client ID and secret first');
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(12)));
  // localStorage, not sessionStorage: the consent page may open in a Chrome Custom Tab from the
  // installed PWA, and the redirect can land in a fresh browsing context.
  try { localStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state, at: Date.now() })); }
  catch { throw new Error('Browser storage is blocked (private window?); sign-in cannot complete here'); }
  hs.lastError = '';
  await saveSettings(s);
  const q = new URLSearchParams({
    client_id: hs.clientId, response_type: 'code', redirect_uri: redirectUri(), scope: SCOPES,
    code_challenge: challenge, code_challenge_method: 'S256', state,
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true',
  });
  location.href = `${AUTH}?${q}`;
}

// Called on every app start: finishes the OAuth redirect if ?code= or ?error= is present.
// Never throws: every failure is stored in settings.health.lastError, toasted, and shown in Settings.
export async function handleRedirect() {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return false;
  history.replaceState(null, '', redirectUri() + location.hash);
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(PKCE_KEY) || '{}'); } catch { saved = {}; }
  try { localStorage.removeItem(PKCE_KEY); } catch { /* storage blocked: nothing to clear */ }
  const s = await loadSettings();
  const hs = healthState(s);
  let msg = '';
  try {
    if (q.has('error')) throw new Error(`Google refused the sign-in: ${q.get('error')}${q.has('error_description') ? ` (${q.get('error_description')})` : ''}`);
    if (!saved.verifier || !saved.at || Date.now() - saved.at > PKCE_MAX_AGE) throw new Error('Sign-in took longer than 10 minutes; press Connect again');
    if (saved.state !== q.get('state')) throw new Error('Sign-in state mismatch (another Connect was started in between); press Connect again');
    await tokenRequest(s, { grant_type: 'authorization_code', code: q.get('code'), code_verifier: saved.verifier, redirect_uri: redirectUri() });
    const linked = await checkLinked(s);
    msg = linked ? 'Google Health connected' : NOT_LINKED_MSG;
    hs.lastError = linked ? '' : NOT_LINKED_MSG;
  } catch (e) {
    msg = e.message;
    hs.lastError = e.message;
  }
  await saveSettings(s);
  toast(msg, 6000);
  location.hash = '#/settings';
  return true;
}

// GET /identity is Google's "is this Google account linked to a Health profile" check.
// Keeps the tokens either way; only settings.health.linked changes.
async function checkLinked(s) {
  const hs = healthState(s);
  try {
    await call(s, '/identity');
    hs.linked = true;
  } catch (e) {
    if (!e.notLinked) throw e;
    hs.linked = false;
  }
  await saveSettings(s);
  return hs.linked;
}

async function tokenRequest(s, params) {
  const hs = healthState(s);
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: hs.clientId, client_secret: hs.clientSecret, ...params }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (j.error === 'invalid_grant' && params.grant_type === 'refresh_token') {
      hs.refreshToken = '';
      hs.accessToken = '';
      await saveSettings(s);
      throw new Error('Google sign-in expired (a consent screen left in Testing lasts 7 days); press Connect again');
    }
    // A failed code exchange (wrong secret, redirect mismatch) leaves any existing connection alone.
    if (j.error === 'invalid_grant') throw new Error('Google rejected the sign-in code (invalid_grant): check the client secret and that the redirect URI in the Cloud console is exactly this app\'s URL, then press Connect again');
    throw new Error(`Google token ${res.status}: ${j.error_description || j.error || res.statusText}`);
  }
  hs.accessToken = j.access_token;
  if (j.refresh_token) hs.refreshToken = j.refresh_token;
  hs.expiresAt = Date.now() + ((j.expires_in || 3600) - 60) * 1000;
  await saveSettings(s);
  return s;
}

async function refresh(s) {
  const hs = healthState(s);
  if (!hs.refreshToken) throw new Error('Google Health is not connected');
  return tokenRequest(s, { grant_type: 'refresh_token', refresh_token: hs.refreshToken });
}

// One API call. 401 -> refresh the token and retry once (covers revoked tokens and a wrong phone
// clock); 429/504 -> back off 1/2/4 s. ACCOUNT_NOT_LINKED is flagged on the error for checkLinked;
// every thrown error carries e.status and e.body so callers can target a retry.
async function call(s, path, init = {}) {
  const hs = healthState(s);
  if (Date.now() > hs.expiresAt) await refresh(s);
  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + path, { ...init, headers: { Authorization: `Bearer ${hs.accessToken}`, Accept: 'application/json', ...(init.headers || {}) } });
    const j = await res.json().catch(() => ({}));
    if (res.ok) return j;
    if (res.status === 401 && !refreshed && hs.refreshToken) { refreshed = true; await refresh(s); continue; }
    if ((res.status === 429 || res.status === 504) && attempt < 3) { await sleep(1000 * 2 ** attempt); continue; }
    const msg = j.error?.message || res.statusText;
    const notLinked = /ACCOUNT_NOT_LINKED/.test(JSON.stringify(j));
    const e = new Error(notLinked ? NOT_LINKED_MSG : `Google Health ${res.status} on ${path.split('?')[0]}: ${msg}`);
    e.status = res.status;
    e.body = j;
    if (notLinked) e.notLinked = true;
    throw e;
  }
}

async function listAll(s, type, filter) {
  const out = [];
  let token = '';
  do {
    const q = new URLSearchParams({ filter });
    if (token) q.set('pageToken', token);
    const j = await call(s, `/dataTypes/${type}/dataPoints?${q}`);
    out.push(...(j.dataPoints || []));
    token = j.nextPageToken || '';
  } while (token && out.length < 5000);
  return out;
}

// Filter identifiers are snake_case (filters guide, checked 2026-11-04). The camelCase spelling of
// the response fields is kept as a fallback that is tried only when the API rejects the filter
// itself with a 400, so a doc change costs one extra request instead of a dead sync.
async function listWithFilters(s, type, filters) {
  for (let i = 0; ; i++) {
    try {
      return await listAll(s, type, filters[i]);
    } catch (e) {
      const badFilter = e.status === 400 && /INVALID_DATA_POINT_FILTER|filter/i.test(JSON.stringify(e.body || {}));
      if (!badFilter || i === filters.length - 1) throw e;
    }
  }
}

export function healthConnected(s) { return !!(s.health && s.health.refreshToken); }

// Mutates settings.health in place: Settings keeps a reference to it across Disconnect.
export function disconnectHealth(s) {
  Object.assign(healthState(s), { accessToken: '', refreshToken: '', expiresAt: 0, lastError: '', linked: null });
  return saveSettings(s);
}

const civil = (ymd) => { const [year, month, day] = ymd.split('-').map(Number); return { date: { year, month, day }, time: { hours: 0, minutes: 0, seconds: 0 } }; };
const ymdOf = (d) => `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
const minYmd = (a, b) => (a < b ? a : b);

// ISO timestamp + "+05:30"-style or "19800s"-style offset -> local wall-clock date and minutes,
// plus an absolute minute count for ordering and window checks.
function localParts(iso, offset) {
  const t = new Date(iso);
  let offMin = -t.getTimezoneOffset();
  if (typeof offset === 'string' && /^-?\d+(\.\d+)?s$/.test(offset)) offMin = Math.round(parseFloat(offset) / 60);
  else if (typeof offset === 'string' && /^[+-]\d{2}:\d{2}$/.test(offset)) offMin = (offset[0] === '-' ? -1 : 1) * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
  const local = new Date(t.getTime() + offMin * 60000);
  return { date: local.toISOString().slice(0, 10), mins: local.getUTCHours() * 60 + local.getUTCMinutes(), abs: Math.round(local.getTime() / 60000) };
}

// Steps: dailyRollUp in 90-day chunks (the range is closed-open and capped at 90 days), following
// nextPageToken inside each chunk because the page size is also capped at 90.
async function pullSteps(s, start, end, put) {
  for (let a = start; a <= end; a = addDays(a, 90)) {
    const b = minYmd(addDays(a, 90), addDays(end, 1));
    let token = '';
    do {
      const body = { range: { start: civil(a), end: civil(b) }, windowSizeDays: 1 };
      if (token) body.pageToken = token;
      const j = await call(s, '/dataTypes/steps/dataPoints:dailyRollUp', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      for (const r of j.rollupDataPoints || []) {
        const n = Number(r.steps?.countSum ?? r.steps?.count_sum ?? 0);
        if (n > 0 && r.civilStartTime?.date) put(ymdOf(r.civilStartTime.date), 'steps', n);
      }
      token = j.nextPageToken || '';
    } while (token);
  }
}

// Sleep: sessions are grouped by the local date they ended on. A night may be split into several
// sessions (long wake in the middle) and the list can repeat an interval, so: dedupe identical
// intervals, keep sessions that started after noon of the previous day (naps starting that
// afternoon are not part of the night), bed = earliest start, wake = latest end,
// sleep_hours = sum of minutesAsleep (stored for reference only: the Sleep row is derived from
// bed and wake by resolveValues). A morning nap (a session starting at or after 09:00 local
// once another session of that night has already ended) is not part of the night either; a block
// starting before 09:00 after any length of wake is, because Fitbit splits a night at long wakes.
function groupSleepSessions(sessions) {
  const nights = new Map();
  const seen = new Set();
  for (const x of [...sessions].sort((a, b) => a.st.abs - b.st.abs)) {
    const key = `${x.st.abs}-${x.en.abs}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const midnight = x.en.abs - x.en.mins; // local 00:00 of the end date
    const prevNoon = midnight - 12 * 60, endNoon = midnight + 12 * 60;
    if (x.st.abs < prevNoon || x.st.abs >= endNoon) continue;
    const n = nights.get(x.en.date) || { bed: null, wake: null, asleep: 0 };
    if (n.wake && x.st.abs >= n.wake.abs && x.st.mins >= 9 * 60) continue; // morning nap
    if (!n.bed || x.st.abs < n.bed.abs) n.bed = x.st;
    if (!n.wake || x.en.abs > n.wake.abs) n.wake = x.en;
    n.asleep += x.asleep;
    nights.set(x.en.date, n);
  }
  return nights;
}

async function pullSleep(s, start, end, put) {
  const pts = await listWithFilters(s, 'sleep', [
    `sleep.interval.civil_end_time >= "${start}" AND sleep.interval.civil_end_time < "${addDays(end, 1)}"`,
    `sleep.interval.civilEndTime >= "${start}" AND sleep.interval.civilEndTime < "${addDays(end, 1)}"`,
  ]);
  const sessions = [];
  for (const p of pts) {
    const sl = p.sleep || p;
    const iv = sl.interval || {};
    if (!iv.startTime || !iv.endTime) continue;
    const st = localParts(iv.startTime, iv.startUtcOffset), en = localParts(iv.endTime, iv.endUtcOffset);
    const asleep = Number(sl.summary?.minutesAsleep ?? 0) || (new Date(iv.endTime) - new Date(iv.startTime)) / 60000;
    sessions.push({ st, en, asleep });
  }
  for (const [date, n] of groupSleepSessions(sessions)) {
    if (date < start || date > end) continue;
    put(date, 'bed', n.bed.mins < 720 ? n.bed.mins + 1440 : n.bed.mins);
    put(date, 'wake', n.wake.mins);
    put(date, 'sleep_hours', Math.round(n.asleep / 6) / 10);
  }
}

// Resting heart rate: one point per day; snake_case filter identifier first, camelCase fallback;
// the response is camelCase.
async function pullRestingHr(s, start, end, put) {
  const pts = await listWithFilters(s, 'daily-resting-heart-rate', [
    `daily_resting_heart_rate.date >= "${start}" AND daily_resting_heart_rate.date < "${addDays(end, 1)}"`,
    `dailyRestingHeartRate.date >= "${start}" AND dailyRestingHeartRate.date < "${addDays(end, 1)}"`,
  ]);
  for (const p of pts) {
    const r = p.dailyRestingHeartRate || p;
    if (r.date && r.beatsPerMinute) put(typeof r.date === 'string' ? r.date : ymdOf(r.date), 'resting_hr', Math.round(Number(r.beatsPerMinute)));
  }
}

// Pull the last `days` days (default: since last sync, at least 2 days back; 30 on first sync).
// Hand-entered values are never overwritten; values that came from the device are refreshed.
// An ACCOUNT_NOT_LINKED answer at any point flips settings.health.linked back to false so Settings
// shows the not-linked line and the next Sync re-checks /identity.
export async function syncHealth(days) {
  let s = await loadSettings();
  if (!healthConnected(s)) throw new Error('Google Health is not connected');
  try {
    if (healthState(s).linked !== true && !(await checkLinked(s))) {
      const e = new Error(NOT_LINKED_MSG);
      e.notLinked = true;
      throw e;
    }
    const end = logicalToday(s.dayStartHour);
    const start = days ? addDays(end, -days) : s.health.lastSync ? addDays(s.health.lastSync, -2) : addDays(end, -30);
    const got = new Map();
    const put = (d, k, v) => { if (!got.has(d)) got.set(d, {}); got.get(d)[k] = v; };
    const failures = [];

    for (const pull of [pullSteps, pullSleep, pullRestingHr]) {
      try { await pull(s, start, end, put); } catch (e) { failures.push(e); }
    }
    const errors = failures.map((e) => e.message);
    if (!got.size && failures.length) {
      const e = new Error(errors.join(' | '));
      if (failures.some((f) => f.notLinked)) e.notLinked = true;
      throw e;
    }

    // make sure the metrics exist and are switched on when data arrives
    const metrics = await loadMetrics();
    const want = {
      steps: { name: 'Steps', type: 'count', group: 'Body', polarity: 1, unit: 'steps', step: 500 },
      resting_hr: { name: 'Resting heart rate', type: 'count', group: 'Body', polarity: -1, unit: 'bpm' },
    };
    let changed = false;
    for (const [id, def] of Object.entries(want)) {
      const m = metrics.find((x) => x.id === id);
      const has = [...got.values()].some((v) => v[id] != null);
      if (!m && has) { metrics.push({ id, ...def, source: 'fitbit', tier: 'more', system: true }); changed = true; }
      else if (m && m.archived && has) { m.archived = false; changed = true; }
    }
    if (changed) await saveMetrics(metrics);

    const updates = [];
    for (const [date, vals] of got) {
      const day = (await db.get('days', date)) || { date, values: {}, title: '', note: '', gratitude: '', src: {} };
      day.values = day.values || {};
      day.src = day.src || {};
      for (const [k, v] of Object.entries(vals)) {
        if (day.values[k] != null && day.src[k] !== 'fitbit') continue; // typed by hand: keep
        day.values[k] = v;
        day.src[k] = 'fitbit';
      }
      day.updatedAt = Date.now();
      updates.push(day);
    }
    await db.putMany('days', updates);
    s = await loadSettings();
    healthState(s).lastSync = end;
    if (failures.some((f) => f.notLinked)) s.health.linked = false;
    s.health.lastError = errors.join(' | ');
    await saveSettings(s);
    return { days: updates.length, start, end, errors };
  } catch (e) {
    const latest = await loadSettings();
    if (e.notLinked) healthState(latest).linked = false;
    await setError(latest, e.message);
    throw e;
  }
}
