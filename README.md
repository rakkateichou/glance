# Glance (Fork)

This is a fork of [glanceapp/glance](https://github.com/glanceapp/glance) with the following custom modifications:

## Changes

### To-do Widget
- **Automatic Internal Synchronization:** Built-in WebSocket synchronization that works out of the box.
- **Smooth Updates:** Replaced the full-widget re-rendering logic with a reconciliation system that provides smooth, real-time animations for incoming updates (adds, deletes, and checkmark toggles).
- **Two-way Sync:** Local changes are automatically broadcasted and persisted on the server.

### Counters Widget
- **List of Counters:** Allows tracking multiple units (e.g., university lectures) with simple +/- buttons.
- **Automatic Internal Synchronization:** Built-in WebSocket synchronization just like the To-do widget.
- **Persistence:** Counter values are stored in the browser's local storage and automatically synced across devices.

### Search Widget
- **Direct URL Opening:** Added an `open-direct-url` flag that allows you to type a URL (like `google.com` or `https://ai.dev`) directly into the search box and open it instead of performing a web search.
- **Google Autocomplete:** Added support for real-time Google search suggestions. Can be enabled via the `google-autocomplete: true` flag in the widget configuration.
- **Customizable Limit:** Added `google-autocomplete-limit: <number>` to control how many suggestions are shown (removes scrolling).
- **Search History:** Synced search history that appears at the top of suggestions with a distinct dashed underline. Can be enabled via the `search-history: true` flag.
- **Keyboard Navigation:** Support for Arrow keys (or Ctrl+j/k) to navigate suggestions and Enter to search.
- **Improved Autofocus:** Rewrote the autofocus logic to be robust against dynamic page loads and transitions, ensuring the search bar is focused reliably.

### Performance
- **Server-Side Rendering (SSR):** Implemented initial page rendering on the server. This eliminates the "empty shell" loading state and secondary network fetch, making page loads feel instantaneous (ideal for New Tab use).
- **PWA / Offline Support:** Added a Service Worker (`sw.js`) that caches all UI assets (CSS, JS, manifest). This allows Glance to load from the local disk instead of the network, achieving "extension-level" startup speeds.

## Configuration Examples

### To-do Widget
```yaml
- type: to-do
  id: my-shared-tasks
```

### Counters Widget
```yaml
- type: counters
  labels:
    - Unit 1
    - Unit 2
    - Unit 3
```

### Search Widget
```yaml
- type: search
  search-engine: google
  open-direct-url: true
  google-autocomplete: true
  google-autocomplete-limit: 5
  search-history: true
```

## Data Persistence

To ensure your to-do lists and counters are saved when running via Docker, you must mount a volume for the `/app/data` directory:

```yaml
services:
  glance:
    # ... other config ...
    volumes:
      - ./config:/app/config
      - ./data:/app/data  # This ensures your sync data is persisted
```
