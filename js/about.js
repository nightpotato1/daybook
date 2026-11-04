// "How this works": where the data lives, what leaves the phone, install, import, reminders, Fitbit.
import { h } from './util.js';

function isStandalone() {
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
}

function browserName() {
  const brands = navigator.userAgentData && navigator.userAgentData.brands;
  if (brands && brands.length) {
    const real = brands.find((b) => !/not.?a.?brand|chromium/i.test(b.brand));
    if (real) return real.brand;
  }
  const ua = navigator.userAgent || '';
  if (/SamsungBrowser/i.test(ua)) return 'Samsung Internet';
  if (/Firefox\//i.test(ua)) return 'Firefox';
  if (/EdgA?\//i.test(ua)) return 'Edge';
  if (/Chrome\//i.test(ua)) return 'Chrome';
  if (/Safari\//i.test(ua)) return 'Safari';
  return 'this browser';
}

const section = (title, ...body) => h('section', { class: 'card sh-about' }, h('h3', {}, title), ...body);
const p = (...kids) => h('p', {}, ...kids);
const ol = (...items) => h('ol', { class: 'sh-steps' }, items.map((i) => h('li', {}, i)));
const ul = (...items) => h('ul', { class: 'sh-list' }, items.map((i) => h('li', {}, i)));

export async function renderAbout(root) {
  const standalone = isStandalone();
  let persisted = null;
  if (navigator.storage && navigator.storage.persisted) {
    try { persisted = await navigator.storage.persisted(); } catch { persisted = null; }
  }

  root.replaceChildren(
    h('h2', { class: 'page-title' }, 'How this works'),

    section('Where your data lives',
      p('Everything you type is saved inside this phone, in the browser’s own storage (IndexedDB). There is no account, no login and no server. Nothing is uploaded unless you press Estimate on a food photo or connect Google Health.'),
      p(h('b', {}, 'Right now: '), `held by ${browserName()}, ${standalone ? 'running as the installed app' : 'running in a browser tab'}, protected from automatic clearing: ${persisted == null ? 'unknown' : persisted ? 'yes' : 'no'}.`),
      p('Each browser keeps its own copy. If you open the link in Samsung Internet and in Chrome you will have two different, unconnected logs. Pick one (Chrome) and install it.')),

    section('The address carries nothing',
      p('The web address is just the app’s files, the same for everyone. Your entries are not in the link, not on GitHub and not readable through the address.'),
      p('Anyone else who opens the link gets their own empty copy. They cannot see your log and cannot add to it. The copy on your PC is separate in exactly the same way: it starts empty and stays empty until you import a backup there.')),

    section('What erases it',
      ul(
        'Chrome → Settings → Site settings → Storage → clear this site, or "Clear browsing data" with site data ticked.',
        'Uninstalling the app from the home screen can clear its storage too.',
        'Chrome may free space from sites it considers unimportant when the phone is nearly full. Installing the app and granting persistent storage stops that; it does not stop the two cases above.',
        'A lost or reset phone.'),
      p('The only protection against all four is a backup file somewhere else.')),

    section('Backups and restoring',
      p('Settings → Your data → Back up makes one JSON file with every day, every food entry, the meal photos (small), your field list and your goals. Keys are left out. Send it to Google Drive from the share sheet, or keep it in Downloads and copy it to the PC now and then.'),
      p('The banner at the top appears when the last backup is more than a week old or 30 new records have piled up. One tap makes a fresh file.'),
      p(h('b', {}, 'To restore: '), 'open the file on the phone (Drive, USB, or Downloads), then Settings → Your data → Import file. Days in the file are merged with what is on the phone; the file wins for the same date. Nothing is deleted by an import.'),
      p('Daily CSV and Food CSV exports are for spreadsheets. Only the JSON file is a full backup.')),

    section('What leaves the phone',
      ul(
        h('span', {}, h('b', {}, 'Food photos and food text: '), 'sent to the AI provider you chose in Settings (free Gemini by default, Claude optionally), only when you press Estimate. Mood, habits, gratitude and journal text are never sent to an AI.'),
        h('span', {}, h('b', {}, 'Google Health (Fitbit): '), 'only if you connect it. The app then reads steps, sleep and resting heart rate from Google; it sends nothing of yours to Google.'),
        h('span', {}, h('b', {}, 'Barcode lookups: '), 'the barcode number goes to Open Food Facts, nothing else.'),
        h('span', {}, h('b', {}, 'Nothing else. '), 'No analytics, no crash reports, no third-party scripts.'))),

    section('Install on Android (Chrome)',
      ol(
        'Open this address in Chrome (not Samsung Internet).',
        'Tap the ⋮ menu → "Add to Home screen" → Install. If the app shows an Install button on first open, that does the same.',
        'Open Daybook from the home-screen icon from now on. It works offline.'),
      p('Installing keeps everything in Chrome’s storage, so you have exactly one copy of your data.')),

    section('Importing your history',
      p('The converted spreadsheet (a JSON file made on the PC) is imported the same way as a backup:'),
      ol(
        'Get the file onto the phone: share it to Google Drive, or copy it over USB into Downloads.',
        'Settings → Your data → Import file → pick it.',
        'Check a few past days under Today (‹ or the date picker) and the Notes tab.',
        'Delete the file from the phone afterwards. The PC copy stays as your baseline backup.'),
      p('The import brings your own field list and tiers with it. Metrics you have since turned off stay off.')),

    section('Reminders',
      p('A web app cannot ring an alarm on its own, so the reminder lives in your calendar. Settings → Reminders picks a time and makes a daily calendar event with a link straight into Today; one tap adds it to Google Calendar. Samsung Clock works too: add a daily alarm named Daybook.')),

    section('Fitbit: check these first',
      p('Fitbit data reaches the app through Google’s Health API, which needs a one-time setup on the PC. Before starting that, three things must be true, or nothing will arrive:'),
      ol(
        h('span', {}, h('b', {}, 'Supported tracker. '), 'Zip, One, Flex, Charge, Charge HR, Surge and Ace are not visible to the API at all. Resting heart rate needs Alta HR, Charge 2 or newer, or Inspire HR or newer.'),
        h('span', {}, h('b', {}, 'Account moved to Google before 2026-05-19. '), 'Fitbit accounts that were never migrated stopped working then and their history was deleted from 2026-07-15. If yours was never moved, the old data is gone: pair the tracker fresh and only new data will exist.'),
        h('span', {}, h('b', {}, 'It syncs. '), 'Charge the tracker, open the Google Health app (the old Fitbit app) signed in with that Google account, and watch a sync finish. If the app does not show today’s steps, the API will not either.')),
      p('If all three hold, the setup guide (about six steps on console.cloud.google.com, then two values pasted into Settings → Fitbit) lives on the PC in the project folder, not in this app. Old history can alternatively come from a Google Takeout export converted on the PC.')),

    section('Zero means zero, blank means not asked',
      p('A day counts as checked in once any of mood, energy, anxiety or sleep quality has a value. On a checked-in day, every habit chip you did not tap counts as 0 in charts, insights and the CSV. On a day you never checked in, everything stays blank and is left out. Nothing is written for you; the zeros are worked out when you look.')),

    h('p', { class: 'small muted center' }, 'Daybook keeps no account, no server and no copy of anything.'));
}
