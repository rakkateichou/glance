# Glance (Fork)

This is a fork of [glanceapp/glance](https://github.com/glanceapp/glance) with the following custom modifications:

## Changes

### To-do Widget
- **Remote Synchronization:** Added support for a `remote` configuration field to synchronize to-do lists via WebSocket.
- **Smooth Updates:** Replaced the full-widget re-rendering logic with a reconciliation system that provides smooth, real-time animations for incoming updates (adds, deletes, and checkmark toggles).
- **Two-way Sync:** Local changes are automatically broadcasted to the connected WebSocket server.

## Configuration Example

To enable remote synchronization for the to-do widget, add the `remote` field to your `glance.yml`:

```yaml
- type: to-do
  id: my-shared-tasks
  remote: wss://your-glance-server/ws
```
