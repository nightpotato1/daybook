// Fitbit data through the Google Health API (the old Fitbit Web API shuts down 2026-11-02).
// Runs entirely on the phone: Google OAuth 2.0 authorization code + PKCE. Google's "Web
// application" clients still want the client secret at token exchange, so the user pastes it
// into Settings; it never leaves this device except to Google's token endpoint.
//
// Prerequisites (one time, see docs/SETUP-health.md):
//   1. Fitbit app (now "Google Health") linked to your Google account.
//   2. Google Cloud project with the Google Health API enabled, OAuth consent screen
//      published (Testing status = refresh tokens die after 7 days), Web OAuth client whose
//      authorized redirect URI is exactly this app's URL.
//
// UNVERIFIED against a live account (written 2026-10-30 from the v4 reference docs):
// the sleep list filter field and the exact JSON of sleep/resting-HR data points.
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

export const redirectUri = () => location.origin + location.pathname;

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function connectHealth() {
  const s = await loadSettings();
  if (!s.health.clientId || !s.health.clientSecret) throw new Error('Enter the OAuth client ID and secret first');
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(12)));
  sessionStorage.setItem('healthPkce', JSON.stringify({ verifier, state }));
  const q = new URLSearchParams({
    client_id: s.health.clientId, response_type: 'code', redirect_uri: redirectUri(), scope: SCOPES,
    code_challenge: challenge, code_challenge_method: 'S256', state,
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true',
  });
  location.href = `${AUTH}?${q}`;
}

// Called on every app start: finishes the OAuth redirect if ?code= is present.
export async function handleRedirect() {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return false;
  history.replaceState(null, '', redirectUri() + location.hash);
  if (q.has('error')) { toast(`Google: ${q.get('error')}`, 4000); return true; }
  const saved = JSON.parse(sessionStorage.getItem('healthPkce') || '{}');
  sessionStorage.removeItem('healthPkce');
  if (!saved.verifier || saved.state !== q.get('state')) { toast('Sign-in expired, try again', 4000); return true; }
  const s = await loadSettings();
  await tokenRequest(s, { grant_type: 'authorization_code', code: q.get('code'), code_verifier: saved.verifier, redirect_uri: redirectUri() });
  toast('Google Health connected');
  location.hash = '#/settings';
  return true;
}

async function tokenRequest(s, params) {
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: s.health.clientId, client_secret: s.health.clientSecret, ...params }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (j.error === 'invalid_grant') { s.health.refreshToken = ''; await saveSettings(s); throw new Error('Google sign-in expired; press Connect again'); }
    throw new Error(`Google token ${res.status}: ${j.error_description || j.error || res.statusText}`);
  }
  s.health.accessToken = j.access_token;
  if (j.refresh_token) s.health.refreshToken = j.refresh_token;
  s.health.expiresAt = Date.now() + (j.expires_in - 60) * 1000;
  await saveSettings(s);
  return s;
}

