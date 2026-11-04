// Food log: per-day list, plus one editor used for manual entry, past-food quick add and AI review.
import { h, prettyDate, fmtNum, uid, toast, prepareImage, confirmDialog } from './util.js';
import { db } from './db.js';
import { loadSettings } from './metrics.js';
import { foodTotals } from './data.js';
import { estimateFood, aiReady } from './ai.js';

export async function renderFood(root, date, mode, id) {
  if (mode === 'edit' && id) return editor(root, date, await db.get('food', id));
  if (mode === 'add' || mode === 'photo') return editor(root, date, null, mode);
  return dayList(root, date);
}

async function dayList(root, date) {
  const entries = (await db.byIndex('food', 'date', date)).sort((a, b) => (a.time || '').localeCompare(b.time || '') || a.createdAt - b.createdAt);
  const t = foodTotals(entries);
  const settings = await loadSettings();
  const thumbs = await Promise.all(entries.map((e) => (e.photoId ? db.get('photos', e.photoId) : null)));

  root.replaceChildren(
    h('header', { class: 'day-head' },
      h('a', { class: 'icon-btn', href: `#/today/${date}`, 'aria-label': 'Back' }, '‹'),
      h('div', { class: 'day-title' }, h('h2', {}, 'Food'), h('small', {}, prettyDate(date))),
      h('span')),
    h('section', { class: 'card totals' },
      totalBox('kcal', t.kcal, settings.kcalGoal),
      totalBox('protein g', t.protein, settings.proteinGoal),
      totalBox('carbs g', t.carbs), totalBox('fat g', t.fat)),
    h('div', { class: 'food-actions' },
      h('a', { class: 'btn primary', href: `#/food/${date}/photo` }, '📷 Photo'),
      h('a', { class: 'btn', href: `#/food/${date}/add` }, '+ Add / describe')),
    entries.length ? h('section', { class: 'card list' }, entries.map((e, i) =>
      h('a', { class: 'food-item', href: `#/food/${date}/edit/${e.id}` },
        thumbs[i] ? h('img', { src: URL.createObjectURL(thumbs[i].blob), alt: '' }) : h('div', { class: 'thumb-ph' }, sourceIcon(e.source)),
        h('div', { class: 'fi-main' }, h('div', {}, e.name), h('small', {}, [e.time, e.items?.length > 1 ? `${e.items.length} items` : null].filter(Boolean).join(' · '))),
        h('div', { class: 'fi-num' }, h('b', {}, fmtNum(e.kcal, 0)), h('small', {}, ` kcal · ${fmtNum(e.protein, 0)}g p`)))))
      : h('p', { class: 'empty' }, 'Nothing logged yet.'));
}

const sourceIcon = (s) => (s === 'ai' ? '✨' : s === 'library' ? '↺' : '✎');

function totalBox(label, v, goal) {
  return h('div', { class: 'total' }, h('b', {}, fmtNum(v, 0)), h('small', {}, label), goal ? h('small', { class: 'goal' }, `of ${goal}`) : null);
}

// ---------- editor ----------

