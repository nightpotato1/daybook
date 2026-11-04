import { h, $ } from './util.js';
import { renderToday } from './today.js';
import { renderFood } from './food.js';
import { renderTrends } from './trends.js';
import { renderInsights } from './insights.js';
import { renderSettings } from './settings.js';
import { handleRedirect } from './health.js';
import { requestPersist } from './db.js';

const NAV = [
  ['today', 'Today', '◉'],
  ['food', 'Food', '🍽'],
  ['trends', 'Trends', '📈'],
  ['insights', 'Insights', '⚯'],
  ['settings', 'Settings', '⚙'],
];

async function route() {
  const [, page = 'today', a, b, c] = (location.hash || '#/today').split('/');
  const root = $('#view');
  document.querySelectorAll('nav a').forEach((el) => el.classList.toggle('on', el.dataset.page === page));
  try {
    if (page === 'today') await renderToday(root, a);
    else if (page === 'food') await renderFood(root, a || (await todayDate()), b, c);
    else if (page === 'trends') await renderTrends(root, a);
    else if (page === 'insights') await renderInsights(root, a);
    else if (page === 'settings') await renderSettings(root);
    else location.hash = '#/today';
  } catch (e) {
    console.error(e);
    root.replaceChildren(h('section', { class: 'card' }, h('h3', {}, 'Something broke'), h('pre', { class: 'small' }, String(e.stack || e))));
  }
  if (!b) window.scrollTo(0, 0);
}

async function todayDate() {
  const { loadSettings } = await import('./metrics.js');
  const { logicalToday } = await import('./util.js');
  return logicalToday((await loadSettings()).dayStartHour);
}

function shell() {
  document.body.append(
    h('main', { id: 'view' }),
    h('nav', {}, NAV.map(([id, label, icon]) => h('a', { href: `#/${id}`, 'data-page': id }, h('span', { class: 'nav-i' }, icon), h('span', {}, label)))));
}

shell();
window.addEventListener('hashchange', route);
handleRedirect().catch((e) => console.error(e)).finally(route);
requestPersist();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW', e));
}
