# Chrome Precision redesign

The browser frame was rebuilt to feel like Chrome while keeping Private Browser's
own shield, teal palette and security model.

**Why.** The old shell spent a 39 px row on a title and a "Local protection
active" label, kept a 366 px sidebar open with a vertical rail, used a large
Account Space pill, and sent the three-dot button straight to Settings. The page
rectangle was written three times (App.tsx `setLayout`, the `main.ts` default and
fixed CSS offsets) with nothing tying them together, and bookmark folder menus
opened underneath the native page view.

**What changed.**

- One 40 px tab strip holds the shield, tabs, new-tab and tab-search buttons and
  the native Windows caption buttons (title-bar overlay, so Snap Layouts stay).
- Geometry moved into `electron/chrome-layout.ts`, imported by both processes;
  CSS reads it through custom properties and the old 158/128/366 literals are
  gone. A real-Electron test compares the view's bounds with the DOM.
- Shortcuts moved into `electron/shortcuts.ts`; page focus forwards resolved
  commands on `browser:command`, so a shortcut can no longer work in only half
  the window.
- Menus that overlap the page freeze it into a still image first
  (`browser:freeze-content`), never for protected pages.
- The sidebar became a closed-by-default, resizable (320–520 px) side panel with
  compact tool tabs; its state, the theme, the bookmarks bar mode and the New Tab
  background persist in the manifest `ui` block.
- Added a real browser menu, profile menu with workspace switching, protection
  and site-information popups, find bar, zoom, print, reopen closed tab, tab
  reordering and muting, bookmark folder menus with overflow, context actions and
  export, Bookmarks and History panels, customisable New Tab shortcuts, and light
  and dark themes.
- `App.tsx` was split into `src/shell/` (chrome) and `src/panels/` (the existing
  panels, moved unchanged apart from the Settings appearance controls).

Deliberately omitted actions are listed under "Browser chrome" in
[../follow-ups.md](../follow-ups.md).
