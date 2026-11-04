// Shell: bottom nav, hash router, first-run card, backup banner, update prompt, SW registration.
// Routes (docs/v2-design.md 3.7):
//   #/today[/YYYY-MM-DD|_]   #/food[/YYYY-MM-DD|_][/add|/photo|/edit/:id]
//   #/trends[/:metricId]     #/insights[/:metricId]   #/notes   #/about   #/settings
import * as U from './util.js';
import { h, $, toast, logicalToday, prettyDate } from './util.js';
import { getMeta, setMeta, requestPersist } from './db.js';
import { loadSettings } from './metrics.js';
import { backupNow, backupStatus } from './io.js';
import { renderToday } from './today.js';
import { renderFood } from './food.js';
import { renderTrends } from './trends.js';
import { renderInsights } from './insights.js';
import { renderNotes } from './notes.js';
import { renderAbout } from './about.js';
import { renderSettings } from './settings.js';
import { handleRedirect } from './health.js';

const NAV = [
  ['today', 'Today', '◉'],
  ['food', 'Food', '🍽'],
  ['trends', 'Trends', '📈'],
  ['insights', 'Insights', '⚯'],
  ['notes', 'Notes', '✎'],
  ['settings', 'Settings', '⚙'],
];

// Captured as early as possible: Chrome fires it once, before the first render finishes.
let installEvent = null;
// The tab that accepted the install prompt is still not display-mode standalone; this flag
// keeps the first-run card from offering Install again there.
let installed = false;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  renderBanners();
});
window.addEventListener('appinstalled', () => {
  installEvent = null;
  installed = true;
  renderBanners();
  requestPersist().then(() => refreshStatus(true));
});

// ---- helpers ----

function localValidYmd(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}
const validYmd = typeof U.validYmd === 'function' ? U.validYmd : localValidYmd;

async function todayDate() {
  try { return logicalToday((await loadSettings()).dayStartHour); }
  catch { return logicalToday(); }
}

function isStandalone() {
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
}

