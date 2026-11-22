# Keyboard smoke checks

Create a JSON fixture under `private-browser-fixtures/` in the approved local
VS Code project. Use a synthetic page with a predictable keyboard flow.

```json
{
  "version": 1,
  "responses": [],
  "smoke": {
    "repeats": 3,
    "budgetMs": 1200,
    "steps": [
      { "key": "Tab", "expect": { "role": "button", "name": "Open details", "state": "focused" } },
      { "key": "Enter", "expect": { "role": "heading", "name": "Details", "state": "visible" } }
    ]
  }
}
```

In the browser's Developer panel, open **Test**, enter the exact loopback
route, select your fixture and choose the viewports. **Run keyboard smoke
check** appears for fixtures with valid steps. Use 2–5 repeats and 1–16 steps.
The per-repeat budget, from the first key to the final assertion, accepts
100–10,000 ms. Tabs, arrows, Enter, Space and Escape are supported.

The report lists the repeat and step number if focus or visibility fails. It
records the median and 90th percentile time from a key press to the expected
state. All sizes are marked as simulations. Gather real-device evidence for
behavior that depends on a device's keyboard, touch or hardware.

The smoke runner opens a fresh Chromium context. It stays on the reviewed
loopback route, allows same-origin reads, and blocks writes and WebSockets.
Changing the fixture changes its digest and calls for a fresh review. Reruns
use the saved project, route, viewports and digest.
