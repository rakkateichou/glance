# Glance (Fork)

This is a fork of [glanceapp/glance](https://github.com/glanceapp/glance) with the following custom modifications:

## Changes

### To-do Widget
- **Remote Synchronization:** Added support for a `remote` configuration field to synchronize to-do lists via WebSocket.
- **Smooth Updates:** Replaced the full-widget re-rendering logic with a reconciliation system that provides smooth, real-time animations for incoming updates (adds, deletes, and checkmark toggles).
- **Two-way Sync:** Local changes are automatically broadcasted to the connected WebSocket server.

### Counters Widget
- **List of Counters:** Allows tracking multiple units (e.g., university lectures) with simple +/- buttons.
- **Remote Synchronization:** Supports the same `remote` WebSocket synchronization as the To-do widget.
- **Persistence:** Counter values are stored in the browser's local storage and synced across devices.

## Configuration Examples

### To-do Widget
```yaml
- type: to-do
  id: my-shared-tasks
  remote: wss://your-glance-server/ws
```

### Counters Widget
```yaml
- type: counters
  labels:
    - Unit 1
    - Unit 2
    - Unit 3
  remote: wss://your-glance-server/ws
```
