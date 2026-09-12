---
system: renderer-ui
sources:
  - src/App.tsx
  - src/styles.css
  - index.html
verified_at: 34781569
---

# Renderer UI

> Last verified: 2026-09-12

## Agent Brief

**Scope.** The entire chrome of Private Browser — title bar, tab strip, toolbar,
Chrome-style bookmarks bar, home dashboard, workspace switcher and the seven-mode
right sidebar — lives in one
732-line file, [App.tsx](../../src/App.tsx), styled by one 307-line stylesheet.
The renderer owns no browsing state: it renders a `BrowserSnapshot` pushed from
the main process and calls back over `window.privateBrowser`.

**Not covered here:** the `WebContentsView` that actually renders web pages, tab
and session lifecycle, and everything behind an IPC channel. Web content is
*never* inside this React tree — it is a sibling view the main process positions.
→ [browser-shell.md](browser-shell.md), [ipc-contract.md](ipc-contract.md).

The toolbar MyVault button opens a compact metadata panel; a modal full view
uses the same projections. React can search metadata and request unlock, pair,
sync, fill, copy, generate, save, edit, delete, migrate and conflict resolution,
but never receives a master password, device token, data key or entry secret.
Development hides the surface completely; Banking renders only centrally
permitted actions.

**Neighbours.**

- **browser-shell.md** — owns `electron/main.ts`: window, views, layout
  application, and a second copy of the keyboard shortcuts.
- **ipc-contract.md** — owns `electron/preload.cts`: every method named below.
- **workspaces-and-state.md** — owns the snapshot this file renders.
- **vault.md** / **ai-consent.md** / **release-and-updates.md** — own the
  behaviour behind the Vault, Assistant and Settings panels.

### Invariants

1. **Three copies of the chrome geometry must agree.** `setLayout` in App.tsx,
   the fixed offsets in styles.css, and the `Layout` default in `main.ts` all
   describe the same rectangle. Change one, change all three. → **The Layout
   Handshake**
2. **Every `on*` subscription must return its unsubscribe function from the
   effect.** The preload bridge returns a disposer; dropping it leaks an
   `ipcRenderer` listener on every remount. → **Main-Process Subscriptions**
3. **A shortcut added here must be added in `main.ts` too, or it dies whenever a
   web page has focus.** → **Gotchas**
4. **Automations only open tabs.** No panel may add a routine that sends, buys,
   publishes or deletes. → **Static Data Tables**
5. **The renderer never receives a secret back.** Panels submit tokens, keys and
   passwords and read only status objects. → **Sidebar Modes and Their IPC**

### Where to look

<!-- routing:start -->

