// IndexedDB storage. Everything lives on the phone; nothing is sent anywhere unless the
// user turns on an AI provider or Fitbit sync.
//
// stores:
//   days   {date, values:{metricId:value}, title, note, gratitude, src:{metricId:'fitbit'|...}, loggedAt, updatedAt}
//   food   {id, date, time, name, kcal, protein, carbs, fat, items:[...], source, ai, photoId, createdAt, updatedAt}
//   photos {id, blob}
//   meta   {key, value}   - 'settings', 'metrics', 'foodLibrary', 'aiCalls', 'lastBackupAt', 'seenIntro'

const DB_NAME = 'daybook';
const VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('days')) db.createObjectStore('days', { keyPath: 'date' });
      if (!db.objectStoreNames.contains('food')) {
        const s = db.createObjectStore('food', { keyPath: 'id' });
        s.createIndex('date', 'date');
      }
      if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab (e.g. "Erase everything") closed or deleted the database: reopen lazily next time.
      db.onversionchange = () => { db.close(); dbp = null; };
      db.onclose = () => { dbp = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  // A failed open must not be cached forever, otherwise every later call fails until reload.
  dbp.catch(() => { dbp = null; });
  return dbp;
}

function wrap(req) {
  return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
}

// Chrome's DOMExceptions for quota/constraint failures often have an empty message, which
// would reach the user as "Import failed: ". Give every abort a readable one.
function txError(err) {
  if (err && err.name === 'QuotaExceededError') {
    const e = new Error('Phone storage is full');
    e.name = 'QuotaExceededError';
    return e;
  }
  if (err && err.message) return err;
  return new Error((err && err.name) || 'Transaction aborted');
}

// Run fn(transaction) inside one transaction over the given store(s). Resolves with fn's
// return value once the transaction has committed; any throw or rejection aborts it.
async function runTx(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    let t;
    try { t = db.transaction(stores, mode); } catch (e) { reject(e); return; }
    let out, failed = null;
    t.oncomplete = () => resolve(out);
    // A failing request bubbles here first (ev.target is the request), then the transaction aborts.
    t.onerror = (ev) => { if (!failed) failed = (ev.target && ev.target.error) || t.error; };
    t.onabort = () => reject(txError(failed || t.error));
    Promise.resolve().then(() => fn(t)).then((v) => { out = v; }, (e) => {
      failed = e;
      try { t.abort(); } catch { /* already finished */ }
    });
  });
}

const single = (store, mode, fn) => runTx(store, mode, (t) => fn(t.objectStore(store)));

// Queue puts for every value. A synchronous throw (bad key, non-cloneable value) rejects runTx,
// which aborts; a request error is left to bubble, which aborts the transaction with that error.
// Either way nothing from the batch is kept.
function putAll(store, vals) {
  for (const v of vals) store.put(v);
}

export const db = {
  get: (store, key) => single(store, 'readonly', (s) => wrap(s.get(key))),
  all: (store) => single(store, 'readonly', (s) => wrap(s.getAll())),
  put: (store, val) => single(store, 'readwrite', (s) => wrap(s.put(val))),
  del: (store, key) => single(store, 'readwrite', (s) => wrap(s.delete(key))),
  clear: (store) => single(store, 'readwrite', (s) => wrap(s.clear())),
  putMany: (store, vals) => single(store, 'readwrite', (s) => putAll(s, vals)),
  byIndex: (store, index, key) => single(store, 'readonly', (s) => wrap(s.index(index).getAll(key))),
  range: (store, lo, hi) => single(store, 'readonly', (s) => wrap(s.getAll(IDBKeyRange.bound(lo, hi)))),
  // Multi-store transaction: fn receives the IDBTransaction; use t.objectStore(name) and only await
  // IndexedDB requests inside it (awaiting anything else lets the transaction auto-commit early).
  tx: (stores, mode, fn) => runTx(stores, mode, fn),
  putAll,
  wrap,
};

export async function getMeta(key, fallback) {
  const r = await db.get('meta', key);
  return r ? r.value : fallback;
}
export const setMeta = (key, value) => db.put('meta', { key, value });

export async function getDay(date) {
  return (await db.get('days', date)) || { date, values: {}, title: '', note: '', gratitude: '', src: {} };
}

export async function saveDay(day) {
  day.updatedAt = Date.now();
  if (day.loggedAt == null && day.values && Object.keys(day.values).length) day.loggedAt = day.updatedAt;
  await db.put('days', day);
}

// Ask Chrome not to evict our data under storage pressure.
export async function requestPersist() {
  if (navigator.storage && navigator.storage.persist) {
    try { return await navigator.storage.persist(); } catch { return false; }
  }
  return false;
}
