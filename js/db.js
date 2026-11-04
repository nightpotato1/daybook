// IndexedDB storage. Everything lives on the phone; nothing is sent anywhere unless the
// user turns on an AI provider or Fitbit sync.
//
// stores:
//   days   {date, values:{metricId:value}, title, note, gratitude, src:{metricId:'fitbit'|...}, updatedAt}
//   food   {id, date, time, name, kcal, protein, carbs, fat, items:[...], source, photoId, createdAt}
//   photos {id, blob}
//   meta   {key, value}   - 'settings', 'metrics', 'foodLibrary'

const DB_NAME = 'daybook';
const VERSION = 1;
let dbp;

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
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function wrap(req) {
  return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    let out;
    Promise.resolve(fn(t.objectStore(store))).then((v) => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const db = {
  get: (store, key) => tx(store, 'readonly', (s) => wrap(s.get(key))),
  all: (store) => tx(store, 'readonly', (s) => wrap(s.getAll())),
  put: (store, val) => tx(store, 'readwrite', (s) => wrap(s.put(val))),
  del: (store, key) => tx(store, 'readwrite', (s) => wrap(s.delete(key))),
  clear: (store) => tx(store, 'readwrite', (s) => wrap(s.clear())),
  putMany: (store, vals) => tx(store, 'readwrite', (s) => { for (const v of vals) s.put(v); }),
  byIndex: (store, index, key) => tx(store, 'readonly', (s) => wrap(s.index(index).getAll(key))),
  range: (store, lo, hi) => tx(store, 'readonly', (s) => wrap(s.getAll(IDBKeyRange.bound(lo, hi)))),
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
  await db.put('days', day);
}

// Ask Chrome not to evict our data under storage pressure.
export async function requestPersist() {
  if (navigator.storage && navigator.storage.persist) {
    try { return await navigator.storage.persist(); } catch { return false; }
  }
  return false;
}