// Which browser holds the data: this matters because Chrome and Samsung Internet keep separate copies.
function browserName() {
  const brands = navigator.userAgentData && navigator.userAgentData.brands;
  if (brands && brands.length) {
    const real = brands.find((b) => !/not.?a.?brand|chromium/i.test(b.brand));
    if (real) return `${real.brand} ${real.version}`.trim();
  }
  const ua = navigator.userAgent || '';
  if (/SamsungBrowser/i.test(ua)) return 'Samsung Internet';
  if (/Firefox\//i.test(ua)) return 'Firefox';
  if (/EdgA?\//i.test(ua)) return 'Edge';
  if (/Chrome\//i.test(ua)) return 'Chrome';
  if (/Safari\//i.test(ua)) return 'Safari';
  return 'this browser';
}

function fmtWhen(v) {
  if (!v) return 'never';
  const d = new Date(v);
  if (isNaN(d)) return 'never';
  return U.ymd ? prettyDate(U.ymd(d)) : d.toLocaleDateString();
}

// ---- banners: first-run card, backup nag, update prompt ----

const state = { introSeen: true, status: null, persisted: null, updated: false };
let bannersEl;

function needsBackup(st) {
  if (!st || (st.days || 0) + (st.food || 0) === 0) return false;
  const WEEK = 7 * 86400000;
  if (st.newSinceBackup > 30) return true;
  if (!st.lastBackupAt) return (st.days || 0) >= 7;
  const age = Date.now() - new Date(st.lastBackupAt).getTime();
  return isNaN(age) || age > WEEK;
}

let statusPromise = null;
// Re-reads backupStatus() on every route (two getAll calls, cheap at this size) so a backup or
// import made on Settings is reflected as soon as the user leaves it; concurrent callers share one read.
function refreshStatus(force = false) {
  if (statusPromise && !force) return statusPromise;
  statusPromise = (async () => {
    try { state.status = await backupStatus(); } catch (e) { console.warn('backupStatus', e); state.status = null; }
    if (state.status && typeof state.status.persisted === 'boolean') state.persisted = state.status.persisted;
    else if (navigator.storage && navigator.storage.persisted) {
      try { state.persisted = await navigator.storage.persisted(); } catch { state.persisted = null; }
    }
    renderBanners();
  })().finally(() => { statusPromise = null; });
  return statusPromise;
}

function introCard() {
  const standalone = isStandalone() || installed;
  const go = (hash) => () => { location.hash = hash; };
  const install = async () => {
    if (installEvent) {
      const ev = installEvent;
      installEvent = null;
      ev.prompt();
      try {
        const choice = await ev.userChoice;
        if (choice && choice.outcome === 'accepted') installed = true;
      } catch { /* ignore */ }
      renderBanners();
    } else {
      toast('Chrome menu (⋮) → Add to Home screen → Install', 4000);
    }
  };
  const gotIt = async () => {
    state.introSeen = true;
    renderBanners();
    try { await setMeta('seenIntro', Date.now()); } catch (e) { console.warn(e); }
  };
  return h('section', { class: 'card sh-intro' },
    h('h3', {}, 'Before you type anything'),
    h('p', {}, 'Everything you type is saved in this phone’s browser only. The web address is just the app: no account, no server.'),
    h('p', {}, 'Anyone else opening the link gets their own empty copy and cannot see or change yours. The copy on the PC is separate too.'),
    h('p', {}, 'Clearing Chrome’s site data or uninstalling erases it, so back up from Settings now and then.'),
    h('p', {}, 'Only a food photo (and the food text with it) ever leaves the phone, and only when you press Estimate.'),
    h('p', { class: 'small muted' },
      `Your data is held by: ${browserName()}${standalone ? ' (installed app)' : ''}.`,
      standalone ? null : ' Open this in Chrome and install it so your data is in one place.'),
    h('div', { class: 'sh-actions' },
      standalone ? null : h('button', { class: 'btn primary', onclick: install }, 'Install'),
      h('button', { class: 'btn', onclick: go('#/settings') }, 'Import your history'),
      h('button', { class: 'btn', onclick: go('#/about') }, 'How this works'),
      h('button', { class: 'btn', onclick: gotIt }, 'Got it')));
}

function backupBanner() {
  const st = state.status;
  const prot = state.persisted == null ? 'unknown' : state.persisted ? 'yes' : 'no';
  const btn = h('button', { class: 'btn primary', onclick: async () => {
    btn.disabled = true;
    try {
      // false = the share sheet was dismissed; backupNow() then leaves lastBackupAt alone
      const ok = await backupNow();
      toast(ok ? 'Backup made. Send it to Drive or keep it in Downloads.' : 'Backup cancelled, nothing was saved.', 3500);
      await refreshStatus(true);
    } catch (e) {
      console.error(e);
      toast('Backup failed: ' + (e.message || e), 4000);
    } finally { btn.disabled = false; }
  } }, 'Back up now');
  return h('section', { class: 'card sh-backup' },
    h('div', { class: 'grow' },
      h('div', {}, 'Stored only on this phone. ', h('b', {}, `Last backup: ${fmtWhen(st.lastBackupAt)}.`)),
      h('div', { class: 'small muted' }, `Protected from automatic clearing: ${prot}. `, h('a', { href: '#/about' }, 'Why?'))),
    btn);
}

function updateBanner() {
  return h('button', { class: 'sh-update', onclick: () => location.reload() }, 'Updated, tap to reload');
}

function renderBanners() {
  if (!bannersEl) return;
  const kids = [];
  if (!state.introSeen) kids.push(introCard());
  if (needsBackup(state.status)) kids.push(backupBanner());
  if (state.updated) kids.push(updateBanner());
  bannersEl.replaceChildren(...kids);
  bannersEl.classList.toggle('hidden', kids.length === 0);
}

// ---- router ----

let renderId = 0;

function redirect(hash) {
  history.replaceState(null, '', hash);
  return route();
}

function setNav(page) {
  document.querySelectorAll('nav a').forEach((el) => el.classList.toggle('on', el.dataset.page === page));
}

async function route() {
  const id = ++renderId;
  const parts = (location.hash || '#/today').split('/');
  const page = parts[1] || 'today';
  const a = parts[2], b = parts[3], c = parts[4];
  const view = $('#view');
  setNav(page);

  const today = await todayDate();
  if (id !== renderId) return;
  let date = null;
  if (page === 'today' || page === 'food') {
    // '_' and an empty segment both mean today; anything that is not a real date goes to today
    if (!a || a === '_') date = today;
    else if (validYmd(a)) date = a;
    else {
      const tail = page === 'food' && b ? '/' + [b, c].filter(Boolean).join('/') : '';
      return redirect(`#/${page}/${today}${tail}`);
    }
  }

  // Each render gets its own container; a stale render writes into a container never mounted.
  const stage = h('div', { class: 'sh-stage' });
  try {
    if (page === 'today') await renderToday(stage, date);
    else if (page === 'food') await renderFood(stage, date, b, c);
    else if (page === 'trends') await renderTrends(stage, a);
    else if (page === 'insights') await renderInsights(stage, a);
    else if (page === 'notes') await renderNotes(stage);
    else if (page === 'about') await renderAbout(stage);
    else if (page === 'settings') await renderSettings(stage);
    else return redirect('#/today');
  } catch (e) {
    console.error(e);
    stage.replaceChildren(h('section', { class: 'card' },
      h('h3', {}, 'Something broke'),
      h('p', { class: 'small muted' }, 'Your data is not affected. If this keeps happening, back up from Settings and reload.'),
      h('pre', { class: 'small' }, String(e && e.stack || e))));
  }
  if (id !== renderId) return;
  view.replaceChildren(stage);
  if (!b) window.scrollTo(0, 0);
  refreshStatus();
}

// ---- boot ----

function shell() {
  bannersEl = h('div', { id: 'banners', class: 'sh-banners hidden' });
  document.body.append(
    bannersEl,
    h('main', { id: 'view' }),
    h('nav', { class: 'sh-nav' }, NAV.map(([pid, label, icon]) =>
      h('a', { href: `#/${pid}`, 'data-page': pid, 'aria-label': label },
        h('span', { class: 'nav-i' }, icon), h('span', {}, label)))));
}

async function boot() {
  shell();
  window.addEventListener('hashchange', route);
  try { await handleRedirect(); } catch (e) { console.error(e); }
  try { state.introSeen = (await getMeta('seenIntro', null)) != null; } catch { state.introSeen = false; }
  await route(); // route() ends with refreshStatus(), which also draws the banners
  await refreshStatus();
  if (state.status && state.status.days > 0) requestPersist().then(() => refreshStatus(true));
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const wasControlled = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'updated' && wasControlled) { state.updated = true; renderBanners(); }
  });
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW', e));
}

boot();
