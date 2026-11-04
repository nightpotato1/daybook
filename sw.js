// Offline cache for the app shell.
//
// Strategy (docs/v2-design.md section 5):
//   - install: precache every SHELL file with cache:'reload' (bypasses the HTTP cache, so a
//     deploy never mixes old and new modules). addAll rejects on any non-ok response, so a
//     GitHub Pages 404/500 can never replace a working cache.
//   - fetch: cache-first for SHELL files; index.html fallback only for navigations; never
//     cache non-ok responses or URLs with a query string.
//   - activate: delete old daybook-* caches (only ours: the origin is shared with the user's other
//     GitHub Pages projects), then tell open pages {type:'updated'} so main.js can offer
//     "Updated, tap to reload". skipWaiting() activates at once so the open page gets that
//     message; no clients.claim() is needed, and the page keeps the modules it already loaded
//     until it reloads.
//
// To ship a change: bump VERSION (any new string), commit, push.
const VERSION = 'daybook-v2';
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './css/app.css', './css/shell.css', './css/food.css', './css/charts.css', './css/settings.css',
  './js/main.js', './js/util.js', './js/db.js', './js/metrics.js', './js/data.js', './js/today.js',
  './js/food.js', './js/ai.js', './js/charts.js', './js/stats.js', './js/trends.js', './js/insights.js',
  './js/settings.js', './js/io.js', './js/health.js', './js/notes.js', './js/about.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
  './icons/icon-192-maskable.png', './icons/icon-512-maskable.png',
];
const INDEX = new URL('./index.html', self.location.href).href;
// Absolute URLs without query/hash, so a navigation to "./?code=..." still maps to the shell.
const SHELL_URLS = new Set(SHELL.map((u) => new URL(u, self.location.href).href));

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    const old = keys.filter((k) => k !== VERSION && k.startsWith('daybook-'));
    await Promise.all(old.map((k) => caches.delete(k)));
    if (!old.length) return; // first install: nothing to announce
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clients) c.postMessage({ type: 'updated', version: VERSION });
  })());
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'skipWaiting') self.skipWaiting();
});

function cacheKey(url) {
  return url.origin + url.pathname;
}

async function cacheFirst(req, url) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(cacheKey(url));
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok && !url.search) cache.put(cacheKey(url), res.clone());
    return res;
  } catch (err) {
    if (req.mode === 'navigate') {
      const index = await cache.match(INDEX);
      if (index) return index;
    }
    throw err;
  }
}

async function navigateOrShell(req) {
  try {
    return await fetch(req);
  } catch (err) {
    const index = await caches.match(INDEX);
    if (index) return index;
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // AI, Google, Open Food Facts: untouched
  if (SHELL_URLS.has(cacheKey(url))) e.respondWith(cacheFirst(req, url));
  else if (req.mode === 'navigate') e.respondWith(navigateOrShell(req));
  // anything else (not part of the shell): plain network, never cached
});
