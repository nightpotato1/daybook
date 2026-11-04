// Notes: every day that has a title, a gratitude line or a journal entry, newest first, searchable.
import { h, prettyDate, validYmd } from './util.js';
import { db } from './db.js';

function hasText(d) {
  return !!((d.title && d.title.trim()) || (d.gratitude && d.gratitude.trim()) || (d.note && d.note.trim()));
}

function matches(d, q) {
  if (!q) return true;
  return [d.title, d.gratitude, d.note].some((t) => t && t.toLowerCase().includes(q));
}

function noteRow(d) {
  return h('a', { class: 'sh-note', href: `#/today/${d.date}` },
    h('div', { class: 'sh-note-date' }, prettyDate(d.date, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })),
    d.title && d.title.trim() ? h('div', { class: 'sh-note-title' }, d.title.trim()) : null,
    d.gratitude && d.gratitude.trim() ? h('p', { class: 'sh-note-text' }, h('span', { class: 'sh-note-kind' }, 'Grateful for '), d.gratitude.trim()) : null,
    d.note && d.note.trim() ? h('p', { class: 'sh-note-text' }, d.note.trim()) : null);
}

export async function renderNotes(root) {
  // validYmd drops v1-era garbage keys ('foo', '2025-13-45') that would list as "Invalid Date"
  const all = (await db.all('days')).filter((d) => validYmd(d.date) && hasText(d)).sort((a, b) => b.date.localeCompare(a.date));
  const list = h('div', { class: 'sh-notes' });
  const count = h('span', { class: 'small muted' });
  let q = '';

  const draw = () => {
    const rows = all.filter((d) => matches(d, q));
    count.textContent = q ? `${rows.length} of ${all.length} days` : `${all.length} days with notes`;
    if (!all.length) {
      list.replaceChildren(h('p', { class: 'empty' }, 'Nothing written yet. Titles, gratitude lines and journal entries from Today show up here.'));
    } else if (!rows.length) {
      list.replaceChildren(h('p', { class: 'empty' }, 'No notes match that.'));
    } else {
      list.replaceChildren(...rows.map(noteRow));
    }
  };

  let timer;
  const search = h('input', {
    type: 'search', class: 'sh-notes-search', placeholder: 'Search titles, gratitude and journal', 'aria-label': 'Search notes', autocomplete: 'off',
    oninput: (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => { q = e.target.value.trim().toLowerCase(); draw(); }, 150);
    },
  });

  draw();
  root.replaceChildren(
    h('div', { class: 'sh-notes-head' }, h('h2', { class: 'page-title' }, 'Notes'), count),
    search,
    list);
}
