// Export (CSV + full JSON backup incl. photos) and import (JSON backup, or a daily CSV in the
// export layout). Contract: docs/v2-design.md 3.6.
import { db, getMeta, setMeta } from './db.js';
import { loadMetrics, saveMetrics, loadSettings, resolveValues, isEventLike, isCheckedIn, tierOf } from './metrics.js';
import { foodByDate, foodTotals } from './data.js';
import { minsToClock, clockToMins, ymd, validYmd, shareOrDownload } from './util.js';

// ---- CSV ----

// Quote for CSV. Cells that a spreadsheet would run as a formula (= + - @, tab, CR) get a leading
// apostrophe unless they are plain numbers; this also neuters formula-looking AI food names.
function csvCell(v) {
  if (v == null) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csvRow = (a) => a.map(csvCell).join(',');

const csvHeader = (m) => (m.derived ? `${m.name} (auto)` : m.name);

export async function dailyCSV() {
  const metrics = await loadMetrics();
  const days = (await db.all('days')).filter((d) => validYmd(d.date));
  const foods = await foodByDate();
  const dates = [...new Set([...days.map((d) => d.date), ...[...foods.keys()].filter(validYmd)])].sort();
  const dayMap = new Map(days.map((d) => [d.date, d]));
  const lines = [csvRow(['date', 'title', ...metrics.map(csvHeader), 'gratitude', 'journal'])];
  for (const date of dates) {
    const d = dayMap.get(date) || { date, values: {} };
    const v = resolveValues(d, metrics, foods.has(date) ? foodTotals(foods.get(date)) : null);
    const cells = metrics.map((m) => (m.type === 'time' && v[m.id] != null ? minsToClock(v[m.id]) : v[m.id]));
    lines.push(csvRow([date, d.title, ...cells, d.gratitude, d.note]));
  }
  return lines.join('\n');
}

// What the AI said this item was worth before any correction, matched by name then by position.
function aiKcalFor(e, item, idx) {
  const ai = e.ai && Array.isArray(e.ai.items) ? e.ai.items : null;
  if (!ai) return '';
  const name = String(item.name || '').trim().toLowerCase();
  let hit = name ? ai.find((a) => String(a.name || '').trim().toLowerCase() === name) : null;
  if (!hit && ai[idx] && (item.src === 'ai' || item.src === 'ai-edited')) hit = ai[idx];
  return hit && hit.kcal != null ? hit.kcal : '';
}

export async function foodCSV() {
  // Same order as the Food screen: times before dayStartHour belong to the end of the logical day.
  const dayStart = (await loadSettings()).dayStartHour ?? 4;
  const sortMins = (t) => { const m = clockToMins(t); return m == null ? 1e9 : m < dayStart * 60 ? m + 1440 : m; };
  const all = (await db.all('food')).sort((a, b) => a.date.localeCompare(b.date) || sortMins(a.time) - sortMins(b.time) || (a.createdAt || 0) - (b.createdAt || 0));
  const lines = [csvRow(['date', 'time', 'meal', 'item', 'amount', 'grams', 'kcal', 'protein', 'carbs', 'fat', 'item_source', 'entry_source', 'ai_kcal'])];
  for (const e of all) {
    const items = e.items && e.items.length ? e.items : [e];
    items.forEach((i, idx) => {
      const itemSrc = i.src || e.source || '';
      lines.push(csvRow([e.date, e.time, e.name, i.name, i.amount, i.grams, i.kcal, i.protein, i.carbs, i.fat, itemSrc, e.source, aiKcalFor(e, i, idx)]));
    });
  }
  return lines.join('\n');
}

// ---- JSON backup ----

function blobToB64(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1] || '');
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(blob);
  });
}

