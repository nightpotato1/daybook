# Daybook

A private daily tracker that runs entirely in the browser on your phone. It covers mood, habits, sleep, food (with optional photo AI), journal entries, trends and correlations, and exports to CSV. All data stays in the phone's local storage, and the repo contains no data or keys.

Live: https://nightpotato1.github.io/daybook/

## Where the data lives

Everything you type is saved in this phone's browser storage only. The web address is just the app: no account, no server. Anyone else opening the link gets their own empty copy and cannot see or change yours; the copy on a PC is separate too. Each browser keeps its own copy (Samsung Internet and Chrome would hold two different logs), so open it in Chrome and install it (menu → Add to Home screen). Clearing Chrome's site data or uninstalling erases it, so back up from Settings now and then. Only a food photo (and the food text with it) ever leaves the phone, and only when you press Estimate.

## Importing your history

The converted spreadsheet (a JSON file made on the PC) is imported the same way as a backup:

1. Get the file onto the phone: share it to Google Drive, or copy it over USB into Downloads.
2. Settings → Your data → Import file → pick it.
3. Check a few past days under Today (‹ or the date picker) and the Notes tab.
4. Delete the file from the phone afterwards. The PC copy stays as your baseline backup.