async function editor(root, date, entry, mode) {
  const settings = await loadSettings();
  const isNew = !entry;
  const now = new Date();
  entry = entry ? structuredClone(entry) : {
    id: uid(), date, time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    name: '', items: [], source: 'manual', createdAt: Date.now(),
  };
  if (!entry.items || !entry.items.length) entry.items = isNew ? [] : [{ name: entry.name, amount: '', kcal: entry.kcal, protein: entry.protein, carbs: entry.carbs || 0, fat: entry.fat || 0 }];
  let image = null;      // {base64, mime, thumb} of the photo taken in this session
  let lastAI = null;     // last AI result, sent back with corrections

  const itemsBox = h('div', { class: 'items' });
  const totalsLine = h('div', { class: 'items-total' });
  const status = h('div', { class: 'ai-status' });
  const preview = h('div', { class: 'photo-preview' });
  if (entry.photoId) db.get('photos', entry.photoId).then((p) => { if (p) preview.replaceChildren(h('img', { src: URL.createObjectURL(p.blob), alt: '' })); });

  function paintItems() {
    itemsBox.replaceChildren(...entry.items.map((it, idx) => itemRow(it, idx)));
    paintTotals();
  }

  function itemRow(it, idx) {
    const field = (key, attrs) => h('input', { ...attrs, value: it[key] ?? '', oninput: (e) => {
      it[key] = attrs.type === 'number' ? (e.target.value === '' ? 0 : Number(e.target.value)) : e.target.value;
      if (attrs.type === 'number') paintTotals();
    } });
    return h('div', { class: 'item' },
      h('div', { class: 'item-top' },
        field('name', { type: 'text', placeholder: 'Food', class: 'grow' }),
        h('button', { class: 'icon-btn', 'aria-label': 'Remove item', onclick: () => { entry.items.splice(idx, 1); paintItems(); } }, '✕')),
      h('div', { class: 'item-nums' },
        h('label', {}, 'amount', field('amount', { type: 'text', placeholder: '1 cup' })),
        h('label', {}, 'kcal', field('kcal', { type: 'number', inputmode: 'decimal' })),
        h('label', {}, 'protein', field('protein', { type: 'number', inputmode: 'decimal' })),
        h('label', {}, 'carbs', field('carbs', { type: 'number', inputmode: 'decimal' })),
        h('label', {}, 'fat', field('fat', { type: 'number', inputmode: 'decimal' }))));
  }
  function paintTotals() {
    const t = sumItems(entry.items);
    totalsLine.replaceChildren(h('b', {}, `${fmtNum(t.kcal, 0)} kcal`), ` · ${fmtNum(t.protein, 0)}g protein · ${fmtNum(t.carbs, 0)}g carbs · ${fmtNum(t.fat, 0)}g fat`);
  }

  // --- AI ---
  const describe = h('textarea', { rows: 2, placeholder: 'Describe it, or correct the estimate: "2 eggs not 3, cooked in butter, big mug of chai with sugar"' });
  async function runAI() {
    if (!aiReady(settings)) { status.replaceChildren('AI is off. Add a free Gemini key in Settings → AI, or type the numbers yourself.'); return; }
    if (!image && !describe.value.trim()) { status.textContent = 'Take a photo or describe the food first.'; return; }
    status.replaceChildren(h('span', { class: 'spinner' }), ' Estimating…');
    aiBtn.disabled = true;
    try {
      const r = await estimateFood({ image, text: describe.value.trim(), previous: lastAI }, settings);
      lastAI = r;
      entry.items = r.items;
      entry.source = 'ai';
      if (!entry.name || entry.name === entry._aiName) { entry.name = r.meal; entry._aiName = r.meal; nameInput.value = r.meal; }
      entry.aiNotes = r.notes;
      status.replaceChildren(r.notes ? `Note: ${r.notes}` : 'Check the items below and fix anything that is off.');
      describe.value = '';
      describe.placeholder = 'Wrong? Say what to fix and press Re-estimate';
      aiBtn.textContent = '✨ Re-estimate';
      paintItems();
    } catch (e) {
      status.textContent = `AI failed: ${e.message}`;
    } finally { aiBtn.disabled = false; }
  }
  const aiBtn = h('button', { class: 'btn primary', onclick: runAI }, '✨ Estimate');

  async function onPhoto(e) {
    const f = e.target.files[0];
    if (!f) return;
    image = await prepareImage(f);
    preview.replaceChildren(h('img', { src: URL.createObjectURL(image.thumb), alt: 'Meal photo' }));
    runAI();
  }
  const fileInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'hidden', onchange: onPhoto });
  const galleryInput = h('input', { type: 'file', accept: 'image/*', class: 'hidden', onchange: onPhoto });

  // --- past foods ---
  const lib = await foodLibrary();
  const libResults = h('div', { class: 'lib-results' });
  const libSearch = h('input', { type: 'search', placeholder: 'Search foods you have logged before', oninput: () => {
    const q = libSearch.value.trim().toLowerCase();
    const hits = (q ? lib.filter((f) => f.key.includes(q)) : lib).slice(0, q ? 12 : 8);
    libResults.replaceChildren(...hits.map((f) => h('button', { class: 'lib-hit', onclick: () => {
      entry.items.push({ name: f.name, amount: '', kcal: f.kcal, protein: f.protein, carbs: f.carbs, fat: f.fat });
      if (!entry.name) { entry.name = f.name; nameInput.value = f.name; }
      if (entry.source === 'manual') entry.source = 'library';
      paintItems();
      toast(`Added ${f.name}`);
    } }, h('span', {}, f.name), h('small', {}, `${fmtNum(f.kcal, 0)} kcal · ${fmtNum(f.protein, 0)}p · ×${f.count}`))));
  } });
  libSearch.dispatchEvent(new Event('input'));

  const nameInput = h('input', { type: 'text', value: entry.name, placeholder: 'Meal name (optional)', oninput: (e) => { entry.name = e.target.value; } });
  const timeInput = h('input', { type: 'time', value: entry.time || '', onchange: (e) => { entry.time = e.target.value; } });

  async function save() {
    entry.items = entry.items.filter((i) => i.name || i.kcal || i.protein);
    if (!entry.items.length) { toast('Add at least one item'); return; }
    const t = sumItems(entry.items);
    Object.assign(entry, { kcal: Math.round(t.kcal), protein: r1(t.protein), carbs: r1(t.carbs), fat: r1(t.fat) });
    if (!entry.name) entry.name = entry.items.map((i) => i.name).join(', ').slice(0, 80);
    if (image) {
      if (entry.photoId) await db.del('photos', entry.photoId);
      entry.photoId = uid();
      await db.put('photos', { id: entry.photoId, blob: image.thumb });
    }
    delete entry._aiName;
    entry.updatedAt = Date.now();
    await db.put('food', entry);
    toast('Saved');
    location.hash = `#/food/${date}`;
  }

  async function remove() {
    if (!(await confirmDialog('Delete this food entry?', 'Delete'))) return;
    await db.del('food', entry.id);
    if (entry.photoId) await db.del('photos', entry.photoId);
    location.hash = `#/food/${date}`;
  }

  paintItems();
  root.replaceChildren(
    h('header', { class: 'day-head' },
      h('a', { class: 'icon-btn', href: `#/food/${date}`, 'aria-label': 'Back' }, '‹'),
      h('div', { class: 'day-title' }, h('h2', {}, isNew ? 'Add food' : 'Edit food'), h('small', {}, prettyDate(date))),
      h('span')),
    h('section', { class: 'card' },
      h('div', { class: 'photo-row' },
        h('button', { class: 'btn primary big', onclick: () => fileInput.click() }, '📷 Camera'),
        h('button', { class: 'btn', onclick: () => galleryInput.click() }, '🖼 Gallery'),
        fileInput, galleryInput),
      preview,
      describe,
      h('div', { class: 'row' }, aiBtn),
      status),
    h('section', { class: 'card' },
      h('h3', {}, 'Past foods'),
      libSearch, libResults),
    h('section', { class: 'card' },
      h('div', { class: 'row' }, nameInput, timeInput),
      itemsBox,
      h('button', { class: 'btn', onclick: () => { entry.items.push({ name: '', amount: '', kcal: 0, protein: 0, carbs: 0, fat: 0 }); paintItems(); } }, '+ Item'),
      totalsLine),
    h('div', { class: 'row end' },
      !isNew ? h('button', { class: 'btn danger', onclick: remove }, 'Delete') : null,
      h('button', { class: 'btn primary', onclick: save }, 'Save')));

  if (mode === 'photo') setTimeout(() => { try { fileInput.click(); } catch {} }, 50);
}

const r1 = (x) => Math.round(x * 10) / 10;

function sumItems(items) {
  const t = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  for (const i of items) for (const k of Object.keys(t)) t[k] += Number(i[k]) || 0;
  return t;
}

// Every distinct food name ever logged, most-used first, with its most recent numbers.
async function foodLibrary() {
  const all = await db.all('food');
  const map = new Map();
  for (const e of all.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))) {
    const rows = e.items && e.items.length > 1 ? [...e.items, e] : [e];
    for (const r of rows) {
      const name = (r.name || '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const prev = map.get(key);
      map.set(key, { key, name, kcal: Number(r.kcal) || 0, protein: Number(r.protein) || 0, carbs: Number(r.carbs) || 0, fat: Number(r.fat) || 0, count: (prev?.count || 0) + 1 });
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}
