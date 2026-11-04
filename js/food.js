// Food log: per-day list, plus one editor used for manual entry, past foods, usual meals,
// barcode lookup and the AI estimate + correction loop. Styles live in css/food.css (fd- prefix).
import { h, prettyDate, fmtNum, uid, toast, prepareImage, confirmDialog, modal, logicalToday, clockToMins, parseYmd, ymd } from './util.js';
import { db, getMeta, setMeta } from './db.js';
import { loadSettings } from './metrics.js';
import { foodTotals } from './data.js';
import { estimateFood, aiReady, aiCallsToday, GEMINI_DAILY_LIMIT } from './ai.js';

const MACROS = ['kcal', 'protein', 'carbs', 'fat'];
const r1 = (x) => Math.round(x * 10) / 10;

// Hidden calories the user can add with one tap, no AI call: [name, amount, grams, kcal, protein, carbs, fat]
const HIDDEN = [
  ['Oil / ghee', '1 tbsp', 14, 120, 0, 0, 14],
  ['Butter', '1 tbsp', 14, 100, 0, 0, 11],
  ['Sauce / dressing', '2 tbsp', 30, 90, 0, 0, 0],
  ['Sugar in drink', '2 tsp', 8, 32, 0, 8, 0],
];

// Object URLs for thumbnails are revoked on the next food render instead of leaking for the page's life.
let urls = [];
const objUrl = (blob) => { const u = URL.createObjectURL(blob); urls.push(u); return u; };
function revokeAll() { for (const u of urls) URL.revokeObjectURL(u); urls = []; }

function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  const d = parseYmd(s);
  return !isNaN(d) && ymd(d) === s;
}

export async function renderFood(root, date, mode, id) {
  revokeAll();
  const settings = await loadSettings();
  if (!validDate(date)) date = logicalToday(settings.dayStartHour); // covers '_' and garbage
  if (mode === 'edit' && id) {
    const entry = await db.get('food', id);
    if (!entry) {
      root.replaceChildren(head(date, `#/food/${date}`, 'Food'), h('p', { class: 'empty' }, 'That food entry no longer exists.'));
      return;
    }
    return editor(root, entry.date || date, entry, null, settings);
  }
  if (mode === 'add' || mode === 'photo') return editor(root, date, null, mode, settings);
  return dayList(root, date, settings);
}

function head(date, backHref, title) {
  return h('header', { class: 'day-head' },
    h('a', { class: 'icon-btn', href: backHref, 'aria-label': 'Back' }, '‹'),
    h('div', { class: 'day-title' }, h('h2', {}, title), h('small', {}, prettyDate(date))),
    h('span'));
}

// Times before dayStartHour belong to the end of the logical day (a 00:40 snack comes after dinner).
function sortMins(time, dayStart) {
  const m = clockToMins(time);
  if (m == null) return 1e9;
  return m < dayStart * 60 ? m + 1440 : m;
}
function timeLabel(time, dayStart) {
  if (!time) return '';
  const m = clockToMins(time);
  return m != null && m < dayStart * 60 ? `${time} (late)` : time;
}

async function dayList(root, date, settings) {
  const dayStart = settings.dayStartHour ?? 4;
  const entries = (await db.byIndex('food', 'date', date))
    .sort((a, b) => sortMins(a.time, dayStart) - sortMins(b.time, dayStart) || (a.createdAt || 0) - (b.createdAt || 0));
  const t = foodTotals(entries);
  const thumbs = await Promise.all(entries.map((e) => (e.photoId ? db.get('photos', e.photoId) : null)));

  root.replaceChildren(
    head(date, `#/today/${date}`, 'Food'),
    h('section', { class: 'card fd-totals' },
      totalBox('kcal', t.kcal, settings.kcalGoal),
      totalBox('protein g', t.protein, settings.proteinGoal),
      totalBox('carbs g', t.carbs), totalBox('fat g', t.fat)),
    h('div', { class: 'fd-actions' },
      aiReady(settings)
        ? h('a', { class: 'btn primary', href: `#/food/${date}/photo` }, '📷 Photo')
        : h('a', { class: 'btn primary', href: '#/settings' }, 'Set up free photo estimates'),
      h('a', { class: 'btn', href: `#/food/${date}/add` }, '+ Add')),
    entries.length ? h('section', { class: 'card fd-list' }, entries.map((e, i) =>
      h('a', { class: 'fd-row', href: `#/food/${date}/edit/${e.id}` },
        thumbs[i] ? h('img', { class: 'fd-thumb', src: objUrl(thumbs[i].blob), alt: '' }) : h('div', { class: 'fd-thumb fd-ph' }, sourceIcon(e.source)),
        h('div', { class: 'fd-main' },
          h('div', {}, e.name),
          h('small', {}, [timeLabel(e.time, dayStart), e.items?.length > 1 ? `${e.items.length} items` : null].filter(Boolean).join(' · '))),
        h('div', { class: 'fd-num' }, h('b', {}, fmtNum(e.kcal, 0)), h('small', {}, ` kcal · ${fmtNum(e.protein, 0)}g p`)))))
      : h('p', { class: 'empty' }, 'Nothing logged yet.'));
}

