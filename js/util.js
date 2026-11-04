// Small DOM + date helpers shared by every screen.

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function svgEl(tag, attrs = {}, ...kids) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  for (const kid of kids.flat(Infinity)) {
    if (kid == null) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// ---- dates: days are local calendar strings "YYYY-MM-DD" ----

export function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(s, n) {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

export function daysBetween(a, b) {
  return Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
}

// True only for "YYYY-MM-DD" naming a real calendar date (rejects 2025-13-45, 2025-02-30, 'foo').
export function validYmd(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = parseYmd(s);
  return !isNaN(d) && ymd(d) === s;
}

// "Today" rolls over at settings.dayStartHour (default 4am) so 1am still counts as last night.
export function logicalToday(dayStartHour = 4) {
  const now = new Date();
  if (now.getHours() < dayStartHour) now.setDate(now.getDate() - 1);
  return ymd(now);
}

export function prettyDate(s, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  return parseYmd(s).toLocaleDateString(undefined, opts);
}

// Clock times are stored as minutes after midnight. Bedtimes are stored "night-normalised"
// (00:00-11:59 become 24:00-35:59) so averages of 23:30 and 01:30 come out at 00:30, not noon.
export function minsToClock(m) {
  if (m == null || isNaN(m)) return '';
  m = ((Math.round(m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function clockToMins(str, night = false) {
  if (!str) return null;
  const [hh, mm] = str.split(':').map(Number);
  let m = hh * 60 + (mm || 0);
  if (night && m < 720) m += 1440;
  return m;
}

export function fmtNum(v, digits = 1) {
  if (v == null || v === '' || isNaN(v)) return '–';
  const n = Number(v);
  return Number.isInteger(n) ? String(n) : n.toFixed(digits).replace(/\.0+$/, '');
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function debounce(fn, ms = 300) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function toast(msg, ms = 2200) {
  let el = document.getElementById('toast');
  if (!el) { el = h('div', { id: 'toast' }); document.body.append(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
}

export function download(filename, text, type = 'text/plain') {
  const blob = text instanceof Blob ? text : new Blob([text], { type });
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// Share a file through the Android share sheet when possible; fall back to a download.
// Resolves true when the file was shared or downloaded, false when the user dismissed the share sheet.
export async function shareOrDownload(filename, text, type = 'text/csv') {
  const file = new File([text], filename, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return true; }
    catch (e) { if (e.name === 'AbortError') return false; }
  }
  download(filename, text, type);
  return true;
}

export function modal(title, body, actions = []) {
  return new Promise((resolve) => {
    const close = (v) => { wrap.remove(); resolve(v); };
    const wrap = h('div', { class: 'modal-wrap', onclick: (e) => { if (e.target === wrap) close(null); } },
      h('div', { class: 'modal' },
        h('div', { class: 'modal-head' }, h('h3', {}, title), h('button', { class: 'icon-btn', onclick: () => close(null), 'aria-label': 'Close' }, '✕')),
        h('div', { class: 'modal-body' }, body),
        actions.length ? h('div', { class: 'modal-actions' },
          actions.map((a) => h('button', { class: a.primary ? 'btn primary' : 'btn', onclick: async () => {
            const v = a.onClick ? await a.onClick() : a.value;
            if (v !== false) close(v ?? a.value);
          } }, a.label))) : null));
    document.body.append(wrap);
  });
}

export function confirmDialog(msg, okLabel = 'OK') {
  return modal('Confirm', h('p', {}, msg), [{ label: 'Cancel', value: false }, { label: okLabel, value: true, primary: true }]);
}

// Downscale a photo File to a JPEG data URL (for AI) and a small thumbnail Blob (for storage).
export async function prepareImage(file, maxSide = 1024, quality = 0.82) {
  const bmp = await createImageBitmap(file);
  const draw = (side, q) => {
    const s = Math.min(1, side / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return new Promise((r) => c.toBlob(r, 'image/jpeg', q));
  };
  const big = await draw(maxSide, quality);
  const thumb = await draw(320, 0.7);
  const b64 = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(',')[1]); fr.readAsDataURL(big); });
  return { base64: b64, mime: 'image/jpeg', thumb };
}