async function call(s, path, init = {}) {
  if (Date.now() > s.health.expiresAt) s = await tokenRequest(s, { grant_type: 'refresh_token', refresh_token: s.health.refreshToken });
  const res = await fetch(API + path, { ...init, headers: { Authorization: `Bearer ${s.health.accessToken}`, Accept: 'application/json', ...(init.headers || {}) } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = j.error?.message || res.statusText;
    if (/ACCOUNT_NOT_LINKED/.test(JSON.stringify(j))) throw new Error('Link the Google Health (Fitbit) app to your Google account first');
    throw new Error(`Google Health ${res.status} on ${path.split('?')[0]}: ${msg}`);
  }
  return j;
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

export function healthConnected(s) { return !!s.health.refreshToken; }

export function disconnectHealth(s) {
  s.health = { ...s.health, accessToken: '', refreshToken: '', expiresAt: 0 };
  return saveSettings(s);
}

const civil = (ymd) => { const [year, month, day] = ymd.split('-').map(Number); return { date: { year, month, day }, time: { hours: 0, minutes: 0, seconds: 0 } }; };
const ymdOf = (d) => `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;

// ISO timestamp + "+05:30"-style or "19800s"-style offset -> local wall-clock minutes and date
function localParts(iso, offset) {
  const t = new Date(iso);
  let offMin = -t.getTimezoneOffset();
  if (typeof offset === 'string' && /^-?\d+(\.\d+)?s$/.test(offset)) offMin = Math.round(parseFloat(offset) / 60);
  const local = new Date(t.getTime() + offMin * 60000);
  return { date: local.toISOString().slice(0, 10), mins: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

// Pull the last `days` days (default: since last sync, at least 7). Hand-entered values are
// never overwritten; values that came from the device are refreshed.
export async function syncHealth(days) {
  let s = await loadSettings();
  if (!healthConnected(s)) throw new Error('Google Health is not connected');
  const end = logicalToday(s.dayStartHour);
  const start = days ? addDays(end, -days) : s.health.lastSync ? addDays(s.health.lastSync, -2) : addDays(end, -30);
  const got = new Map();
  const put = (d, k, v) => { if (!got.has(d)) got.set(d, {}); got.get(d)[k] = v; };
  const errors = [];

  // steps: daily rollup, in <= 90-day chunks
  try {
    for (let a = start; a <= end; a = addDays(a, 90)) {
      const b = addDays(a, 90) > addDays(end, 1) ? addDays(end, 1) : addDays(a, 90);
      const j = await call(s, '/dataTypes/steps/dataPoints:dailyRollUp', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ range: { start: civil(a), end: civil(b) }, windowSizeDays: 1 }),
      });
      for (const r of j.rollupDataPoints || []) {
        const n = Number(r.steps?.countSum ?? r.steps?.count_sum ?? 0);
        if (n > 0 && r.civilStartTime?.date) put(ymdOf(r.civilStartTime.date), 'steps', n);
      }
    }
  } catch (e) { errors.push(e.message); }

  // sleep sessions: attribute each to the morning it ended; keep the longest per morning
  try {
    const pts = await listAll(s, 'sleep', `sleep.interval.start_time >= "${addDays(start, -1)}T00:00:00Z"`);
    const best = new Map();
    for (const p of pts) {
      const sl = p.sleep || p;
      const iv = sl.interval || {};
      if (!iv.startTime || !iv.endTime) continue;
      const st = localParts(iv.startTime, iv.startUtcOffset), en = localParts(iv.endTime, iv.endUtcOffset);
      const asleep = Number(sl.summary?.minutesAsleep ?? 0) || (new Date(iv.endTime) - new Date(iv.startTime)) / 60000;
      if (!best.has(en.date) || best.get(en.date).asleep < asleep) best.set(en.date, { st, en, asleep });
    }
    for (const [date, { st, en, asleep }] of best) {
      if (date < start) continue;
      put(date, 'bed', st.mins < 720 ? st.mins + 1440 : st.mins);
      put(date, 'wake', en.mins);
      put(date, 'sleep_hours', Math.round(asleep / 6) / 10);
    }
  } catch (e) { errors.push(e.message); }

  // resting heart rate: one point per day
  try {
    const pts = await listAll(s, 'daily-resting-heart-rate', `dailyRestingHeartRate.date >= "${start}"`);
    for (const p of pts) {
      const r = p.dailyRestingHeartRate || p;
      if (r.date && r.beatsPerMinute) put(typeof r.date === 'string' ? r.date : ymdOf(r.date), 'resting_hr', Number(r.beatsPerMinute));
    }
  } catch (e) { errors.push(e.message); }

  if (!got.size && errors.length) throw new Error(errors.join(' | '));

  // make sure the metrics exist and are switched on when data arrives
  const metrics = await loadMetrics();
  const want = { steps: ['Steps', 'count', 'Body', 1, 'steps'], resting_hr: ['Resting heart rate', 'count', 'Body', -1, 'bpm'] };
  let changed = false;
  for (const [id, [name, type, group, polarity, unit]] of Object.entries(want)) {
    const m = metrics.find((x) => x.id === id);
    const has = [...got.values()].some((v) => v[id] != null);
    if (!m && has) { metrics.push({ id, name, type, group, polarity, unit, source: 'fitbit' }); changed = true; }
    else if (m && m.archived && has) { m.archived = false; changed = true; }
  }
  if (changed) await saveMetrics(metrics);

  const updates = [];
  for (const [date, vals] of got) {
    const day = (await db.get('days', date)) || { date, values: {}, title: '', note: '', gratitude: '', src: {} };
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
  s.health.lastSync = end;
  await saveSettings(s);
  return { days: updates.length, start, end, errors };
}