const sourceIcon = (s) => (s === 'ai' || s === 'ai-edited' ? '✨' : s === 'library' ? '↺' : s === 'barcode' ? '▤' : '✎');

function totalBox(label, v, goal) {
  return h('div', { class: 'fd-total' }, h('b', {}, fmtNum(v, 0)), h('small', {}, label), goal ? h('small', { class: 'fd-goal' }, `of ${goal}`) : null);
}

// ---------- editor ----------

async function editor(root, date, entry, mode, settings) {
  const isNew = !entry;
  const now = new Date();
  entry = entry ? structuredClone(entry) : {
    id: uid(), date, time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    name: '', items: [], source: 'manual', createdAt: Date.now(),
  };
  if (!entry.items || !entry.items.length) {
    entry.items = isNew ? [] : [{ name: entry.name, amount: '', kcal: entry.kcal, protein: entry.protein, carbs: entry.carbs || 0, fat: entry.fat || 0 }];
  }
  entry.items = entry.items.map(normItem);
  delete entry._aiName;
  // v1 entries carry the source on the entry only; give each item that src so re-saving keeps the provenance
  const legacy = ['ai', 'library', 'barcode', 'import'].includes(entry.source) ? entry.source : 'manual';
  for (const it of entry.items) if (!it.src) it.src = legacy;

  let image = null;          // {base64, mime, thumb} of a photo taken in this session
  let inflight = null;       // AbortController while an estimate is running
  let restartAI = false;     // a new photo arrived while an estimate was running: rerun when it ends
  let notedOnce = false;     // the ±35% note is shown under the first AI result only
  const edited = new WeakMap(); // item -> Set of macro keys the user typed by hand (rescaling leaves them alone)
  // A saved item whose macro no longer matches its reference portion was hand-typed in an earlier session
  // (same factor rule as factorOf: grams define the portion, kcal only when there are no grams).
  for (const it of entry.items) {
    const b = it.base;
    if (!b) continue;
    const f = b.grams > 0 && it.grams > 0 ? it.grams / b.grams : b.kcal > 0 && it.kcal > 0 ? it.kcal / b.kcal : 1;
    for (const k of MACROS) {
      if (b[k] > 0 && Math.abs(it[k] - b[k] * f) > 0.5 + 0.02 * b[k]) {
        if (!edited.has(it)) edited.set(it, new Set());
        edited.get(it).add(k);
      }
    }
  }

  const itemsBox = h('div', { class: 'fd-items' });
  const totalsLine = h('div', { class: 'fd-total-line' });
  const status = h('div', { class: 'fd-status' });
  const qBox = h('div', { class: 'fd-questions' });
  const noteBox = h('div', { class: 'fd-note' });
  const countLine = h('small', { class: 'fd-count' });
  const preview = h('div', { class: 'fd-preview' });
  if (entry.photoId) db.get('photos', entry.photoId).then((p) => { if (p) preview.replaceChildren(h('img', { src: objUrl(p.blob), alt: '' })); });

  // --- items ---

  let hadItems = null;
  function paintItems() {
    itemsBox.replaceChildren(...entry.items.map((it, idx) => itemRow(it, idx)));
    paintTotals();
    const has = entry.items.length > 0;
    if (has !== hadItems) { libDetails.open = !has; hadItems = has; } // collapse Past foods once the entry has items
    saveMealBtn.classList.toggle('hidden', !has);
  }

  const touch = (it) => { if (it.src === 'ai') it.src = 'ai-edited'; else if (!it.src) it.src = 'manual'; };

  function ensureBase(it) {
    if (!it.base) it.base = { grams: Number(it.grams) || 0, kcal: Number(it.kcal) || 0, protein: Number(it.protein) || 0, carbs: Number(it.carbs) || 0, fat: Number(it.fat) || 0, amount: it.amount || '' };
    return it.base;
  }
  function factorOf(it) {
    const b = ensureBase(it);
    if (b.grams > 0 && it.grams > 0) return it.grams / b.grams;
    if (b.kcal > 0 && it.kcal > 0 && !edited.get(it)?.has('kcal')) return it.kcal / b.kcal;
    return 1;
  }
  // Scale every macro the user has not typed by hand from the reference portion; regenerate the amount label.
  function applyFactor(it, f) {
    const b = ensureBase(it);
    const ed = edited.get(it) || new Set();
    if (b.grams > 0) it.grams = r1(b.grams * f);
    for (const k of MACROS) if (!ed.has(k)) it[k] = k === 'kcal' ? Math.round(b[k] * f) : r1(b[k] * f);
    const orig = b.amount || '';
    if (Math.abs(f - 1) < 1e-6) it.amount = orig;
    else if (b.grams > 0 && /^\d+(\.\d+)?\s*g$/.test(orig)) it.amount = `${it.grams} g`;
    else it.amount = `${Math.round(f * 100) / 100}× ${orig || 'portion'}`;
    touch(it);
  }

  function itemRow(it, idx) {
    const inputs = {};
    const refresh = () => {
      inputs.amount.value = it.amount || '';
      for (const k of MACROS) inputs[k].value = it[k] || '';
      paintTotals();
    };
    const field = (key, attrs, onInput) => {
      const el = h('input', { ...attrs, value: attrs.type === 'number' ? (it[key] || '') : (it[key] ?? ''), oninput: (e) => {
        if (attrs.type === 'number') {
          if (e.target.validity.badInput) return; // still typing a decimal
          it[key] = e.target.value === '' ? 0 : Number(e.target.value);
        } else it[key] = e.target.value;
        onInput ? onInput() : touch(it);
        paintTotals();
      } });
      inputs[key] = el;
      return el;
    };
    const macroInput = (k) => field(k, { type: 'number', inputmode: 'decimal', min: 0 }, () => {
      if (!edited.has(it)) edited.set(it, new Set());
      edited.get(it).add(k);
      touch(it);
    });
    const gramsInput = field('grams', { type: 'number', inputmode: 'decimal', min: 0 }, () => {
      const b = ensureBase(it);
      if (b.grams > 0 && it.grams > 0) { applyFactor(it, it.grams / b.grams); refresh(); }
      else if (it.grams > 0) b.grams = it.grams; // first gram figure for this item defines the reference portion
      touch(it);
    });
    const chip = (k) => h('button', { class: 'fd-chip', type: 'button', onclick: () => { applyFactor(it, factorOf(it) * k); paintItems(); } }, `×${k}`);
    return h('div', { class: 'fd-it' },
      h('div', { class: 'fd-it-top' },
        field('name', { type: 'text', placeholder: 'Food', class: 'grow' }),
        h('small', { class: 'fd-src' }, srcLabel(it.src)),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Remove item', onclick: () => { entry.items.splice(idx, 1); paintItems(); } }, '✕')),
      h('div', { class: 'fd-it-nums' },
        h('label', {}, 'amount', field('amount', { type: 'text', placeholder: '1 cup' })),
        h('label', {}, 'grams', gramsInput),
        h('label', {}, 'kcal', macroInput('kcal')),
        h('label', {}, 'protein', macroInput('protein')),
        h('label', {}, 'carbs', macroInput('carbs')),
        h('label', {}, 'fat', macroInput('fat'))),
      h('div', { class: 'fd-it-chips' }, h('small', { class: 'muted' }, 'portion'), [0.5, 0.75, 1.5, 2].map(chip)));
  }

  function paintTotals() {
    const t = sumItems(entry.items);
    const ai = entry.ai;
    totalsLine.replaceChildren(h('span', {},
      h('b', {}, `${fmtNum(t.kcal, 0)} kcal`),
      ai && ai.kcal_low > 0 && ai.kcal_high > ai.kcal_low ? h('span', { class: 'fd-range' }, ` AI range ${ai.kcal_low}–${ai.kcal_high}`) : null,
      h('span', { class: 'muted' }, ` · ${fmtNum(t.protein, 0)}g protein · ${fmtNum(t.carbs, 0)}g carbs · ${fmtNum(t.fat, 0)}g fat`)));
  }

  const hiddenChips = h('div', { class: 'fd-hidden' },
    h('small', { class: 'muted' }, 'Add hidden'),
    HIDDEN.map(([name, amount, grams, kcal, protein, carbs, fat]) => h('button', { class: 'fd-chip', type: 'button', onclick: () => {
      entry.items.push({ name, amount, grams, kcal, protein, carbs, fat, src: 'manual', base: { grams, kcal, protein, carbs, fat, amount } });
      paintItems();
    } }, `${name} +${kcal}`)));

  // --- AI ---

  const describe = h('textarea', { rows: 2, placeholder: 'Describe it, or correct the estimate: "2 eggs not 3, cooked in butter, big mug of chai with sugar"' });

  function setupMsg() {
    return h('span', {}, 'Photo estimates are free with a Gemini key: ',
      h('a', { href: 'https://aistudio.google.com/apikey', target: '_blank', rel: 'noopener' }, 'get one at aistudio.google.com/apikey'),
      ', paste it in ', h('a', { href: '#/settings' }, 'Settings → AI'), '. Or type the numbers yourself.');
  }

  async function refreshCount() {
    if (settings.ai?.provider !== 'gemini') { countLine.textContent = ''; return; }
    try { countLine.textContent = `${await aiCallsToday()}/${GEMINI_DAILY_LIMIT} used today`; } catch { countLine.textContent = ''; }
  }

  async function storedImage() {
    if (!entry.photoId) return null;
    const p = await db.get('photos', entry.photoId);
    if (!p) return null;
    const base64 = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = () => rej(fr.error); fr.readAsDataURL(p.blob); });
    return { base64, mime: p.blob.type || 'image/jpeg', thumb: null };
  }

  function cancelAI() { if (inflight) inflight.abort(); }

  async function runAI() {
    if (inflight) { restartAI = true; inflight.abort(); return; } // a new photo: drop the old request, rerun below
    if (!aiReady(settings)) { status.replaceChildren(setupMsg()); return; }
    const text = describe.value.trim();
    const hasPrev = entry.items.some((i) => i.name);
    let img = image;
    if (!img) { try { img = await storedImage(); } catch { img = null; } }
    if (!img && !text) { status.textContent = 'Take a photo or describe the food first.'; return; }
    if (hasPrev && !text && !image) { status.textContent = 'Say what to fix (or tap a question), then Re-estimate.'; return; }
    const corrections = hasPrev ? [...(entry.ai?.corrections || []), ...(text ? [text] : [])] : [];
    inflight = new AbortController();
    aiBtn.textContent = 'Cancel';
    status.replaceChildren(h('span', { class: 'fd-spinner' }), hasPrev ? ' Correcting…' : ' Estimating…');
    qBox.replaceChildren();
    try {
      const r = await estimateFood({
        image: img, text,
        previous: hasPrev ? entry.items.filter((i) => i.name).map(normItem) : null,
        corrections, signal: inflight.signal,
      }, settings);
      applyResult(r, corrections, text);
    } catch (e) {
      status.textContent = e.message || String(e);
    } finally {
      inflight = null;
      aiBtn.textContent = entry.ai ? '✨ Re-estimate' : '✨ Estimate';
      refreshCount();
      if (restartAI) { restartAI = false; runAI(); }
    }
  }

  function applyResult(r, corrections, text) {
    const fresh = !entry.items.some((i) => i.name);
    const aiItems = r.items.map((i) => ({ ...i, src: 'ai', base: { grams: i.grams, kcal: i.kcal, protein: i.protein, carbs: i.carbs, fat: i.fat, amount: i.amount } }));
    entry.items = fresh ? aiItems : mergeItems(entry.items, aiItems, text);
    if (!entry.name || entry.name === entry.ai?.meal) { entry.name = r.meal; nameInput.value = r.meal; }
    entry.ai = {
      provider: r.provider, model: r.model, at: Date.now(), meal: r.meal, items: r.items, notes: r.notes,
      kcal_low: r.kcal_low, kcal_high: r.kcal_high, assumed: r.assumed, questions: r.questions, corrections,
    };
    describe.value = '';
    describe.placeholder = 'Wrong? Say what to fix and press Re-estimate';
    const bits = [];
    if (r.notes) bits.push(`Note: ${r.notes}`);
    if (r.assumed.length) bits.push(`Assumed: ${r.assumed.map((a) => `${a.name} ${a.kcal > 0 ? '+' : ''}${a.kcal}`).join(', ')}`);
    if (!bits.length) bits.push('Check the items and fix anything that is off.');
    status.replaceChildren(bits.join(' · '));
    qBox.replaceChildren(...r.questions.map(questionRow));
    if (!notedOnce) {
      notedOnce = true;
      noteBox.textContent = 'Photo estimates are typically ±35% and usually undercount. Portions are the main error: fix grams or tap a portion chip.';
    }
    if (r.notice) toast(r.notice, 5000);
    paintItems();
  }

  // Yes/No answers are appended to the correction text; the user sends them with Re-estimate.
  function questionRow(q) {
    const row = h('div', { class: 'fd-q' }, h('span', {}, q));
    const answer = (a) => { describe.value = (describe.value.trim() ? describe.value.trim() + '\n' : '') + `${a}: ${q}`; row.remove(); };
    row.append(h('button', { class: 'fd-chip', type: 'button', onclick: () => answer('Yes') }, 'Yes'), h('button', { class: 'fd-chip', type: 'button', onclick: () => answer('No') }, 'No'));
    return row;
  }

  const aiBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => (inflight ? cancelAI() : runAI()) }, entry.ai ? '✨ Re-estimate' : '✨ Estimate');
  refreshCount();

  async function onPhoto(e) {
    const input = e.target;
    const f = input.files && input.files[0];
    input.value = ''; // so picking the same file again fires change
    if (!f) return;
    try {
      image = await prepareImage(f);
      if (!image || !image.base64 || !image.thumb) throw new Error('empty');
    } catch {
      image = null;
      status.textContent = 'Could not read that photo. HEIC is not supported by Chrome: switch the camera to JPEG (Camera settings → Picture formats) or pick a JPEG from the gallery.';
      return;
    }
    preview.replaceChildren(h('img', { src: objUrl(image.thumb), alt: 'Meal photo' }));
    runAI();
  }
  const fileInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'hidden', onchange: onPhoto });
  const galleryInput = h('input', { type: 'file', accept: 'image/*', class: 'hidden', onchange: onPhoto });

  // --- barcode ---

  async function scanBarcode() {
    let code = null;
    if ('BarcodeDetector' in window && navigator.mediaDevices?.getUserMedia) {
      code = await scanWithCamera();
      if (code === undefined) return; // cancelled
    }
    if (!code) code = await typeCode();
    if (!code) return;
    status.replaceChildren(h('span', { class: 'fd-spinner' }), ` Looking up ${code}…`);
    try {
      const item = await lookupBarcode(code);
      entry.items.push(item);
      if (!entry.name) { entry.name = item.name; nameInput.value = item.name; }
      status.textContent = `Added ${item.name} from Open Food Facts. Set the grams you ate.`;
      paintItems();
    } catch (e) { status.textContent = e.message || String(e); }
  }

  // --- past foods ---

  const lib = await foodLibrary();
  const libResults = h('div', { class: 'fd-lib-results' });
  function paintLib() {
    const q = libSearch.value.trim().toLowerCase();
    const hits = (q ? lib.filter((f) => f.key.includes(q) || f.name.toLowerCase().includes(q)) : lib).slice(0, q ? 12 : 8);
    libResults.replaceChildren(...hits.map(libHit));
    if (!hits.length) libResults.replaceChildren(h('p', { class: 'empty' }, lib.length ? 'No match.' : 'Foods you log appear here.'));
  }
  const libSearch = h('input', { type: 'search', placeholder: 'Search foods you have logged before', oninput: paintLib });

  function libHit(f) {
    const row = h('button', { class: 'fd-hit', type: 'button' },
      h('span', {}, f.name, f.unit ? h('small', { class: 'muted' }, ` per ${f.unit}`) : null),
      h('small', {}, `${fmtNum(f.per.kcal, 0)} kcal · ${fmtNum(f.per.protein, 0)}p · ×${f.count}`));
    row.addEventListener('click', () => row.replaceWith(libStepper(f)));
    return row;
  }

  // Quantity stepper shown when a past food is tapped; Add builds the item from per-unit values.
  function libStepper(f) {
    const step = f.unit === 'g' || f.unit === 'ml' ? 10 : 0.5;
    let qty = f.qty || 1;
    const qtyEl = h('b', {});
    const kcalEl = h('small', {});
    const paint = () => { qtyEl.textContent = `${qty} ${f.unit}`.trim(); kcalEl.textContent = `${Math.round(f.per.kcal * qty)} kcal`; };
    const bump = (d) => { qty = Math.max(step, Math.round((qty + d) * 100) / 100); paint(); };
    paint();
    return h('div', { class: 'fd-qty' },
      h('span', { class: 'grow' }, f.name),
      h('button', { class: 'fd-step', type: 'button', 'aria-label': 'Less', onclick: () => bump(-step) }, '−'),
      qtyEl,
      h('button', { class: 'fd-step', type: 'button', 'aria-label': 'More', onclick: () => bump(step) }, '+'),
      kcalEl,
      h('button', { class: 'btn primary', type: 'button', onclick: () => {
        const amount = f.unit ? `${qty} ${f.unit}` : (qty === 1 ? '' : `${qty}×`);
        const grams = f.unit === 'g' ? qty : f.unit === 'ml' ? qty : r1((f.per.grams || 0) * qty);
        const it = { name: f.name, amount, grams, src: 'library' };
        for (const k of MACROS) it[k] = k === 'kcal' ? Math.round(f.per[k] * qty) : r1(f.per[k] * qty);
        it.base = { grams: it.grams, kcal: it.kcal, protein: it.protein, carbs: it.carbs, fat: it.fat, amount };
        entry.items.push(it);
        if (!entry.name) { entry.name = f.name; nameInput.value = f.name; }
        paintItems();
        paintLib();
        toast(`Added ${f.name}`);
      } }, 'Add'));
  }
  const libDetails = h('details', { class: 'card fd-lib', open: !entry.items.length }, h('summary', {}, 'Past foods'), libSearch, libResults);
  paintLib();

  // --- usual meals ---

  const libMeta = (await getMeta('foodLibrary', null)) || {};
  if (!Array.isArray(libMeta.meals)) libMeta.meals = [];
  const mealsBox = h('div', { class: 'fd-meals' });
  const mealsCard = h('section', { class: 'card' }, h('h3', {}, 'Usual meals'), mealsBox);
  function paintMeals() {
    mealsCard.classList.toggle('hidden', !libMeta.meals.length);
    const meals = [...libMeta.meals].sort((a, b) => (b.uses || 0) - (a.uses || 0) || (b.lastUsed || 0) - (a.lastUsed || 0));
    mealsBox.replaceChildren(...meals.map((m) => {
      const t = sumItems(m.items || []);
      return h('div', { class: 'fd-meal' },
        h('button', { class: 'fd-hit grow', type: 'button', onclick: async () => {
          for (const src of m.items || []) {
            const it = normItem(structuredClone(src));
            it.src = 'library';
            ensureBase(it);
            entry.items.push(it);
          }
          if (!entry.name) { entry.name = m.name; nameInput.value = m.name; }
          m.uses = (m.uses || 0) + 1; m.lastUsed = Date.now();
          await setMeta('foodLibrary', libMeta);
          paintItems();
          toast(`Added ${m.name}`);
        } }, h('span', {}, m.name), h('small', {}, `${fmtNum(t.kcal, 0)} kcal · ${(m.items || []).length} items`)),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Delete usual meal', onclick: async () => {
          if (!(await confirmDialog(`Remove "${m.name}" from usual meals?`, 'Remove'))) return;
          libMeta.meals = libMeta.meals.filter((x) => x !== m);
          await setMeta('foodLibrary', libMeta);
          paintMeals();
        } }, '✕'));
    }));
  }
  paintMeals();

  async function saveAsMeal() {
    const items = entry.items.filter((i) => i.name).map(normItem);
    if (!items.length) { toast('Add items first'); return; }
    const inp = h('input', { type: 'text', value: entry.name || items.map((i) => i.name).join(', ').slice(0, 60), placeholder: 'Meal name' });
    const name = await modal('Save as usual meal', h('div', {}, h('p', { class: 'small muted' }, 'One tap adds all of these items next time.'), inp),
      [{ label: 'Cancel', value: null }, { label: 'Save', primary: true, onClick: () => inp.value.trim() || false }]);
    if (!name) return;
    const existing = libMeta.meals.find((m) => m.name.toLowerCase() === name.toLowerCase());
    if (existing) Object.assign(existing, { items, lastUsed: Date.now() });
    else libMeta.meals.push({ id: uid(), name, items, uses: 0, lastUsed: Date.now() });
    await setMeta('foodLibrary', libMeta);
    paintMeals();
    toast(`Saved "${name}"`);
  }
  const saveMealBtn = h('button', { class: 'btn', type: 'button', onclick: saveAsMeal }, '☆ Save as usual meal');

  // --- name / time / save ---

  const nameInput = h('input', { type: 'text', value: entry.name, placeholder: 'Meal name (optional)', oninput: (e) => { entry.name = e.target.value; } });
  const timeInput = h('input', { type: 'time', value: entry.time || '', onchange: (e) => { entry.time = e.target.value; } });

  async function save() {
    entry.items = entry.items.filter((i) => (i.name && i.name.trim()) || i.kcal || i.protein);
    if (!entry.items.length) { toast('Add at least one item'); return; }
    const t = sumItems(entry.items);
    Object.assign(entry, { kcal: Math.round(t.kcal), protein: r1(t.protein), carbs: r1(t.carbs), fat: r1(t.fat) });
    if (!entry.name) entry.name = entry.items.map((i) => i.name).filter(Boolean).join(', ').slice(0, 80);
    entry.source = deriveSource(entry);
    if (image && image.thumb) {
      if (entry.photoId) await db.del('photos', entry.photoId);
      entry.photoId = uid();
      await db.put('photos', { id: entry.photoId, blob: image.thumb });
    }
    entry.items = entry.items.map(normItem);
    if (!entry.createdAt) entry.createdAt = Date.now();
    entry.updatedAt = Date.now();
    try { await db.put('food', entry); } catch (e) { toast(`Save failed: ${e.message || e}`, 5000); return; }
    libCache = null;
    toast('Saved');
    location.hash = `#/food/${entry.date}`;
  }

  async function remove() {
    if (!(await confirmDialog('Delete this food entry?', 'Delete'))) return;
    await db.del('food', entry.id);
    if (entry.photoId) await db.del('photos', entry.photoId);
    libCache = null;
    location.hash = `#/food/${date}`;
  }

  const autoCamera = mode === 'photo' && navigator.userActivation?.isActive;
  root.replaceChildren(
    head(date, `#/food/${date}`, isNew ? 'Add food' : 'Edit food'),
    h('section', { class: 'card' },
      h('div', { class: 'fd-photo-row' },
        h('button', { class: 'btn primary big fd-camera', type: 'button', onclick: () => fileInput.click() }, '📷 Camera'),
        h('button', { class: 'btn', type: 'button', onclick: () => galleryInput.click() }, '🖼 Gallery'),
        h('button', { class: 'btn', type: 'button', onclick: scanBarcode }, '▤ Scan barcode'),
        fileInput, galleryInput),
      preview,
      describe,
      h('div', { class: 'fd-ai-row' }, aiBtn, countLine),
      status, qBox, noteBox),
    h('section', { class: 'card' },
      h('div', { class: 'fd-name-row' }, nameInput, timeInput),
      itemsBox,
      hiddenChips,
      h('div', { class: 'fd-item-actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => { entry.items.push({ name: '', amount: '', grams: 0, kcal: 0, protein: 0, carbs: 0, fat: 0, src: 'manual' }); paintItems(); } }, '+ Item'),
        saveMealBtn),
      totalsLine,
      h('div', { class: 'fd-save-row' },
        !isNew ? h('button', { class: 'btn danger', type: 'button', onclick: remove }, 'Delete') : null,
        h('button', { class: 'btn primary big grow', type: 'button', onclick: save }, 'Save'))),
    libDetails,
    mealsCard);
  paintItems();

  if (mode === 'photo') {
    if (autoCamera) { try { fileInput.click(); } catch {} }
    else status.textContent = 'Tap Camera to take the photo.';
  }
}

