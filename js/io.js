// Export (CSV + full JSON backup) and import (JSON backup or a daily CSV in the export layout).
import { db, getMeta, setMeta } from './db.js';
import { loadMetrics, saveMetrics, loadSettings, saveSettings, resolveValues, slug } from './metrics.js';
import { foodByDate, foodTotals } from './data.js';
import { minsToClock, clockToMins, ymd } from './util.js';

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csvRow = (a) => a.map(csvCell).join(',');

export async function dailyCSV() {
  const metrics = await loadMetrics();
  const days = (await db.all('days')).sort((a, b) => a.date.localeCompare(b.date));
  const foods = await foodByDate();
  const dates = [...new Set([...days.map((d) => d.date), ...foods.keys()])].sort();
  const dayMap = new Map(days.map((d) => [d.date, d]));
  const lines = [csvRow(['date', 'title', ...metrics.map((m) => m.name), 'gratitude', 'journal'])];
  for (const date of dates) {
    const d = dayMap.get(date) || { date, values: {} };
    const v = resolveValues(d, metrics, foods.has(date) ? foodTotals(foods.get(date)) : null);
    lines.push(csvRow([date, d.title, ...metrics.map((m) => (m.type === 'time' && v[m.id] != null ? minsToClock(v[m.id]) : v[m.id])), d.gratitude, d.note]));
  }
  return lines.join('\n');
}

export async function foodCSV() {
  const all = (await db.all('food')).sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));
  const lines = [csvRow(['date', 'time', 'meal', 'item', 'amount', 'kcal', 'protein', 'carbs', 'fat', 'source'])];
  for (const e of all) {
    const items = e.items && e.items.length ? e.items : [e];
    for (const i of items) lines.push(csvRow([e.date, e.time, e.name, i.name, i.amount, i.kcal, i.protein, i.carbs, i.fat, e.source]));
  }
  return lines.join('\n');
}

export async function backupJSON({ includeKeys = false } = {}) {
  const settings = await loadSettings();
  if (!includeKeys) {
    settings.ai = { ...settings.ai, geminiKey: '', claudeKey: '' };
    settings.health = { ...settings.health, clientSecret: '', accessToken: '', refreshToken: '' };
  }
  return JSON.stringify({
    app: 'daybook', version: 1, exportedAt: new Date().toISOString(),
    metrics: await loadMetrics(), settings,
    days: await db.all('days'), food: await db.all('food'),
  });
}

// Merge a backup into the current data. Backup wins for the same date / food id / metric id.
export async function importBackup(text) {
  const data = JSON.parse(text);
  if (data.app !== 'daybook') throw new Error('Not a Daybook backup file');
  if (data.metrics?.length) {
    const cur = await loadMetrics();
    const byId = new Map(cur.map((m) => [m.id, m]));
    for (const m of data.metrics) byId.set(m.id, { ...byId.get(m.id), ...m });
    // keep the backup's order, then any local-only metrics
    const order = [...data.metrics.map((m) => m.id), ...cur.map((m) => m.id).filter((id) => !data.metrics.some((m) => m.id === id))];
    await saveMetrics(order.map((id) => byId.get(id)));
  }
  if (data.settings) {
    const s = await loadSettings();
    const keep = { ai: s.ai, health: s.health };
    const merged = { ...s, ...data.settings, ai: { ...s.ai, ...data.settings.ai }, health: { ...s.health, ...data.settings.health } };
    // never wipe a key that is set locally with an empty one from the file
    for (const k of ['geminiKey', 'claudeKey']) if (!merged.ai[k]) merged.ai[k] = keep.ai[k];
    for (const k of ['clientSecret', 'accessToken', 'refreshToken']) if (!merged.health[k]) merged.health[k] = keep.health[k];
    delete merged.fitbit;
    await saveSettings(merged);
  }
  if (data.days?.length) {
    const existing = new Map((await db.all('days')).map((d) => [d.date, d]));
    await db.putMany('days', data.days.map((d) => {
      const e = existing.get(d.date);
      if (!e) return d;
      return { ...e, ...d, values: { ...e.values, ...d.values }, title: d.title || e.title, note: d.note || e.note, gratitude: d.gratitude || e.gratitude };
    }));
  }
  if (data.food?.length) await db.putMany('food', data.food);
  return { days: data.days?.length || 0, food: data.food?.length || 0, metrics: data.metrics?.length || 0 };
}

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

// Import a daily CSV: first column a date, other columns matched to metrics by id or name.
// Unknown numeric columns become new 'count' metrics in group Other.
export async function importDailyCSV(text) {
  const rows = parseCSV(text.replace(/^﻿/, ''));
  if (rows.length < 2) throw new Error('CSV has no data rows');
  const head = rows[0].map((x) => x.trim());
  const metrics = await loadMetrics();
  const find = (name) => metrics.find((m) => m.id === name || m.name.toLowerCase() === name.toLowerCase());
  const cols = head.map((name, i) => {
    if (i === 0) return { kind: 'date' };
    const low = name.toLowerCase();
    if (low === 'title') return { kind: 'title' };
    if (low === 'gratitude') return { kind: 'gratitude' };
    if (low === 'journal' || low === 'note') return { kind: 'note' };
    let m = find(name);
    if (!m && name) {
      m = { id: slug(name), name, type: 'count', group: 'Other', polarity: 0 };
      while (metrics.some((x) => x.id === m.id)) m.id += '_';
      metrics.push(m);
    }
    return m ? { kind: 'metric', m } : { kind: 'skip' };
  });
  const existing = new Map((await db.all('days')).map((d) => [d.date, d]));
  const out = [];
  for (const r of rows.slice(1)) {
    const date = normDate(r[0]);
    if (!date) continue;
    const d = existing.get(date) || { date, values: {}, title: '', note: '', gratitude: '', src: {} };
    cols.forEach((c, i) => {
      const raw = (r[i] ?? '').trim();
      if (!raw || c.kind === 'date' || c.kind === 'skip') return;
      if (c.kind === 'title') d.title = raw;
      else if (c.kind === 'gratitude') d.gratitude = raw;
      else if (c.kind === 'note') d.note = raw;
      else if (c.m.type === 'time') { const v = clockToMins(raw, !!c.m.night); if (v != null) d.values[c.m.id] = v; }
      else if (c.m.type === 'text') d.values[c.m.id] = raw;
      else if (c.m.type === 'bool') d.values[c.m.id] = /^(1|y|yes|true)$/i.test(raw) ? 1 : 0;
      else if (!isNaN(Number(raw))) d.values[c.m.id] = Number(raw);
    });
    out.push(d);
  }
  await saveMetrics(metrics);
  await db.putMany('days', out);
  return { days: out.length };
}

function normDate(s) {
  s = (s || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return isNaN(d) ? null : ymd(d);
}

export async function wipeAll() {
  for (const s of ['days', 'food', 'photos', 'meta']) await db.clear(s);
}

export { getMeta, setMeta };