| You are changing… | Section |
| --- | --- |
| a panel's markup, props or local state | [Frontend Components](#frontend-components) |
| adding, moving or removing a call to the main process | [Sidebar Modes and Their IPC](#sidebar-modes-and-their-ipc) |
| a quick-link tile or a one-click routine | [Static Data Tables](#static-data-tables) |
| reacting to something the main process pushes | [Main-Process Subscriptions](#main-process-subscriptions) |
| the size of the chrome, or where the web view sits | [The Layout Handshake](#the-layout-handshake) |
| the CSP, the page title or the module entry point | [index.html](#indexhtml) |
| colours, spacing, or the fixed-position shell | [Styling](#styling) |
| a keyboard shortcut, or a number that lives in three files | [Gotchas](#gotchas) |

<!-- routing:end -->

### Before you write

- Read the `BrowserSnapshot` shape in [types.ts](../../electron/types.ts) before
  adding a field to a panel — the renderer cannot invent state.
- Any new call must exist on the preload bridge first; `window.privateBrowser`
  is the only channel.
- New inline `style` attributes are fine (`style-src 'unsafe-inline'` is set),
  but a new remote asset host needs a CSP change in `index.html`.
- Panels are plain functions in the same file. Keep them there unless the file
  outgrows a single read; a split costs every reader an extra hop.
- Errors surface as toasts, never as thrown exceptions — wrap IPC in `act()` or
  a local try/catch, as every existing panel does.

## Overview

`index.html` boots a Vite/React module at `/src/main.tsx`, which mounts `App`
into `#root` under `StrictMode`. `App` fetches one snapshot with `getState()`,
subscribes to pushes, and renders a boot placeholder until the snapshot, an
active tab and an active workspace all exist. Everything else in the file is a
child function component in the same module.

## Frontend Components

All in [App.tsx](../../src/App.tsx).

| Component | Renders | Key state |
| --- | --- | --- |
| `App` (default) | Title bar, tab strip, toolbar, dashboard, sidebar, toast | `state` (snapshot or `null`), `address`, `sidebarOpen` (default `true`), `sidebarMode` (default `assistant`), `toast`, `addressRef` |
| `WorkspaceSwitcher` | Horizontal row at the top of the right panel; one button per `state.workspaces`, plus the personal shortcut; lock icon when protected; sets `--workspace-color` per button | none |
| `Dashboard` | The home screen — welcome block, quick-link grid, 5 most recent history rows, 5 bookmarks, all filtered to the active workspace | none (derives from props) |
| `SidebarNav` | The seven mode buttons; red badge showing the count of downloads in `progressing` state | none |
| `PanelHeader` | Icon + eyebrow + title, shared by every panel | none |
| `DeveloperPanel` | Workspace gate, native DevTools launcher/position, inspection hint, built-in panel map and sanitized diagnostic report | `mode`, `report`, `loading` |
| `AssistantPanel` | Provider strip, provider form, local preview card, cloud-permission card, question box, answer | `preview`, `approvalToken`, `loading`, `provider`, `showProviderForm`, `providerForm` (endpoint defaults to `https://openrouter.ai/api/v1`), `question`, `answer`; `summary` is a `useMemo` |
| `VaultPanel` | Encryption-health banner, corrupt-vault recovery button, add form, credential cards | `items`, `available`, `unavailableReason`, `adding`, `form` |
| `AutomationPanel` | The three hard-coded routines and the approval-boundary note | `running` (id of the routine in flight) |
| `DownloadsPanel` | Download progress plus checksum and executable-risk warnings | none |
| `PrivacyPanel` | Three summary tiles and the `state.privacyLog` feed | none |
| `SettingsPanel` | Default browser, Chrome import wizard, bookmark-bar toggle, private downloads, security and about | update state plus Chrome profiles, options and result |
| `EmptyState` | Icon + one line, used at five call sites across four panels | none |

Module-level helpers: `domainFromUrl` (hostname minus `www.`, falls back to the
raw string), `humanBytes` (B/KB/MB/GB), `timeAgo` (`just now` / `Nm` / `Nh` /
`Nd`). `App` also defines `act(action, success?)`, which awaits an IPC call and
turns either the success string or the thrown error message into a toast.

## Sidebar Modes and Their IPC

`SidebarMode = 'assistant' | 'developer' | 'vault' | 'automations' | 'downloads' |
'privacy' | 'settings'`. Exactly one panel is mounted at a time, so a panel's `useEffect`
load runs each time the user switches to it.

| Mode | `window.privateBrowser` methods called |
| --- | --- |
| `assistant` | `getAiProvider`, `configureAiProvider`, `clearAiProvider`, `prepareAiPreview`, `approveAiPreview`, `askAi` |
| `developer` | `toggleDeveloperTools`, `captureDeveloperDiagnostics`, `clearDeveloperDiagnostics`, `copyText` |
| `vault` | `listVault`, `addVaultItem`, `removeVaultItem`, `resetCorruptVault`, `copyPassword`, `copyTotp`, `autofill` |
| `automations` | `newTab(workspaceId, url)` only |
| `downloads` | `openDownload`, `showDownload` (the list itself comes from `state.downloads`) |
| `privacy` | none — pure render of `state.trackerBlocking` and `state.privacyLog` |
| `settings` | `getDefaultBrowserStatus`, `setDefaultBrowser`, `getUpdateService`, `configureUpdateService`, `clearUpdateService`, `checkForUpdates`, `openUpdatePage` |

The always-mounted chrome (not a sidebar mode) calls `getState`, `setLayout`,
`navigate`, `back`, `forward`, `reload`, `stop`, `newTab`, `closeTab`,
`activateTab`, `switchWorkspace`, `toggleBookmark`, `openBookmark`,
`toggleBookmarkBar` and `toggleTrackerBlocking`. Settings additionally calls the
three Chrome import methods.

`copyText` is used only to copy the main-process-formatted developer report; it
does not receive raw page content or browser secrets.

Nothing sensitive comes back: `configureAiProvider` and `configureUpdateService`
return status objects (`configured`, `endpoint`, `model`, `error`), never the key
or token that was submitted. The AI flow is two steps by design — `prepareAiPreview`
reads the page locally, `approveAiPreview` returns a single-use token that `askAi`
consumes, and the panel clears `approvalToken` immediately after asking.

## Static Data Tables

Both are hard-coded consts at the top of App.tsx. Neither is persisted, editable
in the UI, or synced.

**`QUICK_LINKS`** — `Record<WorkspaceId, Array<{label, url, tone}>>`, rendered by
`Dashboard` as the shortcut grid; `tone` is a hex colour used for the tile. Being
a `Record` over `WorkspaceId`, TypeScript forces a new workspace to bring its own
entry. Current sets: digitronics (4), tenten (4), development (4), personal (4),
banking (1 — a private search engine only).

**`AUTOMATIONS`** — three entries (`morning`, `development`, `marketplaces`),
each `{ id, name, description, icon, workspaceId, urls }`. `AutomationPanel.run`
awaits `newTab(workspaceId, url)` once per URL, in order, then toasts.

That is the whole feature. A routine **opens tabs in a workspace and stops**. It
does not log in, fill anything, click anything, read the pages back, verify they
loaded, or record that it ran. Per [README.md](../../README.md), these routines
deliberately never send, buy, publish or delete — the panel says so on screen
("Messages, purchases, ads, deletion and account changes always require you"),
and that boundary is the point of the feature, not a limitation to fix.

## Main-Process Subscriptions

Three push channels, each set up in its own `useEffect` in `App`. Each preload
method returns an unsubscribe function, and each effect returns it directly, so
React tears the listener down on unmount.

| Subscription | Payload | What the renderer does |
| --- | --- | --- |
| `onState` | `BrowserSnapshot` | `setState` — the only way browsing state ever changes |
| `onFocusAddress` | none | focuses and selects the address input (this is how the main process's Ctrl+L reaches the box) |
| `onUpdateAvailable` | `UpdateCheckResult` | toasts `Private Browser <version> is ready to download` |

`onState` is paired with a one-shot `getState()` in the same effect so the first
paint does not wait for a push. Two further effects are pure renderer bookkeeping:
`address` is re-synced whenever the active tab's id, url or `isHome` changes (home
tabs show an empty box), and a toast clears itself after 3200 ms.

**Toasts carry a kind.** State is `{ text, kind: 'ok' | 'error' }`, set through
`showToast(text, kind = 'ok')`; every `catch` passes `'error'`. A failure renders
an `X` in `--danger` with a tinted border, a success a green `Check`. Before this
there was one toast style and every security refusal — "AI access is disabled for
protected and banking pages", "This credential belongs to another website" —
appeared with the same green tick as a success (audit finding F-16). Both the
icon and the border change, not only the colour.

**Secret fields are cleared in `finally`, not on success.** The provider API key,
the vault password and authenticator seed, and the download access token are all
dropped whether or not the submit was accepted; a rejected submit used to leave
them in renderer state and in the input's DOM value (F-25). The vault form keeps
label, address and username on failure so a rejected entry need not be retyped
whole.

**The AI approval card shows the payload, not a taste of it.** It renders
`preview.text` verbatim in a scrollable box with its character count, plus
`preview.title` (the *redacted* title) and `preview.url` (the bare origin). It
previously showed at most three sentences longer than 35 characters — nothing at
all on a page of short lines — above the claim that only "the preview shown
above" would be sent, while up to 12,000 characters went to the provider (F-06).
It also showed the live tab title, which a page can rewrite at any moment, rather
than the redacted one actually sent.

**Clearing the panel revokes for real.** "Clear page context" and unmounting the
panel both call `revokeAiContext()`, so the captured text and the live capability
are dropped in the main process instead of merely being forgotten here (F-24).

**The security badge is derived, not asserted.** Settings shows "Checking…" until
the first status arrives, then "Active" or "Encryption unavailable" based on
`updateStatus.error`. It used to be a hardcoded green "Active" that contradicted
the Vault panel whenever encryption was unavailable (F-18).

## The Layout Handshake

Web pages are not in this React tree. The renderer measures its own chrome and
tells the main process which rectangle is left over, and the main process gives
that rectangle to the active `WebContentsView`.

```
useEffect(() => {
  void window.privateBrowser.setLayout({ top: bookmarkBarVisible ? 158 : 128, left: 0, right: sidebarOpen ? 366 : 0, bottom: 0 });
}, [sidebarOpen, bookmarkBarVisible]);
```

Where those numbers come from in [styles.css](../../src/styles.css):

| Inset | Value | Source |
| --- | --- | --- |
| `top` | 128 or 158 | title, tabs and toolbar, plus the optional 30px bookmarks bar |
| `left` | 0 | the removed left rail no longer reserves webpage space |
| `right` | 366 when open, 0 when closed | `.sidebar` width |
| `bottom` | 0 | no status bar |

The effect depends on `sidebarOpen` and bookmark-bar visibility, so it fires at
mount and whenever either inset changes. Window resizes are handled in the main process, which
re-applies the last received insets on `resize`.

The main process clamps what it receives (`top` at minimum 80, the rest at
minimum 0, all rounded) and computes the view bounds as
`width - left - right` by `height - top - bottom`, each floored at 100px. See
[browser-shell.md](browser-shell.md).

## index.html

- **CSP meta tag** — `default-src 'self'`; `script-src 'self'`; `style-src 'self'
  'unsafe-inline'` (required: the app sets inline `style` attributes for workspace
  colour, quick-link tone and download progress); `img-src 'self' data:`
  (tab favicons arrive as `data:` URLs built by the main process, see
  [browser-shell.md](browser-shell.md#favicons)); `connect-src 'self'`
  — **no localhost exceptions ship**. The Vite dev server and its HMR socket
  need `ws://127.0.0.1:* http://127.0.0.1:*`, injected by a `transformIndexHtml`
  plugin in [vite.config.ts](../../vite.config.ts) with `apply: 'serve'`, so they
  exist in dev only. They used to be written into this file and therefore shipped
  inside the installer (audit finding F-17); `object-src 'none'`;
  `form-action 'none'`.
- **Root element** — `<div id="root">`, the only body content.
- **Module entry** — `<script type="module" src="/src/main.tsx">`.
- Also sets `<title>Private Browser</title>` and `theme-color` `#0b0d12`.

## Styling

[styles.css](../../src/styles.css) is a single flat stylesheet — no framework, no
preprocessor, no CSS modules. What a future editor needs:

- **Tokens** on `:root`: `--bg`, `--surface`, `--surface-2`, `--surface-3`,
  `--line`, `--line-bright`, `--text`, `--muted`, `--blue`, `--blue-soft`,
  `--green`, `--danger`. Dark-only; there is no light theme and no
  `prefers-color-scheme` block.
- **Two runtime-injected custom properties**, set from React as inline styles:
  `--workspace-color` on each workspace switcher button and `--accent` on `.dashboard`, both
  taken from `workspace.color` and both consumed through `color-mix(in srgb, …)`.
- **The layout system is fixed positioning, not flow.** `html, body, #root` are
  100% tall with `overflow: hidden`, and `.titlebar`, `.tabbar`, `.toolbar`,
  `.dashboard` and `.sidebar` are each `position: fixed` with
  hard-coded pixel offsets. These numbers are the same ones sent over
  `setLayout` — see **The Layout Handshake**.
- **Load-bearing oddities.** `.titlebar` carries `-webkit-app-region: drag` and
  150px of right padding to clear the Windows caption buttons. `.tabbar` reserves
  380px of right padding so tabs never slide under the sidebar. `.app-shell:not(:has(.sidebar))
  .dashboard { right: 0 }` widens the home screen when the sidebar is closed —
  a `:has()` selector, so it depends on the sidebar being conditionally rendered
  rather than hidden.
- One breakpoint (`max-width: 1220px`) collapses the quick-link grid to two
  columns and the dashboard to one. Two keyframes: `spin`, `toast-in`.

## Related Systems

- [browser-shell.md](browser-shell.md) — the other half of the layout handshake
  and the other copy of the keyboard shortcuts.
- [ipc-contract.md](ipc-contract.md) — the preload bridge every call above uses.
- [workspaces-and-state.md](workspaces-and-state.md) — what is in a snapshot.
- [vault.md](vault.md), [ai-consent.md](ai-consent.md),
  [release-and-updates.md](release-and-updates.md) — the three panels with real
  machinery behind them.
- [security-boundary.md](security-boundary.md) — why the CSP and the
  never-return-a-secret rule are shaped the way they are.

## Gotchas

- **Keyboard shortcuts are implemented twice.** `App.tsx` attaches a `window`
  `keydown` listener; `main.ts` attaches `before-input-event` to every tab's
  `webContents`. Ctrl/Cmd + **L, T, W, R** and F12/Ctrl+Shift+I exist in both, because the renderer
  listener is deaf while a web page has focus and the main-process listener is
  deaf while the React chrome has focus. They are not identical: `main.ts` also
  handles Alt+Left / Alt+Right, and the renderer copy guards Ctrl+W on an active
  tab and Ctrl+R on `!isHome` where the main copy does not. Both copies ignore
  auto-repeat; the main copy also accepts only `keyDown`. Adding a shortcut in
  one place gives you a shortcut that works only half the time.
- **The layout numbers exist in three places.** The renderer call, main-process
  default and fixed CSS offsets all use top `128`, left `0` and right `366` while
  the sidebar is open. Keep them synchronized when changing chrome geometry.
- **`PrivacyPanel` hard-codes `5` isolated spaces** instead of reading
  `state.workspaces.length`. Adding a workspace silently leaves it wrong.
- **`SettingsPanel` falls back to a hard-coded version string** for the about
  card when `updateStatus` has not loaded yet. It is not read from
  `package.json`, so it goes stale on every version bump — and already has: the
  0.3.0 → 0.3.1 release had to edit this literal by hand.
- **The download button shows even when you are up to date.** It used to render
  only when a newer version existed; it now always renders once the service is
  configured, relabelled `Download page`. Both labels call the same
  `openUpdatePage`, which opens the signed page in a Development-workspace tab.
- **The "LOCAL SUMMARY" text is not AI output.** It is the `summary` `useMemo`:
  collapse whitespace, split on sentence endings, keep sentences longer than 35
  characters, join the first three. Nothing has left the machine at that point.
- **Panels re-fetch on every mode switch.** `VaultPanel`, `AssistantPanel` and
  `SettingsPanel` load in a mount effect, and switching modes unmounts them, so
  toggling the sidebar tabs repeatedly re-issues those IPC calls.
- **`act()` is only used by the chrome.** Each panel repeats its own
  try/catch/toast instead, so error handling is duplicated eleven times over.