// ---------- item helpers ----------

function normItem(it) {
  const out = {
    name: String(it.name || ''), amount: String(it.amount || ''), grams: Number(it.grams) || 0,
    kcal: Number(it.kcal) || 0, protein: Number(it.protein) || 0, carbs: Number(it.carbs) || 0, fat: Number(it.fat) || 0,
  };
  if (it.src) out.src = it.src;
  if (it.base && typeof it.base === 'object') out.base = { ...it.base };
  return out;
}

const srcLabel = (s) => (s === 'ai' ? 'AI' : s === 'ai-edited' ? 'AI, edited' : s === 'library' ? 'past' : s === 'barcode' ? 'barcode' : '');

function deriveSource(entry) {
  const fallback = entry.source === 'import' ? 'import' : 'manual';
  const srcs = entry.items.map((i) => i.src || fallback);
  const set = new Set(srcs);
  // Imported rows carry src 'manual' from the converter; opening and saving one untouched keeps 'import'.
  if (entry.source === 'import' && [...set].every((s) => s === 'manual' || s === 'import')) return 'import';
  if (set.size === 1) return srcs[0];
  if (set.has('ai') || set.has('ai-edited')) return 'ai-edited';
  return 'manual';
}

function sumItems(items) {
  const t = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  for (const i of items) for (const k of MACROS) t[k] += Number(i[k]) || 0;
  return t;
}

