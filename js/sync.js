// Automatic off-device backup to a private GitHub repository.
//
// Every change to a day, a food entry, a photo, the metric list or the settings is queued and
// pushed about 15 s later (sooner on the next app open or when the phone comes back online).
// Layout in the repo (each file is its own commit, so the repo is also a history):
//   snapshot.json      full backup without photos (written on enable, import and once a week)
//   days/YYYY-MM-DD.json   { day, food: [entries of that date] }   written on every change
//   meta.json          { metrics, settings } (settings without any keys or tokens)
//   photos/<id>.jpg    meal thumbnails
// Restore = snapshot, then every day file on top, then meta and photos.
//
// Token handling: a fine-grained personal access token limited to that one repo, kept in
// IndexedDB like the other keys and never included in backups.
import { db, getMeta, setMeta, onChange } from './db.js';
import { loadMetrics, loadSettings, saveSettings } from './metrics.js';
import { backupJSON, importBackup } from './io.js';

const API = 'https://api.github.com';
const DEBOUNCE_MS = 15000;
const RETRY_MS = [60000, 300000, 900000];
const SNAPSHOT_EVERY = 7 * 86400000;
const PORTABLE_SETTINGS = ['dayStartHour', 'insightsTarget', 'kcalGoal', 'proteinGoal', 'reminderTime', 'goalsText'];

// meta 'syncQueue': { days: {date: true}, meta: bool, snapshot: bool, photos: {id: true} }
// meta 'syncState': { lastPushAt, lastError, snapshotAt, shas: {path: sha}, failures }
let queue = null;
let state = null;
let timer = null;
let pushing = null;
let suspended = false; // during restore, so pulled data is not pushed straight back
const listeners = new Set();

const emptyQueue = () => ({ days: {}, meta: false, snapshot: false, photos: {} });

async function loadState() {
  if (!queue) queue = Object.assign(emptyQueue(), await getMeta('syncQueue', null) || {});
  if (!state) state = Object.assign({ lastPushAt: '', lastError: '', snapshotAt: '', shas: {}, failures: 0 }, await getMeta('syncState', null) || {});
}
const saveQueue = () => setMeta('syncQueue', queue);
const saveState = () => setMeta('syncState', state);

export function pendingCount() {
  if (!queue) return 0;
  return Object.keys(queue.days).length + Object.keys(queue.photos).length + (queue.meta ? 1 : 0) + (queue.snapshot ? 1 : 0);
}

export function onSyncChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const f of listeners) { try { f(); } catch (e) { console.warn(e); } } }

export async function syncStatus() {
  await loadState();
  const s = (await loadSettings()).backup || {};
  return {
    enabled: !!(s.enabled && s.token && s.repo),
    repo: s.repo || '',
    lastPushAt: state.lastPushAt,
    lastError: state.lastError,
    snapshotAt: state.snapshotAt,
    pending: pendingCount(),
    online: navigator.onLine,
  };
}

// ---- change capture ----

async function enqueue(patch) {
  await loadState();
  if (patch.date) queue.days[patch.date] = true;
  if (patch.meta) queue.meta = true;
  if (patch.snapshot) { queue.snapshot = true; queue.days = {}; }
  if (patch.photo) queue.photos[patch.photo] = true;
  await saveQueue();
  emit();
  schedule(DEBOUNCE_MS);
}

function onDbChange(ev) {
  if (suspended || ev.type === 'clear') return; // "Erase everything" must never overwrite the backup
  if (ev.bulk) {
    // an import or a multi-store transaction: snapshot the lot rather than one file per day
    if (ev.store === 'days' || ev.store === 'food') enqueue({ snapshot: true });
    else if (ev.store === 'meta') enqueue({ meta: true });
    else if (ev.store === 'photos') db.all('photos').then((ps) => ps.forEach((p) => enqueue({ photo: p.id }))).catch(() => {});
    return;
  }
  if (ev.store === 'days' && ev.key) enqueue({ date: ev.key });
  else if (ev.store === 'food' && ev.date) enqueue({ date: ev.date });
  else if (ev.store === 'photos' && ev.key && ev.type !== 'delete') enqueue({ photo: ev.key });
  else if (ev.store === 'meta' && (ev.key === 'metrics' || ev.key === 'settings')) enqueue({ meta: true });
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(() => { push().catch((e) => console.warn('sync', e)); }, ms);
}

// ---- GitHub ----

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const b64text = (text) => b64(new TextEncoder().encode(text));

async function gh(cfg, path, init = {}) {
  let res;
  try {
    res = await fetch(`${API}/repos/${cfg.repo}${path ? `/${path}` : ''}`, {
      ...init,
      headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(init.headers || {}) },
      signal: init.signal || AbortSignal.timeout(45000),
    });
  } catch (e) {
    // TypeError here means the request never reached GitHub: offline, a blocker, or a stale copy of
    // the app whose security policy predates the backup feature.
    if (e && e.name === 'TimeoutError') throw new Error('GitHub did not answer within 45 s; will retry');
    throw new Error(navigator.onLine
      ? 'Could not reach api.github.com. Close the app completely and reopen it (an old copy may still be running); if it keeps failing, check that https://api.github.com opens in Chrome.'
      : 'Phone is offline; will retry when back online');
  }
  if (res.status === 401) throw Object.assign(new Error('GitHub rejected the token (expired or revoked). Make a new one in Settings → Automatic backup.'), { fatal: true });
  if (res.status === 403 && /rate limit/i.test(await res.clone().text())) throw new Error('GitHub rate limit hit; will retry');
  return res;
}

