// Offline cache for the app shell. Bump VERSION when shipping changes.
const VERSION = 'daybook-v1';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './css/app.css',
  './js/main.js', './js/util.js', './js/db.js', './js/metrics.js', './js/data.js', './js/today.js',
  './js/food.js', './js/ai.js', './js/charts.js', './js/stats.js', './js/trends.js', './js/insights.js',
  './js/settings.js', './js/io.js', './js/health.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Network-first for our own files (so updates show up when online), cache fallback offline.
// Cross-origin requests (AI, Fitbit, CDN) are left alone.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('./index.html'))),
  );
});