const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

function sameName(a, b) {
  const x = normName(a), y = normName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return x.length >= 3 && y.length >= 3 && (x.includes(y) || y.includes(x));
}

// Does the correction text name this item? Any word of 3+ letters from the item name appearing in the text counts.
function namedIn(text, item) {
  const t = normName(text);
  if (!t) return false;
  return normName(item.name).split(' ').some((w) => w.length >= 3 && t.includes(w));
}

// Merge the model's corrected list into the current one: items the user edited keep their values unless
// the correction names them; untouched AI items take the new values; items the model dropped go away
// unless the user had edited them; new items are appended.
function mergeItems(cur, aiItems, text) {
  const used = new Set();
  const out = [];
  for (const c of cur) {
    // exact name first so "rice" cannot take the "rice cake" slot; substring match only as a fallback
    let idx = aiItems.findIndex((a, i) => !used.has(i) && normName(a.name) === normName(c.name));
    if (idx < 0) idx = aiItems.findIndex((a, i) => !used.has(i) && sameName(a.name, c.name));
    const userOwned = c.src !== 'ai'; // manual, library, barcode, ai-edited, or a legacy item with no src
    const keep = userOwned && !namedIn(text, c);
    if (idx >= 0) { used.add(idx); out.push(keep ? c : aiItems[idx]); }
    else if (keep) out.push(c);
  }
  aiItems.forEach((a, i) => { if (!used.has(i)) out.push(a); });
  return out;
}