async function putFile(cfg, path, bytesOrText, message) {
  const content = typeof bytesOrText === 'string' ? b64text(bytesOrText) : b64(bytesOrText);
  const attempt = async (sha) => {
    const body = { message, content, branch: cfg.branch || 'main' };
    if (sha) body.sha = sha;
    const res = await gh(cfg, `contents/${path}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.status === 409 || res.status === 422) return null; // stale or missing sha
    if (!res.ok) throw new Error(`GitHub ${res.status} writing ${path}`);
    return (await res.json()).content.sha;
  };
  let sha = state.shas[path];
  let out = await attempt(sha);
  if (out == null) {
    // look the current sha up and retry once
    const head = await gh(cfg, `contents/${path}?ref=${encodeURIComponent(cfg.branch || 'main')}`);
    sha = head.ok ? (await head.json()).sha : undefined;
    out = await attempt(sha);
    if (out == null) throw new Error(`GitHub refused ${path} twice (sha conflict)`);
  }
  state.shas[path] = out;
  return out;
}

async function portableSettings() {
  const s = await loadSettings();
  const out = {};
  for (const k of PORTABLE_SETTINGS) if (s[k] !== undefined) out[k] = s[k];
  out.ai = { foodContext: (s.ai && s.ai.foodContext) || '' };
  return out;
}

async function dayFile(date) {
  const day = await db.get('days', date);
  const food = await db.byIndex('food', 'date', date);
  return JSON.stringify({ app: 'daybook', kind: 'day', date, day: day || null, food });
}

// Push everything queued. Safe to call often; only one push runs at a time.
export async function push() {
  if (pushing) return pushing;
  pushing = (async () => {
    await loadState();
    const cfg = (await loadSettings()).backup || {};
    if (!cfg.enabled || !cfg.token || !cfg.repo || !navigator.onLine) return;
    if (!queue.snapshot && state.snapshotAt && Date.now() - new Date(state.snapshotAt).getTime() > SNAPSHOT_EVERY) queue.snapshot = true;
    try {
      if (queue.snapshot) {
        await putFile(cfg, 'snapshot.json', await backupJSON({ includePhotos: false }), 'snapshot');
        state.snapshotAt = new Date().toISOString();
        queue.snapshot = false; queue.days = {};
        await saveQueue(); await saveState();
      }
      for (const date of Object.keys(queue.days).sort()) {
        await putFile(cfg, `days/${date}.json`, await dayFile(date), `day ${date}`);
        delete queue.days[date];
        await saveQueue();
      }
      if (queue.meta) {
        await putFile(cfg, 'meta.json', JSON.stringify({ app: 'daybook', kind: 'meta', metrics: await loadMetrics(), settings: await portableSettings() }), 'meta');
        queue.meta = false; await saveQueue();
      }
      for (const id of Object.keys(queue.photos)) {
        const p = await db.get('photos', id);
        if (p && p.blob) await putFile(cfg, `photos/${id}.jpg`, new Uint8Array(await p.blob.arrayBuffer()), `photo ${id}`);
        delete queue.photos[id];
        await saveQueue();
      }
      state.lastPushAt = new Date().toISOString();
      state.lastError = '';
      state.failures = 0;
    } catch (e) {
      state.lastError = e.message || String(e);
      state.failures = (state.failures || 0) + 1;
      if (!e.fatal) schedule(RETRY_MS[Math.min(state.failures - 1, RETRY_MS.length - 1)]);
    }
    await saveState();
    emit();
  })().finally(() => { pushing = null; });
  return pushing;
}

// ---- setup, restore ----

// Checks the token can write to the repo, then turns automatic backup on and pushes everything.
export async function enableBackup(repo, token) {
  repo = (repo || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
  token = (token || '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Repository must look like owner/name');
  if (!token) throw new Error('Paste the token first');
  const cfg = { repo, token, branch: 'main' };
  const res = await gh(cfg, '');
  if (res.status === 404) throw new Error('Repository not found, or the token has no access to it');
  if (!res.ok) throw new Error(`GitHub ${res.status} checking the repository`);
  const info = await res.json();
  if (!info.permissions || !info.permissions.push) throw new Error('The token can read but not write; it needs Contents: Read and write');
  if (!info.private) throw new Error('That repository is public. Backups hold your journal; use a private one.');
  cfg.branch = info.default_branch || 'main';
  const s = await loadSettings();
  s.backup = { ...(s.backup || {}), provider: 'github', repo, token, branch: cfg.branch, enabled: true };
  await saveSettings(s);
  await loadState();
  state.shas = {}; state.lastError = ''; state.failures = 0;
  await saveState();
  queue = emptyQueue();
  queue.snapshot = true; queue.meta = true;
  for (const p of await db.all('photos')) queue.photos[p.id] = true;
  await saveQueue();
  emit();
  push().catch((e) => console.warn('sync', e));
  return { repo, branch: cfg.branch };
}

export async function disableBackup() {
  const s = await loadSettings();
  s.backup = { ...(s.backup || {}), enabled: false, token: '' };
  await saveSettings(s);
  emit();
}

// Lists what is in the repo without changing anything local.
export async function inspectBackup(repo, token) {
  const cfg = { repo: repo.trim(), token: token.trim(), branch: 'main' };
  const info = await gh(cfg, '');
  if (!info.ok) throw new Error(info.status === 404 ? 'Repository not found, or the token has no access to it' : `GitHub ${info.status}`);
  cfg.branch = (await info.json()).default_branch || 'main';
  const tree = await gh(cfg, `git/trees/${encodeURIComponent(cfg.branch)}?recursive=1`);
  if (tree.status === 404 || tree.status === 409) return { cfg, days: [], photos: [], snapshot: false, meta: false }; // empty repo
  if (!tree.ok) throw new Error(`GitHub ${tree.status} listing the repository`);
  const items = (await tree.json()).tree || [];
  return {
    cfg,
    days: items.filter((t) => /^days\/\d{4}-\d{2}-\d{2}\.json$/.test(t.path)).map((t) => ({ path: t.path, sha: t.sha, date: t.path.slice(5, 15) })),
    photos: items.filter((t) => /^photos\/[^/]+\.jpg$/.test(t.path)).map((t) => ({ path: t.path, sha: t.sha, id: t.path.slice(7, -4) })),
    snapshot: items.some((t) => t.path === 'snapshot.json'),
    meta: items.some((t) => t.path === 'meta.json'),
    shas: Object.fromEntries(items.filter((t) => t.type === 'blob').map((t) => [t.path, t.sha])),
  };
}

async function raw(cfg, path) {
  const res = await gh(cfg, `contents/${path}?ref=${encodeURIComponent(cfg.branch)}`, { headers: { Accept: 'application/vnd.github.raw+json' } });
  if (!res.ok) throw new Error(`GitHub ${res.status} reading ${path}`);
  return res;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  });
  await Promise.all(workers);
  return out;
}

// Pulls the whole backup into this phone. Existing local records are merged (the backup wins per
// record). Reports progress through onProgress(text).
export async function restoreBackup(repo, token, onProgress = () => {}) {
  const inv = await inspectBackup(repo, token);
  const { cfg } = inv;
  suspended = true;
  try {
    let counts = { days: 0, food: 0, metrics: 0, photos: 0 };
    if (inv.snapshot) {
      onProgress('Reading snapshot…');
      const r = await importBackup(await (await raw(cfg, 'snapshot.json')).text());
      counts = { ...counts, days: r.days, food: r.food, metrics: r.metrics };
    }
    if (inv.meta) {
      onProgress('Reading settings…');
      const m = JSON.parse(await (await raw(cfg, 'meta.json')).text());
      await importBackup(JSON.stringify({ app: 'daybook', version: 1, metrics: m.metrics || [], settings: m.settings || {}, days: [], food: [] }));
    }
    let done = 0;
    await mapLimit(inv.days, 4, async (d) => {
      const f = JSON.parse(await (await raw(cfg, d.path)).text());
      if (f.day) await db.put('days', f.day);
      for (const e of f.food || []) await db.put('food', e);
      counts.days++;
      onProgress(`Days ${++done} / ${inv.days.length}`);
    });
    done = 0;
    await mapLimit(inv.photos, 4, async (p) => {
      const buf = await (await raw(cfg, p.path)).arrayBuffer();
      await db.put('photos', { id: p.id, blob: new Blob([buf], { type: 'image/jpeg' }) });
      counts.photos++;
      onProgress(`Photos ${++done} / ${inv.photos.length}`);
    });
    // Turn automatic backup on against the same repo so new changes keep flowing there.
    const s = await loadSettings();
    s.backup = { ...(s.backup || {}), provider: 'github', repo: cfg.repo, token: cfg.token, branch: cfg.branch, enabled: true };
    await saveSettings(s);
    await loadState();
    state.shas = inv.shas || {};
    state.lastError = '';
    state.snapshotAt = inv.snapshot ? new Date().toISOString() : '';
    await saveState();
    queue = emptyQueue();
    await saveQueue();
    return counts;
  } finally {
    suspended = false;
    emit();
  }
}

// Call once at startup.
export async function startSync() {
  await loadState();
  onChange(onDbChange);
  window.addEventListener('online', () => schedule(2000));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && pendingCount()) push().catch(() => {}); });
  if (pendingCount()) schedule(3000);
  else {
    const cfg = (await loadSettings()).backup || {};
    if (cfg.enabled && state.snapshotAt && Date.now() - new Date(state.snapshotAt).getTime() > SNAPSHOT_EVERY) schedule(5000);
  }
}