function b64ToBlob(b64, type = 'image/jpeg') {
  const bin = atob(String(b64).replace(/^data:[^,]*,/, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

// Everything on the phone minus secrets. Photos are the stored JPEG thumbnails as base64.
export async function backupJSON({ includePhotos = true } = {}) {
  const settings = await loadSettings();
  settings.ai = { ...settings.ai, geminiKey: '', claudeKey: '' };
  settings.health = { ...settings.health, clientSecret: '', accessToken: '', refreshToken: '', expiresAt: 0 };
  const [metrics, days, food] = await Promise.all([loadMetrics(), db.all('days'), db.all('food')]);
  const photos = [];
  if (includePhotos) {
    const wanted = new Set(food.map((f) => f.photoId).filter(Boolean));
    for (const p of await db.all('photos')) {
      if (!wanted.has(p.id) || !(p.blob instanceof Blob)) continue;
      try { photos.push({ id: p.id, jpegBase64: await blobToB64(p.blob) }); } catch { /* unreadable blob: skip */ }
    }
  }
  return JSON.stringify({
    app: 'daybook', version: 1, exportedAt: new Date().toISOString(),
    metrics, settings, days, food, photos,
  });
}

const PORTABLE = ['dayStartHour', 'insightsTarget', 'kcalGoal', 'proteinGoal', 'reminderTime', 'goalsText'];

function listOf(data, key) {
  if (data[key] == null) return [];
  if (!Array.isArray(data[key])) throw new Error(`Backup field "${key}" is not a list`);
  return data[key];
}

// Throws a one-line error naming the first bad record; nothing is written before this passes.
function validateBackup(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Not a Daybook backup file');
  if (data.app !== 'daybook') throw new Error('Not a Daybook backup file (app is not "daybook")');
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  listOf(data, 'days').forEach((d, i) => {
    if (!isObj(d) || !validYmd(d.date)) throw new Error(`Day #${i + 1} has no valid date (YYYY-MM-DD)`);
    if (d.values != null && !isObj(d.values)) throw new Error(`Day ${d.date}: "values" is not an object`);
  });
  listOf(data, 'food').forEach((f, i) => {
    const idOk = (typeof f?.id === 'string' && f.id !== '') || typeof f?.id === 'number';
    if (!isObj(f) || !idOk || !validYmd(f.date)) throw new Error(`Food entry #${i + 1} needs an id and a valid date`);
  });
  listOf(data, 'metrics').forEach((m, i) => {
    if (!isObj(m) || typeof m.id !== 'string' || !m.id || typeof m.name !== 'string') throw new Error(`Metric #${i + 1} needs an id and a name`);
  });
  listOf(data, 'photos').forEach((p, i) => {
    if (!isObj(p) || p.id == null || typeof p.jpegBase64 !== 'string') throw new Error(`Photo #${i + 1} needs an id and jpegBase64`);
  });
  if (data.settings != null && !isObj(data.settings)) throw new Error('Backup "settings" is not an object');
}

function cleanValues(vals) {
  const out = {};
  for (const [k, v] of Object.entries(vals || {})) if (v != null && v !== '') out[k] = v;
  return out;
}

// File wins per field, values merged key by key; blank text in the file never erases local text.
function mergeDay(local, d) {
  const file = { ...d, values: cleanValues(d.values), src: { ...(d.src || {}) } };
  if (!local) return file;
  const out = { ...local, ...file, values: { ...(local.values || {}), ...file.values }, src: { ...(local.src || {}), ...file.src } };
  for (const k of ['title', 'note', 'gratitude']) if (!file[k] && local[k]) out[k] = local[k];
  return out;
}

// Merge a backup into the current data inside one transaction (all or nothing).
// Returns { days, food, metrics, photos } counts of records written.
export async function importBackup(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Not a JSON file'); }
  validateBackup(data);
  let photos;
  try { photos = listOf(data, 'photos').map((p) => ({ id: p.id, blob: b64ToBlob(p.jpegBase64) })); }
  catch { throw new Error('A photo in the backup is not valid base64'); }
  const fileMetrics = listOf(data, 'metrics');
  const fileDays = listOf(data, 'days');
  const fileFood = listOf(data, 'food');
  const fileSettings = data.settings || null;

  const result = await db.tx(['meta', 'days', 'food', 'photos'], 'readwrite', async (t) => {
    const meta = t.objectStore('meta'), dayS = t.objectStore('days'), foodS = t.objectStore('food'), photoS = t.objectStore('photos');
    const w = db.wrap;
    let mergedMetrics = null;
    if (fileMetrics.length) {
      const rec = await w(meta.get('metrics'));
      const cur = Array.isArray(rec?.value) ? rec.value : [];
      const byId = new Map(cur.map((m) => [m.id, m]));
      const curIds = new Set(byId.keys());
      for (const m of fileMetrics) {
        const local = byId.get(m.id);
        const merged = { ...local, ...m };
        // The archived flag is a local choice: a re-import must not turn a metric back off.
        if (local) { if (local.archived) merged.archived = true; else delete merged.archived; }
        byId.set(m.id, merged);
      }
      // Order is a local choice too: keep the Settings order and append only new metrics.
      // The file's order applies only on a fresh install.
      const order = cur.length
        ? [...cur.map((m) => m.id), ...fileMetrics.map((m) => m.id).filter((id) => !curIds.has(id))]
        : fileMetrics.map((m) => m.id);
      mergedMetrics = [...new Set(order)].map((id) => byId.get(id));
      meta.put({ key: 'metrics', value: mergedMetrics });
    }
    if (fileSettings) {
      const rec = await w(meta.get('settings'));
      const s = rec && rec.value && typeof rec.value === 'object' ? rec.value : {};
      for (const k of PORTABLE) if (fileSettings[k] != null) s[k] = fileSettings[k];
      if (fileSettings.ai && typeof fileSettings.ai.foodContext === 'string') s.ai = { ...(s.ai || {}), foodContext: fileSettings.ai.foodContext };
      meta.put({ key: 'settings', value: s });
    }
    if (fileDays.length) {
      const existing = new Map((await w(dayS.getAll())).map((d) => [d.date, d]));
      db.putAll(dayS, fileDays.map((d) => mergeDay(existing.get(d.date), d)));
    }
    const photoIds = new Set(await w(photoS.getAllKeys()));
    if (photos.length) {
      db.putAll(photoS, photos);
      for (const p of photos) photoIds.add(p.id);
    }
    if (fileFood.length) {
      db.putAll(foodS, fileFood.map((f) => {
        const e = { ...f };
        if (e.photoId && !photoIds.has(e.photoId)) delete e.photoId; // no dangling photo references
        return e;
      }));
    }
    return { days: fileDays.length, food: fileFood.length, metrics: fileMetrics.length, photos: photos.length, mergedMetrics };
  });
  // The transaction wrote meta directly; refresh the module cache from the same list.
  if (result.mergedMetrics) await saveMetrics(result.mergedMetrics);
  return { days: result.days, food: result.food, metrics: result.metrics, photos: result.photos };
}

// ---- daily CSV import ----

function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x !== ''));
}

