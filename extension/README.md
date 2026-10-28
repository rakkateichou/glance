# Glance New Tab

A small Chrome extension that makes Glance the new tab page and syncs the browser history to it, so Glance's search box works like Chrome's address bar on every device:

- New tabs go straight to Glance, without leaving the extension's page in the tab's back history
- The browser history is uploaded to Glance (all of it the first time, then new visits within a minute), from every browser the extension is installed in, and deletions are synced too
- Typing in the search box suggests matching visited pages from all devices (favicon, title, URL); Enter or a click opens them
- Typing the start of a site you've typed into an address bar before completes it inline (`you` → `youtube.com`), Enter opens it, Delete or Backspace removes the completion
- Shift+Delete or the ✕ on a suggested page removes it from Glance and from this browser's history

Devices without the extension (another browser, a phone) still get the suggestions, just without uploading their own history.

The history is stored on the Glance server in `data/browser_history.json`, and anyone who can open Glance can search it, so set up Glance's authentication if it's reachable by others.

## Setup

Turn the suggestions on in the search widget's config:

```yaml
- type: search
  browser-history: true
```

Then in Chrome:

1. Open `chrome://extensions` and turn on Developer mode
2. Click "Load unpacked" and pick this folder
3. Remove or disable other new tab extensions
4. Open a new tab; if Chrome asks whether to keep the changed new tab page, keep it

After changing files here, click the reload button on the extension's card.

## Glance's address

It's `https://glance/` in two places, change both if it moves: `config.js`, and the `matches` and `host_permissions` in `manifest.json`.
