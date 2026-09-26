---
system: renderer-ui
sources:
  - src/**
  - index.html
verified_at: 028b9d2d
---

# Renderer UI

> Last verified: 2026-09-26

## Agent Brief

**Scope.** The whole trusted browser chrome — tab strip, toolbar and address bar,
bookmarks bar, find bar, side panel, New Tab page, menus, dialogs and every panel
— as a React tree under [src/](../../src/). The renderer owns no browsing state:
it renders a `BrowserSnapshot` pushed from the main process and calls back over
`window.privateBrowser`.

**Not covered here:** the `WebContentsView` that actually renders web pages, tab
and session lifecycle, and everything behind an IPC channel. Web content is
*never* inside this React tree — it is a sibling native view the main process
positions. The geometry and shortcut tables are shared modules documented in
[browser-shell.md](browser-shell.md#layout-maths).

The MyVault panel shows metadata only: React requests vault actions but never
receives a master password, device token, data key or entry secret. Development
hides the vault entry points; Banking renders only centrally permitted actions.

**Neighbours.**

- **browser-shell.md** — owns `electron/main.ts`, `chrome-layout.ts`,
  `shortcuts.ts` and `bookmark-tree.ts`: window, views, layout application,
  freeze-frame, shortcut resolution.
- **ipc-contract.md** — owns `electron/preload.cts`: every method named below.
- **workspaces-and-state.md** — owns the snapshot fields and `ui` preferences.
- **vault.md** / **ai-consent.md** / **release-and-updates.md** — own the
  behaviour behind the Vault, Assistant and Settings panels.

### Invariants

1. **Geometry comes only from `computeChromeLayout`.** Bars size from its result,
   CSS reads `--chrome-top`/`--side-panel-w`/`--*-h` set on `.app-shell`, and the
   same result is sent over `setLayout`. Never hard-code a chrome offset. →
   **The Layout Handshake**
2. **Anything drawn over the page area must acquire the overlay.** Use
   `MenuSurface` (menus/popovers) or `useOverlayLayer` (dialogs, drags); the page
   view paints above React otherwise. → **Menus, Overlays and the Freeze-Frame**
3. **Every `on*` subscription is returned from its effect through `disposer()`.**
   → **Main-Process Subscriptions**
4. **Shortcuts are resolved by `resolveShortcut` and run by one dispatcher**
   (`runCommand` in App.tsx) — never add a second `keydown` table; key-less
   `open-vault` (login picker's "Manage logins…") shares it. → **Keyboard**
5. **Security warnings stay visible.** The "Not secure"/"Check domain" chip in the
   address bar is never hidden for density; narrow layouts hide optional buttons
   instead. → **Toolbar and Address Bar**
6. **Automations only open tabs; the renderer never receives a secret back.** →
   **Panels and Their IPC**

### Where to look

<!-- routing:start -->

| You are changing… | Section |
| --- | --- |
| which file renders what | [Component Map](#component-map) |
| tabs, drag reordering, tab search, the shield | [Tab Strip](#tab-strip) |
| toolbar buttons, the address bar, site information | [Toolbar and Address Bar](#toolbar-and-address-bar) |
| profile menu, browser menu, any popup | [Menus, Overlays and the Freeze-Frame](#menus-overlays-and-the-freeze-frame) |
| the bookmarks bar, folders, overflow, context menus | [Bookmarks Bar](#bookmarks-bar) |
| the side panel, its tools, resizing | [Side Panel](#side-panel) |
| the New Tab page or shortcut tiles | [New Tab Page](#new-tab-page) |
| a panel's markup or IPC calls | [Panels and Their IPC](#panels-and-their-ipc) |
| a keyboard shortcut | [Keyboard](#keyboard) |
| reacting to something the main process pushes | [Main-Process Subscriptions](#main-process-subscriptions) |
| where the page sits, bar heights | [The Layout Handshake](#the-layout-handshake) |
| colours, themes, type scale, motion | [Styling](#styling) |
| the CSP or the browser preview mock | [index.html and Preview Mode](#indexhtml-and-preview-mode) |

<!-- routing:end -->

### Before you write

- Read the `BrowserSnapshot` shape in [types.ts](../../electron/types.ts) before
  adding a field to a component — the renderer cannot invent state.
- Any new call must exist on the preload bridge first, and in
  [preview-api.ts](../../src/preview-api.ts) if the browser tests need it.
- Errors surface as toasts: wrap IPC in `act()` (App) or a local try/catch.
- Only show a menu action that works. Unsupported browser features are listed in
  [../follow-ups.md](../follow-ups.md), not rendered as disabled decoration.

## Component Map

| Path | Renders | Notes |
| --- | --- | --- |
| [App.tsx](../../src/App.tsx) | the shell: subscriptions, layout effect, overlay coordination, command dispatcher, which menu/dialog is open | holds `pendingUi` optimistic preferences until the snapshot confirms them |
| `shell/TabStrip.tsx` | `WindowTabStrip`: shield button, `role=tablist` tabs, new tab, drag area, tab search, caption space | pointer drag reorder, middle-click close, roving focus |
| `shell/NavigationToolbar.tsx` | back, forward, reload/stop, home, address bar, side panel, AI, profile avatar, ⋮ | Home and AI carry `optional` (hidden below 560 px) |
| `shell/StatusMenus.tsx` | `ShieldStatusMenu`, `SiteInfoMenu`, `TabSearchMenu` | protection status lives here, not in permanent chrome |
| `shell/ProfileMenu.tsx` | current Account Space card, workspace switcher, Account Space list, manage/add/lock | `role=menu` named "Account Spaces" |
| `shell/BrowserMenu.tsx` | Chrome-style ⋮ menu with submenus and the zoom row | |
| `shell/BookmarkBar.tsx` | bookmarks bar, folder/overflow/"Other bookmarks" menus, context menus | measures entries to compute overflow; a nameless bookmark renders icon-only (`.icon-only`) |
| `shell/FindBar.tsx` | find-in-page row | only on real pages |
| `shell/SidePanel.tsx` | panel frame: resize separator, tool tabs, close | tools listed in `SIDE_PANEL_TABS` |
| `shell/NewTabPage.tsx` | brand, search, shortcut tiles, recent/bookmark cards, Customize | |
| `shell/Menu.tsx` | `MenuSurface`, `MenuItem`, `SubmenuItem`, `MenuSeparator`, `MenuHeading` | portal, positioning, keyboard, focus restore |
| `shell/overlay.tsx` | `OverlayContext`, `useOverlayLayer` | |
| `shell/PromptDialog.tsx` | text-input dialog (rename, shortcuts) | Electron has no `window.prompt`; a field marked `optional` may be submitted empty |
| `shell/BrandMark.tsx` | the original teal shield | no third-party marks |
| `panels/*.tsx` | Assistant, Developer, Vault, Automation, Downloads, Privacy, Settings (+ Updates page), AccountManager, Permission/Recovery overlays, Bookmarks, History | existing panels were moved verbatim; Settings gained Appearance and bookmarks-bar mode |
| `lib/` | `format.ts` (domain, bytes, timeAgo, cached favicons by host), `accounts.tsx` (avatar, action-required rule), `quick-links.ts` (default New Tab tiles), `subscribe.ts` | |

## Tab Strip

Only tabs of the active Account Space render (`tab.accountSpaceId ===
state.activeAccountSpaceId`). A tab is a `role=tab` div (so its close and mute
buttons are real buttons, not nested inside one) activated on pointer-down.
Dragging past 5 px moves the tab with the pointer while siblings shift by its
width; release calls `moveTab(id, index)`. Middle-click closes, Delete closes the
focused tab, arrows move focus and activate. Tabs flex between 76 and 236 px (an explicit
`width` makes the strip size from 236 px rather than from content). Container
queries on each tab's content box drop the audio toggle below 96 px, the inactive
close button below 72 px and the title only below 44 px, so many tabs keep
truncated titles as in Chrome; past the minimum the strip scrolls (wheel scrolls horizontally). Loading shows
a spinner; `audible`/`muted` show a mute toggle.

The empty strip and the space right of the tabs are `-webkit-app-region: drag`;
every button and tab is `no-drag`. `.caption-buttons-space` reserves the width
Windows reports through `env(titlebar-area-*)` (fallback 138 px).

## Toolbar and Address Bar

The address bar (`role=search`) shows a site-information button on the left —
search icon on the New Tab page, warning triangle for `securityWarning`, site
controls otherwise — then the always-visible security chip, the input, a zoom
magnifier when not 100 % (opens `ZoomMenu`: −, +, Reset; it stays while that
bubble is open so Reset does not pull its anchor away), the MyVault key (not in Development) and the bookmark star.
`SiteInfoMenu` explains the connection state, Account Space and tracker
blocking. The profile avatar has an Account Space colour ring and a "!" badge only
for `reconnect-required`, `partial-scopes` or `account-corrupt`
(`accountNeedsAction`).

## Menus, Overlays and the Freeze-Frame

`MenuSurface` portals to `<body>`, positions below/beside its anchor or at a
point, clamps to the viewport (scrolling when taller), focuses the first item,
supports Arrow/Home/End, Esc, ArrowLeft to leave a submenu, Tab to close, closes
on outside pointer-down and window blur, and restores focus to the anchor.
`SubmenuItem` opens on hover (140 ms), click, ArrowRight or Enter.

Root surfaces acquire the overlay. App counts acquisitions and also treats the
Account Space manager, full vault view, permission prompt and recovery prompt as
overlays. When the count becomes non-zero App calls `freezeContent()`, paints the
returned image (or nothing for protected pages) in `.page-surface`, waits two
frames, then calls `setOverlayOpen(overlayOpen)` to hide the live view; menus fade
in once `ready`. Closing reverses the order and drops the image. Changing tab
clears the image.

The browser menu lists only working actions: new tab, reopen closed tab, Account
Spaces, Passwords and MyVault, History, Downloads, Bookmarks (bookmark tab,
bar mode, manager, import, export), Delete browsing data (confirmed; removes
website data and history of the active Account Space only), zoom and full
screen, Print, Find, Copy link, More tools (DevTools, Developer Bridge,
Automations, Privacy log, Block trackers), Privacy and AI, Appearance, Settings,
About, Exit.

## Bookmarks Bar

Shown per `computeChromeLayout` (`always`, or `new-tab` on the New Tab page).
Entries come from `bookmarkEntries` (imported Chrome order and folders). A hidden
measuring row gives each entry's width; a `ResizeObserver` decides how many fit
and the rest go to the » overflow menu. Folders open nested `SubmenuItem` menus.
Top-level entries drag-reorder (`moveBookmark`). Right-click offers Open in new
tab, Copy link, Edit name, Delete; folders offer Open all (confirm above 8), Rename
and Delete; the empty bar offers the visibility modes, the manager, import and
export. Icons reuse favicons the main process already fetched — live tab icons
first, then the active space's remembered `bookmarkIcons` — and the bar never
fetches an icon. The import hint appears only while the bar is empty
and until dismissed (per-viewer `localStorage` flag).

## Side Panel

Closed by default; `ui.sidePanelOpen`, `sidePanelWidth` and `sidePanelTool` are
persisted through `setUiPreferences`. The header holds compact tool tabs —
Claude, AI, DevTools (title "Developer cockpit"), Vault, Flows, Files (active download badge),
Privacy — and a close button; Bookmarks, History and Settings open from menus and
shortcuts. The left-edge separator resizes 320–520 px: pointer drags acquire the
overlay (the page view would otherwise swallow the pointer), update a live width
that only moves CSS, and commit once on release — so the IPC rate limit is never
hit. The drag is tracked with window-level `pointermove`/`pointerup` listeners
(pointer capture is requested but not relied on), so losing capture cannot end
the drag early. Arrow keys resize by 24 px, Home/End jump to max/min.

**Claude** (`panels/SideAppPanel.tsx`, also the ✱ toolbar button and the ⋮ menu)
draws a control row (back, forward, reload, new chat, open in tab, sign out with
a confirm) above `.side-app-slot`, and reports that slot's rectangle so the main
process can lay the native claude.ai view over it. In Banking it shows a notice
and reports `null`. See [side-apps.md](side-apps.md).

**The frame must never scroll sideways.** `html, body, #root` use `overflow: clip`,
not `hidden`: a hidden box is still scrollable by focus or `scrollIntoView`. The
bookmarks bar's `.bookmark-measure` row (every bookmark, used to compute overflow)
is zero-width and clipped. Before both, that row made `#root` about 2,200 px wide,
a click scrolled the frame ~800 px left, and the side panel grip ended up
off-screen (seen only on the GitHub Linux runner's fonts). `chrome-shell.spec.ts`
asserts `#root` scrollLeft 0 and no `.app-shell` overflow.

## New Tab Page

Brand mark and "Private Browser" heading, a search field that calls `navigate`,
the workspace and Account Space, up to 12 shortcut tiles, recently visited and
bookmark cards, and a Customize popover (theme, five local gradient backgrounds,
restore default shortcuts). Tiles default to `defaultShortcutTiles(workspace)`;
the first edit saves an explicit list with fresh ids through `setShortcutTiles`.
Protection detail is in the shield menu, not on the page.

## Panels and Their IPC

| Tool | `window.privateBrowser` methods |
| --- | --- |
| `assistant` | `getAiProvider`, `configureAiProvider`, `clearAiProvider`, `prepareAiPreview`, `approveAiPreview`, `askAi`, `revokeAiContext` |
| `developer` | bridge status/pair/disconnect/install, project list/select/action, page inspection, DevTools, developer AI preview, `copyText`; the Tasks tab ([ControlCenterSection.tsx](../../src/panels/ControlCenterSection.tsx)) uses the `control-center:*` methods ([control-center-link.md](control-center-link.md)) |
| `vault` | `listVault`, unlock/pair/lock/sync/conflict intents, Windows Hello unlock/enable/disable intents, `openVaultEditor`, `requestSaveFromPage`, migration, generators, `copyPassword`, `copyTotp`, `autofill` |
| `automations` | `newTab(workspaceId, url)` only |
| `downloads` | `openDownload`, `showDownload` |
| `privacy` | none |
| `settings` | default browser; Search engine (preset `<select>` or a custom `https://…%s` address), Home page (New Tab page or a web address) and On startup, through `setBrowserSettings`; update service, Chrome import, `setUiPreferences` (theme, bar mode) |
| `bookmarks` | `openBookmark`, `renameBookmark`, `removeBookmark`, `exportBookmarks` |
| `history` | `navigate`, `clearAccountSpaceData` (confirmed) |

The two-step AI flow is unchanged: preview locally, approve for a single-use
token, ask once, then the token is cleared; leaving the panel revokes the
context. Secret form fields are cleared in `finally` and whenever their form is
collapsed, cancelled or left. Toasts carry `ok`/`error` so a refusal never looks
like success, and every IPC action has a rejection handler. Decision dialogs
(permission, recovery, full vault view) use `useModalFocus` (`src/lib/dialog.ts`):
focus stays inside, Escape denies or closes, focus returns afterwards. The
permission prompt is keyed by prompt id and its Allow buttons arm after 500 ms.
A page URL change never overwrites an address the user is editing. Automations open tabs and stop — they
never send, buy, publish or delete.

## Keyboard

App's `keydown` listener resolves the event with `resolveShortcut` and runs
`runCommand`; `onCommand` delivers commands resolved while a page had focus.
Ctrl+Shift+Left/Right are ignored inside text fields (word selection). Esc leaves
window full screen. Menus stop propagation of the keys they handle.

## Main-Process Subscriptions

| Subscription | Payload | What the renderer does |
| --- | --- | --- |
| `onState` | `BrowserSnapshot` | `setState` — the only way browsing state changes |
| `onCommand` | `Shortcut` | `runCommand` |
| `onFindResult` | `FindResult` | match counter in `FindBar` |
| `onUpdateAvailable` | `UpdateCheckResult` | toast |
| `onVaultState` | none | vault panel reloads status and metadata |

`onState` is paired with a one-shot `getState()`. The address box re-syncs when
the active tab's id, url or `isHome` changes. `data-theme` and `--frame`/`--window`
follow `windowState.darkMode` using `FRAME_COLORS`, the same values the native
title-bar overlay uses.

## The Layout Handshake

App computes `committedLayout = computeChromeLayout({ bookmarkBarMode, isHome,
findBarOpen, sidePanelOpen, sidePanelWidth, fullscreen, windowWidth })` and sends
`committedLayout.insets` whenever a side changes. A second `liveLayout` uses the
in-progress drag width for CSS only. `.app-shell` receives `--tab-strip-h`,
`--toolbar-h`, `--bookmark-bar-h`, `--find-bar-h`, `--chrome-top` and
`--side-panel-w`; the toolbar, bookmarks bar, find bar, `.page-surface`,
`.new-tab-page` and `.side-panel-shell` position from those. In full screen all
chrome unmounts and the variables are zero. `tests/renderer-layout.test.ts` pins
this wiring, `chrome-shell.spec.ts` compares reported insets with the DOM, and
`tests/electron/chrome-layout.spec.ts` compares the real view bounds.

## Styling

[styles.css](../../src/styles.css) is one flat stylesheet on tokens: type scale
(`--fs-xs` 11 px … `--fs-xxl` 30 px; nothing smaller than 11 px), radii, motion
(120/160/200 ms with one easing), sizes (`--button` 34, `--omnibox` 36), and
colour roles (`--frame`, `--toolbar`, `--surface*`, `--field*`, `--text*`,
`--border*`, `--hover`, `--accent*`, `--ok`/`--warn`/`--danger` with soft
variants, shadows, `--scrim`). `:root` is the light theme; `:root[data-theme=dark]`
is charcoal with a teal accent. Windows 11-style menus use `--radius-lg` and
`--shadow-menu`. System fonts only ("Segoe UI Variable", Segoe UI, system-ui); no
remote assets. Media queries: 1100 px (tab width), 850 px (Account Space manager),
560 px (optional toolbar buttons), `prefers-reduced-motion`, `forced-colors`.
Existing panel class names were kept and restyled on the tokens.

## index.html and Preview Mode

- **CSP** — `default-src 'self'`; `script-src 'self'`; `style-src 'self'
  'unsafe-inline'` (inline custom properties); `img-src 'self' data:` (favicons and
  the freeze-frame arrive as `data:` URLs); `connect-src 'self'`; `object-src
  'none'`; `form-action 'none'`. Dev-only localhost sources are injected by the
  Vite plugin with `apply: 'serve'`.
- [preview-api.ts](../../src/preview-api.ts) exists only under Vite dev and
  supplies credential-free data for review and browser E2E: six Account Spaces,
  page tabs with a long title, an audible tab and an insecure `http:` tab, nested
  bookmark folders with enough entries to overflow, and in-memory implementations
  of the new tab, bookmark, preference and shortcut methods. `?theme=` and
  `?panel=open` seed preferences, `?permission=prompt` shows a pending
  permission prompt; `setLayout` records the insets on
  `<html data-preview-layout>` for tests. [preview-bridge.ts](../../src/preview-bridge.ts)
  is the same kind of dev-only mock for the VS Code bridge (`?preview=bridge`).
  Production always uses the preload.

## Related Systems

- [browser-shell.md](browser-shell.md) — geometry, shortcuts, freeze-frame and the
  main-process half of every handler.
- [ipc-contract.md](ipc-contract.md) — the preload bridge.
- [workspaces-and-state.md](workspaces-and-state.md) — the snapshot and `ui`.
- [vault.md](vault.md), [ai-consent.md](ai-consent.md),
  [release-and-updates.md](release-and-updates.md) — panels with real machinery.
- [security-boundary.md](security-boundary.md) — why the CSP and the
  never-return-a-secret rule are shaped the way they are.

## Gotchas

- **Menus look frozen over pages.** That is the freeze-frame, not a hang; protected
  pages show a plain backdrop instead of an image.
- **Accessible names depend on block layout.** Menu labels stack `strong`/`small`
  in a flex column so Chromium inserts a space between them ("Personal Local
  browsing only"); keep that when restyling.
- **`PrivacyPanel` still hard-codes `5` isolated spaces** instead of counting
  Account Spaces.
- **Panels re-fetch on every tool switch** because only one panel is mounted.
- **The Updates page checks on every mount.** Deliberate: signed links expire after
  15 minutes.
- **Preview mode is not Electron.** There is no page view, so the freeze-frame and
  real bounds are only exercised by `tests/electron/`.