function normDate(s) {
  s = (s || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return validYmd(s.slice(0, 10)) ? s.slice(0, 10) : null;
  const d = new Date(s);
  return isNaN(d) ? null : ymd(d);
}

// Undo the formula-escaping apostrophe that dailyCSV adds.
const unescapeCell = (s) => (/^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s);

// Import a CSV in the dailyCSV layout only: date, title, ...metric columns..., gratitude, journal.
// Derived columns (" (auto)" or a derived metric's name) are skipped, unknown columns are reported
// in unknownColumns and never create metrics. Blank cells leave stored values alone. A 0 in an
// event-like column of a checked-in row is what dailyCSV derives from a blank, so it is not stored
// (keeps stored data blank/reversible); on a non-checked-in row a 0 carries information and is kept.
export async function importDailyCSV(text) {
  const rows = parseCSV(text.replace(/^﻿/, ''));
  if (rows.length < 2) throw new Error('CSV has no data rows');
  const head = rows[0].map((x) => x.trim());
  const low = head.map((x) => x.toLowerCase());
  const n = head.length;
  if (n < 4 || low[0] !== 'date' || low[1] !== 'title' || low[n - 2] !== 'gratitude' || !['journal', 'note'].includes(low[n - 1])) {
    throw new Error('Not a Daybook daily CSV (expected columns: date, title, …, gratitude, journal). The food CSV cannot be imported; use a JSON backup for that.');
  }
  const metrics = await loadMetrics();
  const find = (name) => {
    const l = name.toLowerCase();
    return metrics.find((m) => m.id === name) || metrics.find((m) => m.name.toLowerCase() === l);
  };
  const unknownColumns = [];
  const cols = head.map((name, i) => {
    if (i === 0) return { kind: 'date' };
    if (i === 1) return { kind: 'title' };
    if (i === n - 2) return { kind: 'gratitude' };
    if (i === n - 1) return { kind: 'note' };
    if (!name) return { kind: 'skip' };
    if (/ \(auto\)$/i.test(name)) return { kind: 'skip' };
    const m = find(name);
    if (!m) { unknownColumns.push(name); return { kind: 'skip' }; }
    if (m.derived) return { kind: 'skip' };
    return { kind: 'metric', m };
  });
  const existing = new Map((await db.all('days')).map((d) => [d.date, d]));
  const out = [];
  let skippedRows = 0;
  for (const r of rows.slice(1)) {
    const date = normDate(r[0]);
    if (!date) { skippedRows++; continue; }
    const d = existing.get(date) || { date, values: {}, title: '', note: '', gratitude: '', src: {} };
    if (!d.values) d.values = {};
    const checked = isCheckedIn(d, metrics)
      || cols.some((c, i) => c.kind === 'metric' && !c.m.derived && tierOf(c.m) === 'core' && (r[i] ?? '').trim() !== '');
    const derivedZero = (m) => checked && isEventLike(m) && d.values[m.id] == null;
    cols.forEach((c, i) => {
      const raw = (r[i] ?? '').trim();
      if (!raw || c.kind === 'date' || c.kind === 'skip') return;
      if (c.kind === 'title') d.title = unescapeCell(raw);
      else if (c.kind === 'gratitude') d.gratitude = unescapeCell(raw);
      else if (c.kind === 'note') d.note = unescapeCell(raw);
      else if (c.m.type === 'time') {
        if (/^\d{1,2}:\d{2}$/.test(raw)) { const v = clockToMins(raw, !!c.m.night); if (v != null) d.values[c.m.id] = v; }
      } else if (c.m.type === 'text') d.values[c.m.id] = unescapeCell(raw);
      else if (c.m.type === 'bool') {
        if (/^(1|y|yes|true)$/i.test(raw)) d.values[c.m.id] = 1;
        else if (/^(0|n|no|false)$/i.test(raw) && !derivedZero(c.m)) d.values[c.m.id] = 0;
      } else if (raw !== '' && Number.isFinite(Number(raw))) {
        const num = Number(raw);
        if (!(num === 0 && derivedZero(c.m))) d.values[c.m.id] = num;
      }
    });
    d.updatedAt = Date.now();
    out.push(d);
  }
  if (out.length) await db.putMany('days', out);
  return { days: out.length, unknownColumns, skippedRows };
}

// ---- backup bookkeeping ----

// Share (or download) a full backup and remember when. Resolves false if the share sheet was dismissed.
export async function backupNow() {
  const text = await backupJSON();
  const ok = await shareOrDownload(`daybook-backup-${ymd(new Date())}.json`, text, 'application/json');
  if (ok) await setMeta('lastBackupAt', Date.now());
  return ok;
}

export async function backupStatus() {
  const [lastBackupAt, days, food] = await Promise.all([getMeta('lastBackupAt', null), db.all('days'), db.all('food')]);
  const newSinceBackup = lastBackupAt
    ? days.filter((d) => (d.updatedAt || 0) > lastBackupAt).length + food.filter((f) => (f.updatedAt || f.createdAt || 0) > lastBackupAt).length
    : days.length + food.length;
  let persisted = false;
  try { if (navigator.storage && navigator.storage.persisted) persisted = await navigator.storage.persisted(); } catch { persisted = false; }
  return { lastBackupAt, days: days.length, food: food.length, newSinceBackup, persisted };
}

export async function wipeAll() {
  for (const s of ['days', 'food', 'photos', 'meta']) await db.clear(s);
}

export { getMeta, setMeta };
