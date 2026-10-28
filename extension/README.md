# Glance New Tab

A small Chrome extension that makes Glance the new tab page and lets its search box use the browser history, like Chrome's address bar:

- New tabs go straight to Glance, without leaving the extension's page in the tab's back history
- Typing in the search box suggests matching pages you've visited (title, URL and favicon); Enter or a click opens them
- Typing the start of a site you've typed into the address bar before completes it inline (`you` → `youtube.com`), Enter opens it, Delete or Backspace removes the completion
- Shift+Delete or the ✕ on a suggested page removes it from the browser history

Glance only uses this when the extension is installed, everywhere else its search works as before. The history never leaves the browser: the extension answers lookups from the Glance page, nothing is sent to the Glance server.

## Install

1. Open `chrome://extensions` and turn on Developer mode
2. Click "Load unpacked" and pick this folder
3. Remove or disable other new tab extensions
4. Open a new tab; if Chrome asks whether to keep the changed new tab page, keep it

After changing files here, click the reload button on the extension's card.

## Glance's address

It's `https://glance/` in two places, change both if it moves: `GLANCE_URL` in `newtab.js`, and the `matches` in `manifest.json`.