// ---------- barcode ----------

function scanWithCamera() {
  let stream = null, timer = null, done = false, resolve;
  const p = new Promise((r) => { resolve = r; });
  const finish = (v) => {
    if (done) return;
    done = true;
    clearInterval(timer);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    wrap.remove();
    resolve(v);
  };
  const video = h('video', { class: 'fd-scan-video', autoplay: true, playsinline: true, muted: true });
  video.muted = true;
  const hint = h('div', { class: 'fd-scan-hint' }, 'Point the camera at the barcode');
  const wrap = h('div', { class: 'fd-scan-wrap' },
    h('div', { class: 'fd-scan' }, video, hint,
      h('div', { class: 'fd-scan-actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => finish(null) }, 'Type the code'),
        h('button', { class: 'btn', type: 'button', onclick: () => finish(undefined) }, 'Cancel'))));
  document.body.append(wrap);
  (async () => {
    try {
      const det = new BarcodeDetector();
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      if (done) { stream.getTracks().forEach((t) => t.stop()); return; }
      video.srcObject = stream;
      await video.play().catch(() => {});
      timer = setInterval(async () => {
        if (done || video.readyState < 2) return;
        try {
          const codes = await det.detect(video);
          const hit = codes.find((c) => c.rawValue);
          if (hit) finish(hit.rawValue.trim());
        } catch {}
      }, 350);
    } catch (e) {
      hint.textContent = 'Camera not available. Type the code instead.';
    }
  })();
  return p;
}

async function typeCode() {
  const inp = h('input', { type: 'text', inputmode: 'numeric', placeholder: 'Numbers under the barcode', autocomplete: 'off' });
  const v = await modal('Barcode number', h('div', {}, inp), [
    { label: 'Cancel', value: null },
    { label: 'Look up', primary: true, onClick: () => inp.value.replace(/\D/g, '') || false },
  ]);
  return v || null;
}

// Open Food Facts v3: per-100 g values → one item at the serving size (or 100 g) with a 100 g reference portion.
async function lookupBarcode(code) {
  const url = `https://world.openfoodfacts.org/api/v3/product/${encodeURIComponent(code)}.json?fields=product_name,brands,nutriments,serving_quantity,serving_size`;
  let res;
  try {
    res = await fetch(url, { headers: { 'X-User-Agent': 'Daybook/2 (personal app)' }, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    if (e && e.name === 'TimeoutError') throw new Error('Open Food Facts timed out. Try again.');
    // a CORS preflight refusal of the custom header surfaces as TypeError: retry without it
    try { res = await fetch(url, { signal: AbortSignal.timeout(20000) }); }
    catch { throw new Error('No connection to Open Food Facts. Type the item instead.'); }
  }
  const j = await res.json().catch(() => ({}));
  const p = j.product;
  if (res.status === 404 || !p || !p.nutriments) throw new Error(`Barcode ${code} is not in Open Food Facts. Type the item instead.`);
  const n = p.nutriments;
  const kj = Number(n.energy_100g) || Number(n['energy-kj_100g']) || 0;
  const per100 = {
    kcal: Number(n['energy-kcal_100g']) || (kj ? kj / 4.184 : 0),
    protein: Number(n.proteins_100g) || 0, carbs: Number(n.carbohydrates_100g) || 0, fat: Number(n.fat_100g) || 0,
  };
  if (!per100.kcal && !per100.protein && !per100.carbs && !per100.fat) throw new Error('Open Food Facts has no nutrition numbers for this product. Type it instead.');
  const serving = Number(p.serving_quantity);
  const grams = serving > 0 ? Math.round(serving) : 100;
  const brand = String(p.brands || '').split(',')[0].trim();
  const name = [brand, String(p.product_name || '').trim()].filter(Boolean).join(' ') || `Barcode ${code}`;
  const f = grams / 100;
  const base = { grams: 100, kcal: Math.round(per100.kcal), protein: r1(per100.protein), carbs: r1(per100.carbs), fat: r1(per100.fat), amount: '100 g' };
  return {
    name, amount: `${grams} g`, grams,
    kcal: Math.round(per100.kcal * f), protein: r1(per100.protein * f), carbs: r1(per100.carbs * f), fat: r1(per100.fat * f),
    src: 'barcode', base,
  };
}

// ---------- past-food library ----------

let libCache = null;

// "2 eggs" keeps the unit optional (\b stops "egg" + "s"); "2tomatoes" and "100g rice" need no space;
// word quantities need a boundary so "avocado" is not "a" + "vocado".
const QTY_RE = /^(\d+\s*\/\s*\d+|\d+(?:[.,]\d+)?|(?:half(?: an?)?|an?|one|two|three|four|five|six)\b)\s*(?:(cups?|slices?|sslices?|eggs?|pcs?|pieces?|grams?|g|ml|oz|tablespoons?|tbsp|tbsbp?|teaspoons?|tsp|x|cans?|bottles?|glass(?:es)?|bowls?|scoops?|servings?|cloves?|handfuls?)\b)?\s*(?:of\s+)?([a-z].*)$/i;
const WORDS = { half: 0.5, a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const UNITS = { cups: 'cup', slices: 'slice', sslice: 'slice', sslices: 'slice', eggs: 'egg', pcs: 'piece', pc: 'piece', pieces: 'piece', grams: 'g', gram: 'g', tablespoon: 'tbsp', tablespoons: 'tbsp', tbsb: 'tbsp', tbsbp: 'tbsp', teaspoon: 'tsp', teaspoons: 'tsp', glasses: 'glass', cans: 'can', bottles: 'bottle', bowls: 'bowl', scoops: 'scoop', servings: 'serving', cloves: 'clove', handfuls: 'handful', x: '' };

// "6 cups coffee" → {qty: 6, unit: 'cup', food: 'coffee'}; "ramen" → {qty: 1, unit: '', food: 'ramen'}
function parseQty(name) {
  const s = String(name || '').trim();
  const m = QTY_RE.exec(s);
  if (!m) return { qty: 1, unit: '', food: s };
  let q;
  const raw = m[1].toLowerCase().replace(',', '.');
  if (raw.includes('/')) { const [a, b] = raw.split('/').map((x) => Number(x.trim())); q = b ? a / b : NaN; }
  else if (raw in WORDS) q = WORDS[raw];
  else if (raw.startsWith('half')) q = 0.5;
  else q = Number(raw);
  if (!(q > 0)) return { qty: 1, unit: '', food: s };
  let unit = (m[2] || '').toLowerCase();
  unit = unit in UNITS ? UNITS[unit] : unit;
  return { qty: q, unit, food: m[3].trim() };
}

function singular(w) {
  if (w.length <= 3) return w;
  if (/ies$/.test(w)) return w.slice(0, -3) + 'y';
  if (/(oes|ches|shes|sses|xes)$/.test(w)) return w.slice(0, -2);
  if (/ss$/.test(w)) return w;
  if (/s$/.test(w)) return w.slice(0, -1);
  return w;
}
function foodKey(food) {
  const words = normName(food).split(' ').filter(Boolean);
  if (!words.length) return '';
  words[words.length - 1] = singular(words[words.length - 1]);
  return words.join(' ');
}

const median = (arr) => { const s = [...arr].sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };

// Every distinct food ever logged, keyed on the normalised food name + unit, with per-unit values
// (median of the last few occurrences), most-used first, ties by recency. Computed once per session.
async function foodLibrary() {
  if (libCache) return libCache;
  const all = await db.all('food');
  const map = new Map();
  for (const e of all.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))) {
    const rows = e.items && e.items.length ? e.items : [e];
    for (const r of rows) {
      const { qty, unit, food } = parseQty(r.name);
      const key = foodKey(food);
      if (!key) continue;
      const id = `${key}|${unit}`;
      let rec = map.get(id);
      if (!rec) { rec = { key, unit, name: food, qty, count: 0, last: 0, samples: { grams: [], kcal: [], protein: [], carbs: [], fat: [] } }; map.set(id, rec); }
      rec.count++;
      rec.last = e.createdAt || 0;
      rec.name = food;
      rec.qty = qty;
      const per = (v) => (Number(v) || 0) / qty;
      for (const k of ['grams', ...MACROS]) { rec.samples[k].push(per(r[k])); if (rec.samples[k].length > 5) rec.samples[k].shift(); }
    }
  }
  libCache = [...map.values()].map((rec) => {
    const per = {};
    for (const k of ['grams', ...MACROS]) per[k] = k === 'kcal' ? Math.round(median(rec.samples[k])) : r1(median(rec.samples[k]));
    return { key: rec.key, unit: rec.unit, name: rec.name, qty: rec.qty, count: rec.count, last: rec.last, per };
  }).sort((a, b) => b.count - a.count || b.last - a.last);
  return libCache;
}
