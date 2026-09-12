---
system: browser-shell
sources:
  - electron/main.ts
  - electron/developer-tools.ts
verified_at: 7063e89
---

# Browser Shell

> Last verified: 2026-09-12

## Agent Brief

**Scope.** [main.ts](../../electron/main.ts) is the Electron main process: one
`BrowserWindow` holding the React chrome, and one `WebContentsView` per browsing
tab layered over it. This doc covers the window, tab lifecycle, navigation and
history, layout maths, keyboard shortcuts, developer tooling, downloads, tracker blocking, the
privacy-log writer, per-workspace sessions and permissions, popup downgrading,
launch and single-instance handling, and the IPC registration wrapper.

**This doc owns `electron/main.ts` and `electron/developer-tools.ts` for
`sources` purposes, but not all of their content.** Roughly a third of the main
process file is thin facades over modules other docs
own. If you changed the AI approval methods, the vault methods, or the update
methods, the doc to edit is [ai-consent.md](ai-consent.md), [vault.md](vault.md)
or [release-and-updates.md](release-and-updates.md) — this doc covers only their
wiring into IPC. See [Facades Owned by Other Docs](#facades-owned-by-other-docs).

**Neighbours.**

- **URL and text safety** → [security-boundary.md](security-boundary.md). Owns
  `normalizeNavigationInput`, `isAllowedRemoteUrl`, `isProtectedPage`, redaction.
- **The channel surface** → [ipc-contract.md](ipc-contract.md). Owns the table of
  the 40 channels this file registers and their payload types.
- **What survives a restart** → [workspaces-and-state.md](workspaces-and-state.md).
  Owns `WORKSPACES`, `PersistedState`, `sanitizeState`, the atomic save.
- **The React chrome** → [renderer-ui.md](renderer-ui.md). Owns App.tsx, its own
  second copy of the keyboard shortcuts, and the layout numbers it sends here.

### Invariants

1. **Hide every view before mutating the active tab or workspace.** Otherwise the
   outgoing page stays painted over the incoming one. → **Tabs and WebContentsView Lifecycle**
2. **Every state mutation ends in `broadcast()`.** It is the only push path; miss
   it and the UI shows a stale snapshot. → **Key Behaviors and Non-Obvious Patterns**
3. **Vault actions use Electron-derived context, never renderer authority.**
   Navigation, workspace changes and lock invalidate pending capabilities.
4. **Configure a session exactly once per partition.** A second registration
   double-counts downloads. → **Per-Workspace Sessions and Permissions**
5. **Register channels through `handle()`, never `ipcMain.handle` directly.** That
   wrapper is where the sender check lives. → **IPC Registration and the Trusted-Sender Check**
6. **A view may only ever reach http and https.** Three guards enforce it and all
   three must stay. → **Popups and Navigation Guards**

### Where to look

<!-- routing:start -->

| You are changing… | Section |
| --- | --- |
| the window size, title bar, preload path or dev/prod load | [Window and Chrome Renderer](#window-and-chrome-renderer) |
| opening, closing, activating or switching tabs | [Tabs and WebContentsView Lifecycle](#tabs-and-webcontentsview-lifecycle) |
| the address bar, a committed URL or a history row | [Navigation and History](#navigation-and-history) |
| where the page sits under the chrome | [Layout Maths](#layout-maths) |
| a shortcut that fires while focus is inside a page | [Keyboard Shortcuts](#keyboard-shortcuts) |
| the download list or opening a downloaded file | [Downloads](#downloads) |
| the tracker denylist or the shield toggle | [Tracker Blocking](#tracker-blocking) |
| an entry in the privacy timeline | [Privacy Log](#privacy-log) |
| cookie isolation, the user agent, or a permission request | [Per-Workspace Sessions and Permissions](#per-workspace-sessions-and-permissions) |
| window.open, target=_blank, or blocking a scheme | [Popups and Navigation Guards](#popups-and-navigation-guards) |
| startup, a second launch, or a link opened from outside | [Launch, Single Instance and Deep Links](#launch-single-instance-and-deep-links) |
| adding an IPC handler, or the sender check | [IPC Registration and the Trusted-Sender Check](#ipc-registration-and-the-trusted-sender-check) |
| an AI, vault or update method (usually: edit the other doc) | [Facades Owned by Other Docs](#facades-owned-by-other-docs) |
| anything that mutates state and must reach the UI | [Key Behaviors and Non-Obvious Patterns](#key-behaviors-and-non-obvious-patterns) |
| a bug here you cannot explain | [Gotchas](#gotchas) |

<!-- routing:end -->

### Before you write

- Read the section you are changing; `main.ts` has no internal module boundaries.
- Mutate state only through `this.store.update(...)`; `get()` hands back a clone.
- End any mutating method with `broadcast()`.
- Adding a channel means three edits in three files — see [ipc-contract.md](ipc-contract.md).
- Changing a layout number means changing it in App.tsx too; nothing checks.
- Do not add AI, vault or update logic here. Put it in its own module and leave a
  one-line facade.

## Overview

`main.ts` is a single `BrowserController` class plus an app bootstrap block at the
bottom. The controller holds all runtime browser state; the bootstrap owns the
single-instance lock, the four store constructions, the one-shot update
bootstrap, the 40 `handle()` registrations and the background update timers. There is no router, no event bus
and no dependency injection beyond the stores passed into the constructor.

## Window and Chrome Renderer

`createWindow()` builds the one and only `BrowserWindow`: 1500x940, minimum
1050x680, background `#0b0d12`, `titleBarStyle: 'hidden'` with a `titleBarOverlay`
39 px tall. The OS draws the window controls on top of the React chrome, which is
why the chrome reserves that strip itself.

- `show: false` plus a `ready-to-show` handler — no white flash on launch.
- `webPreferences`: preload resolved as `join(import.meta.dirname, 'preload.cjs')`,
  so it loads `dist-electron/preload.cjs`, next to the compiled `main.js`.
  `contextIsolation`, `sandbox` and `webSecurity` on, `nodeIntegration` off.
- `Menu.setApplicationMenu(null)` removes the default application menu — and with
  it every default accelerator. That is why Ctrl+L/T/W/R are hand-rolled.
- Dev versus packaged: `process.env.VITE_DEV_SERVER_URL` if set, otherwise a
  `file:` URL for `../dist/index.html` relative to the compiled main. A
  `will-navigate` guard pins chrome to that file or the configured dev origin.
- `setWindowOpenHandler(() => ({ action: 'deny' }))` on the chrome's own
  webContents. The React layer can never open a window.
- `resize` re-runs `applyLayout()`. `closed` closes every tab's webContents and
  clears `runtime.view`, which is what makes the macOS `activate` rebuild work.

## Tabs and WebContentsView Lifecycle

A tab has two halves. The persisted half lives in `StateStore` (id, workspaceId,
title, url, isHome). The runtime half lives in `runtimeTabs: Map<string, RuntimeTab>`
and holds the `WebContentsView` plus `loading`, `canGoBack`, `canGoForward`,
`favicon`, `developerToolsOpen`, and bounded developer diagnostic rings. The
constructor seeds one empty runtime entry per persisted tab, so none of that
runtime state survives a restart.
`getSnapshot()` merges the two halves for the wire.

**Views are lazy.** `ensureView(tabId)` builds the `WebContentsView` on first
navigate or first show. A tab still on `private://home` has no view at all, which
is why back, forward, reload and stop silently do nothing there.

`ensureView` also wires every per-view listener: the window-open handler, the
`will-navigate` guard, `did-start-loading` / `did-stop-loading`, `did-navigate`,
`did-navigate-in-page`, `page-title-updated` (which calls `event.preventDefault()`
so the OS window title never follows the page), `page-favicon-updated`,
`before-input-event`, and `render-process-gone` (which only clears `loading`).

Ordering matters in the three switchers:

- `newTab` calls `hideAllViews()` **before** pushing the tab and setting it active,
  then broadcasts, then navigates if a URL was given.
- `activateTab` and `switchWorkspace` both hide everything, update the store, then
  call `showActiveTab()`.

`closeTab` picks the successor as `siblings[Math.min(closedIndex, siblings.length - 1)]`,
removes the child view from `window.contentView`, closes its webContents, deletes
the runtime entry, and — if the workspace has no tabs left — calls
`newTab(tab.workspaceId)`.

`closeTab` is the **only** path that destroys a view. Switching workspaces hides
views; their webContents stay alive and keep running timers, media and network.

## Navigation and History

`navigate(value)` runs the raw address-bar string through
`normalizeNavigationInput` (bare host to https, localhost or IP to http, anything
else to a DuckDuckGo search — see [security-boundary.md](security-boundary.md)).

- `private://home` is a branch, not a load: it rewrites the tab record to the home
  state, hides the view without destroying it, broadcasts and returns.
- Anything that fails `isAllowedRemoteUrl` throws `Only HTTP and HTTPS pages are
  allowed`. Thrown errors cross IPC as a rejected `invoke` and surface as a toast.

`commitNavigation(tabId, url, addHistory)` is the single write path for a
committed URL:

- `did-navigate` calls it with `addHistory` defaulted to `true`.
- `did-navigate-in-page` calls it with `false`, and only for the main frame. SPA
  route changes therefore move the address bar but never write history.
- It re-checks `isAllowedRemoteUrl` before touching state.
- History is unshifted and sliced to 500 on write; `getSnapshot()` ships the
  newest 100.

`goBack`, `goForward`, `reload` and `stop` all route through `activeContents()`,
which returns `undefined` when the active tab has no view. Back and forward also
check `navigationHistory.canGoBack()` / `canGoForward()` first.

## Layout Maths

The main process holds one `Layout` for all tabs, defaulting to
`{ top: 158, left: 0, right: 366, bottom: 0 }`, matching the initially visible
bookmarks bar and the absence of a permanent left rail. The renderer then sends
the persisted 158 px or 128 px top inset, and reserves 366 px on the right while
the panel is open.

`setLayout` clamps before storing: `top` becomes `Math.max(80, Math.round(top))`,
the other three become `Math.max(0, Math.round(n))`.

`applyLayout()` positions only the **active** tab's view:

```
x      = left
y      = top
width  = max(100, contentWidth  - left - right)
height = max(100, contentHeight - top  - bottom)
```

It reads `window.getContentSize()`, so the numbers are content-area DIPs, not
screen pixels. It returns early when the active tab is home, has no view, or the
window is destroyed — the bounds are then applied by the next navigate or show.
Background views keep whatever bounds they last had; `showActiveTab` re-applies
before revealing one.

Callers: window `resize`, `navigate`, `showActiveTab`, `setLayout`.

## Keyboard Shortcuts

Registered per view via `before-input-event`, so these fire only when focus is
inside a page.

| Keys | Effect |
| --- | --- |
| Ctrl/Cmd+L | sends `browser:focus-address` to the chrome renderer |
| Ctrl/Cmd+T | `newTab()` in the current workspace |
| Ctrl/Cmd+W | `closeTab()` on the active tab |
| Ctrl/Cmd+R | `reload()` |
| Ctrl/Cmd+Shift+B | toggles and persists the bookmarks bar |
| F12 or Ctrl/Cmd+Shift+I | toggles Chromium DevTools for an allowed Development-workspace page |
| Alt+Left | `goBack()` |
| Alt+Right | `goForward()` |

The chrome window has its own separate copy of Ctrl+L/T/W/R and the DevTools shortcut in App.tsx — see
[renderer-ui.md](renderer-ui.md) and the Gotchas below.

`handleShortcut` accepts only `keyDown` and ignores auto-repeat, so one physical
shortcut produces one action.

## Developer Cockpit

`canUseDeveloperTools` is the shared main-process gate: the target must be a
non-home page in the Development workspace and must not match
`isProtectedPage`. `toggleDeveloperTools` applies that gate before opening
Chromium DevTools docked right, docked bottom, or detached. Leaving a tab or
workspace closes any open tools; committing a protected navigation does too.
The page context menu exposes exact `inspectElement(x, y)` only after the same
gate passes.

Each Development tab keeps bounded, process-memory-only rings of 100 console
warnings/errors and 100 failed or HTTP 4xx/5xx requests. Session web-request
listeners associate an issue with a tab by `webContentsId`. No collection is
performed in other workspaces or for protected targets.

`captureDeveloperDiagnostics` reads only document metadata and aggregate counts
(scripts, stylesheets, images, links, forms, iframes), then includes at most the
newest 50 entries from each ring. `developer-tools.ts` strips URL credentials,
queries and fragments, redacts high-entropy path segments and sensitive text,
and formats a self-contained debugging prompt. Page text, form values, cookies,
storage, headers and bodies are never read. `clearDeveloperDiagnostics` empties
the active tab's rings.

The Developer panel's VS Code features are a separate local trust boundary
documented in [vscode-bridge.md](vscode-bridge.md). Project and server actions
may run from Development Home so a server can be started before navigation;
page inspection and diagnostic capture still require a non-home, non-protected
target. Element selection uses an internal CDP session and never opens a remote
debugging port.

## Chrome Import and Bookmarks Bar

`listChromeProfiles`, `importChrome` and `importChromePasswords` are trusted IPC
facades over [chrome-import.md](chrome-import.md). `importChrome` merges records
without duplicating the same bookmark path/title/URL or history URL/timestamp,
refuses Banking as a target, persists the result and records a local-read event.
The password path uses the native file chooser and calls `VaultStore.addMany`;
CSV contents and filesystem paths never enter the renderer. `toggleBookmarkBar`
persists visibility and broadcasts so React can update both the bar and the view
inset.

## Downloads

`will-download` is registered per session inside `configureSession`. Each download
becomes a `DownloadEntry` in an in-memory `Map` keyed by a fresh `randomUUID()`:

- The same entry object is mutated in place by the item's `updated` and `done`
  listeners, and every mutation calls `broadcast()`, so the renderer sees live
  progress.
- Nothing calls `item.setSavePath()`, so Electron's own save behaviour applies.
- Banking-workspace downloads are cancelled before a file is written.
- `downloadRisk` marks executable/script extensions and deceptive double
  extensions. `openDownload(id)` requires state `completed` **and** a `savePath`,
  and refuses a risky file unless it is the checksum-verified app installer;
  `showDownload(id)` only requires a `savePath`.
- The map is never persisted and never pruned.

## Downloads — checksum verification

When a download completes, `verifyDownload` (
[download-verify.ts](../../electron/download-verify.ts)) compares it against the
manifest returned by the last `checkForUpdates`, remembered in
`expectedInstaller`.

- Only a download whose filename matches the expected installer is checked.
  Anything else returns `unchecked` — an unrelated file must never be reported as
  a failed verification.
- Size is compared before hashing, then SHA-256 over the file.
- `verified` and `mismatch` are written to `DownloadEntry.checksum`, surfaced in
  the downloads list, and logged to the privacy timeline.
- **`openDownload` throws on `mismatch`** rather than opening the file.

Before this, the service published a checksum and the download page printed it,
but nothing on this side ever compared it to the bytes that arrived — audit
finding F-13. The installer is unsigned, so this is the only tamper check between
the release service and the file the user runs.

## Favicons

`page-favicon-updated` does **not** hand the page's icon URL to the renderer.
`updateFavicon(tabId, ses, url)` fetches it with `ses.fetch` — the tab's *own*
session partition — and passes the renderer a `data:` URL it built itself.

- Only `http`/`https` URLs are fetched (`isAllowedRemoteUrl`); a `data:` favicon
  declared by the page is dropped rather than forwarded.
- Content type must be in `FAVICON_TYPES`; body must be non-empty and at most
  `MAX_FAVICON_BYTES` (32 KB). The icon travels inside every state broadcast, so
  the cap is about payload size as much as safety.
- A 5-second timeout, and a 200-entry URL cache so repeated navigations do not
  refetch.
- Failures are silent: a site without a reachable icon is ordinary.

**Why it is not just `<img src={page-chosen-url}>`.** The chrome `BrowserWindow`
declares no `session`, so it uses the default one — outside the tracker filter
and shared by all five workspaces. Rendering the page's URL directly let a site
hand out a per-visit icon URL and correlate activity across every workspace,
including Banking, with no approval and no privacy-log entry, while the toolbar
claimed tracker blocking was on. Audit finding F-07. Because the renderer now
only ever receives a `data:` URL, `img-src` in index.html no longer needs `https:`.

## Tracker Blocking

`TRACKER_HOSTS` is a curated denylist covering common advertising, analytics,
session-replay and retargeting providers. `onBeforeRequest` matches a request's
hostname exactly or as a `.suffix`, and cancels on a hit. Every request also
receives `DNT: 1` and `Sec-GPC: 1`.

- The toggle is persisted state, so it applies to every workspace at once.
- A URL that fails to parse is treated as not blocked.
- Blocked requests are cancelled silently: nothing is written to the privacy log
  and no counter is kept, so the shield button has no audit trail behind it.

## Privacy Log

`addPrivacyEvent(kind, title, detail)` unshifts an event, slices the log to 100
and broadcasts. `getSnapshot()` ships the newest 50. The four kinds are
`local-read`, `cloud-approved`, `blocked` and `vault`.

`vault` is the catch-all for anything credential-shaped — it is also used for AI
provider configuration and for connecting or disconnecting the download service,
not only for the password vault.

Every event is a full `store.update(...)`, which means a synchronous rewrite of
the whole state file per event.

## Per-Workspace Sessions and Permissions

`ensureView` derives the partition from the tab's workspace:
`persist:private-browser-${workspaceId}`. Five workspaces means up to five
persistent partitions, and cookies, storage and cache never cross one. This is
the isolation the workspace concept sells.

`configureSession(ses, partition, workspaceId)` returns immediately if `configuredSessions`
already holds the partition. That guard is load-bearing: the second tab in a
workspace reuses the same `Session` object, and without it `onBeforeRequest` and
`will-download` would be registered again and each download recorded twice.

What it configures, once per partition:

- **User agent** — the default string with any ` Electron/<version>` and
  ` Private Browser/<version>` token stripped out.
- **Permissions** — both handlers allow only top-frame `fullscreen` and
  `clipboard-sanitized-write` from HTTPS or localhost. Banking denies everything.
  Camera, microphone, geolocation, notifications and the rest are denied without
  prompting. The two handlers must keep agreeing:
  allowing something in one and not the other hands a page an API that fails when
  it is called.
- **Request filtering** — the tracker denylist above.
- **Downloads** — the `will-download` handler above.

## Popups and Navigation Guards

Three guards keep a view on http and https:

1. Per-view `setWindowOpenHandler(({ url }) => ...)` — outside Banking, an
   allowed URL becomes a sanitized `newTab(tab.workspaceId, url)` and the handler **always** returns
   `{ action: 'deny' }`. `window.open` and `target="_blank"` become tabs in the
   same workspace, never real windows and never a cross-workspace leak. The
   workspace id is captured in the closure when the view is built. Banking
   denies the popup completely.
2. Per-view `will-navigate` and `will-redirect` call `event.preventDefault()` on anything that fails
   `isAllowedRemoteUrl`, so a page cannot walk its own view to `file:`, `data:` or
   a custom scheme. They reload URLs after removing tracking parameters.
3. `commitNavigation` re-checks before writing the URL into state.

The chrome window's own `setWindowOpenHandler` denies unconditionally. Both
chrome and page views explicitly cancel `will-attach-webview`.

The `newTab` call inside the popup handler is fire-and-forget (`void`); a failure
there is not reported anywhere.

## Launch, Single Instance and Deep Links

- `pendingLaunchUrl` starts as the first `process.argv` entry that passes
  `isAllowedRemoteUrl`, so a cold start with a URL argument opens it.
- `app.requestSingleInstanceLock()` decides everything else. Without the lock the
  process calls `app.quit()` and registers no handlers; the whole
  `app.whenReady()` block is separately guarded by the same flag.
- `second-instance` takes the first allowed URL from the new command line, opens
  it as a tab in the current workspace, then calls `focus()` (restore if
  minimised, show, focus).
- `open-url` (macOS) calls `preventDefault()`, then either opens a tab or parks
  the URL in `pendingLaunchUrl` when the controller does not exist yet.
  `whenReady` consumes it after `createWindow()`.
- Default browser: `isDefaultBrowser()` requires **both** `http` and `https`;
  `setDefaultBrowser()` returns the AND of the two `setAsDefaultProtocolClient`
  calls.
- **Update bootstrap runs once, between the stores and the controller.** After
  the four stores are constructed, `whenReady` reads
  `private-browser-update.json` from `process.resourcesPath`, passes it to
  `updates.bootstrap(...)`, and deletes the file on success. The whole block sits
  in a `try/catch` that logs `update_bootstrap_invalid` and continues, so a
  malformed bundled config can never stop the app launching. Owned by
  [release-and-updates.md](release-and-updates.md).
- Background update checks run once 10 s after launch and then every 24 h. Both
  timers are `.unref()`ed so neither keeps the process alive.
- `window-all-closed` quits everywhere except darwin; `activate` rebuilds the
  window when none are left.
- `before-quit` calls `controller.flushClipboard()`, which clears a still-pending
  copied secret. Without it, quitting inside the 30-second window left a password
  on the clipboard — the auto-clear timer is `unref()`ed and so never fired. See
  [vault.md](vault.md#autofill-and-clipboard).

### The update bootstrap

`readUpdateBootstrap` runs once at startup against
`process.resourcesPath/private-browser-update.json`. Whatever happens — stored
successfully, rejected as invalid, or refused because `safeStorage` is
unavailable — `removeUpdateBootstrap` runs in a `finally`. Previously the file
was deleted only on success, so a machine without OS encryption kept a shared
download token readable in the install directory indefinitely (audit finding
F-15). Losing first-launch enrolment is the cheaper failure.

## IPC Registration and the Trusted-Sender Check

```ts
function handle(channel, callback) {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrusted(event);
    ipcGuard.check(event.sender.id, args);
    return callback(event, ...args);
  });
}
```

`assertTrusted` throws `Untrusted IPC sender` unless
`controller.isTrustedSender(event)` is true, which requires the window to exist,
not be destroyed, `event.sender === window.webContents`, and the sender frame to
be that webContents' main frame.

- Page views are created with no preload, so they have no `ipcRenderer` and cannot
  reach these channels at all. The sender check is the second layer, not the first.
- `IpcGuard` rejects payloads over 256 KiB and throttles a compromised trusted
  renderer after 300 calls in ten seconds.
- All 40 channels are registered **before** `createWindow()`. The renderer calls
  `getState()` on mount, so registration has to precede the page load.
- The wrapper body is `async`, so a synchronous `throw` inside any controller
  method becomes a rejected `invoke` in the renderer, which App.tsx turns into a
  toast. Several methods rely on that instead of returning an error value.

The full channel-to-method-to-type table is in
[ipc-contract.md](ipc-contract.md).

## Facades Owned by Other Docs

### Account Space runtime facade

`BrowserController` now delegates encrypted account records, v2 persistence,
Google clients, confirmations, permissions and backup to the modules documented
in [google-account-spaces.md](google-account-spaces.md). The shell owns their
integration with live `WebContentsView` instances: it resolves every view from
the account's main-process-only partition, restores only the active account,
keeps popups/favicons/downloads/history on the originating account, hides native
content below trusted overlays, and re-focuses the active page after a prompt.

Account lock closes views and operations. Account deletion additionally verifies
that Chromium cookies, cache and storage are cleared before metadata is removed.
Workspace policy is still authoritative: Banking denies before account grants,
and Development alone can open controlled DevTools.

These methods live in `main.ts` but their behaviour is documented elsewhere. What
this doc owns about them is the wiring: the channel each sits behind, the privacy
event each writes, and any shell-level decision embedded in them.

- **AI** → [ai-consent.md](ai-consent.md). `prepareAiPreview`, `approveAiPreview`,
  `askAi`, `getAiProvider`, `configureAiProvider`, `clearAiProvider`, the private
  `pruneAiCapabilities`, and the two capability maps `pendingAiPreviews` and
  `aiApprovals`.
- **Vault** → [vault.md](vault.md). `listVault`, `addVaultItem`, `removeVaultItem`,
  `resetCorruptVault`, `copyPassword`, `copyTotp`, `autofill`, and the private
  `copySensitiveValue` clipboard helper.
- **Updates** → [release-and-updates.md](release-and-updates.md).
  `getUpdateService`, `configureUpdateService`, `clearUpdateService`,
  `checkForUpdates`, `openUpdatePage`, `checkForUpdatesInBackground`.

Two shell-level details inside that last group belong here: `openUpdatePage`
hard-codes the `development` workspace for the download page, and
`checkForUpdatesInBackground` swallows every error on purpose so that only an
explicit `updates:check` surfaces one.

## Key Behaviors and Non-Obvious Patterns

- **`broadcast()` is the only push path.** A mutating method that forgets it leaves
  the UI on the previous snapshot until an unrelated event happens to fire.
- **`store.get()` returns a `structuredClone`.** Reading it and mutating the result
  does nothing; all writes go through `store.update(mutator)`.
- **A privacy event is written before the throw**, not after, on the AI
  protected-page path — the block is meant to be auditable even though the call
  fails.
- **Fire-and-forget calls**: `void this.newTab(...)` in the popup handler, in
  `second-instance` and in `open-url`; `void controller?.checkForUpdatesInBackground()`
  in both timers. Rejections in those paths are dropped.
- **`activeTab()` falls back twice**: the recorded active id, then the first tab in
  the workspace, then `tabs[0]`. It is typed as always returning a tab, which holds
  only because `sanitizeState` guarantees one tab per workspace — see
  [workspaces-and-state.md](workspaces-and-state.md).
- **`ensureView` uses non-null assertions** on both the runtime entry and the
  persisted tab. If the two ever diverge it throws rather than repairing.

## Related Systems

- [ipc-contract.md](ipc-contract.md) — the channel surface this file registers.
- [workspaces-and-state.md](workspaces-and-state.md) — what persists and what is
  discarded on load.
- [security-boundary.md](security-boundary.md) — every URL and text check called
  from here.
- [renderer-ui.md](renderer-ui.md) — the chrome that consumes the snapshot and
  sends the layout.
- [vault.md](vault.md), [ai-consent.md](ai-consent.md),
  [release-and-updates.md](release-and-updates.md) — the three facade groups.

## Gotchas

- **Three copies of the layout geometry must remain aligned.** App.tsx sends
  `{ top: 128, left: 0, right: sidebarOpen ? 366 : 0, bottom: 0 }`; the main
  process defaults to the open-panel form, and styles.css uses the same offsets.
  The renderer test guards these values; update all copies together.
- **The shortcuts are implemented twice.** `handleShortcut` here fires when focus is
  in a page; the `window` keydown listener in App.tsx fires when focus is in the
  chrome. Ctrl+L/T/W/R and DevTools exist in both, Alt+Left/Right only here, and App.tsx
  additionally guards Ctrl+R on the tab not being home. Add a shortcut in one place
  and it works only when focus happens to be there.
- **History rows carry the previous page's title.** `commitNavigation` runs on
  `did-navigate` and copies `tab.title`, which `page-title-updated` has not
  refreshed yet.
- **The request filter clones the whole state per request.** `onBeforeRequest` calls
  `this.store.get()`, which is a `structuredClone` of every tab, bookmark, history
  row and privacy event — once per subresource, per page, per workspace session.
- **Downloads are process-lifetime only.** They vanish on restart and the map has no
  eviction, so a long session accumulates entries that are re-serialised on every
  broadcast.
- **Closing the last tab of a workspace can move the user.** `closeTab` falls back
  to `newTab(tab.workspaceId)`, and `newTab` sets `activeWorkspaceId`. The
  `browser:close-tab` channel accepts any tab id; today the UI only offers the
  active workspace's tabs, so this is latent rather than reachable.
- **Hidden is not closed.** A workspace switch hides views and leaves their
  webContents running. Only `closeTab` destroys one.
