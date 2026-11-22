---
system: side-apps
sources:
  - electron/side-apps.ts
  - electron/side-app-registry.ts
verified_at: 028b9d2d
---

# Side Apps (Claude and Notes)

> Last verified: 2026-10-11

## Agent Brief

The Notes panel reports the service's access mode when the library is ready.
It labels personal mode as shared and protected mode as requiring sign-in.
Notes separately reports local drafts, pending changes and sync status.

**Scope.** A trusted web app shown in the side panel next to the page, the way
Chrome shows an extension's side panel. **Claude** (`https://claude.ai/new`) and
**Notes** (the existing Easy Copy Notes app,
`https://easy-copy-notes.digitronics-electro.workers.dev/?surface=browser`) use
the same host. Notes loads the real app and retains its IndexedDB, service
worker, CRUD, templates, backup and synchronization; the shell owns no library. The pure rules — which apps exist, where each may
navigate, where its view may sit — are in
[side-app-registry.ts](../../electron/side-app-registry.ts); the native view,
its session and its guards are `SideAppHost` in
[side-apps.ts](../../electron/side-apps.ts). `electron/main.ts` only wires it
(owned by [browser-shell.md](browser-shell.md)); the panel is
`src/panels/SideAppPanel.tsx` (owned by [renderer-ui.md](renderer-ui.md)).

**Why not Chrome extensions.** The browser has no extension runtime, and the
Claude extension could not run in one: it needs Chrome's `sidePanel` and
`debugger` APIs, which Electron does not implement. A side app gives the same
"Claude beside the page" without letting third-party code reach pages. It
cannot see or act on the page; see [follow-ups.md](../follow-ups.md).

### Invariants

1. **A side app is a hostile remote page.** No preload, no Node, sandboxed,
   context-isolated — the same `webPreferences` as a tab. Pinned by
   `tests/side-apps.test.ts`.
2. **It never reaches a tab.** Its own partition
   (`persist:private-browser-side-app-<id>`), shared across unprotected workspaces, distinct from Claude and
   every Account Space; no API reads, scripts or captures another view.
3. **It stays on its own hosts.** `isSideAppUrl`: HTTPS, and a host in the app's
   list (a leading dot admits subdomains). Anything else leaves as a tab.
4. **It never sits over the chrome or the page.** `clampSideAppBounds` fits the
   renderer's rectangle inside the right inset strip, below `MIN_CHROME_TOP`.
5. **Off in Banking.** Hidden while a protected workspace is active, and a link
   from it never opens a Banking tab.

## Layout and visibility

The renderer measures `.side-app-slot` (ResizeObserver, window `resize`, and
`animationend`/`transitionend` — the panel slides in 16 px, and a slot measured
mid-slide stays 16 px off because a transform never fires the observer) and
sends it over `side-app:set-bounds`; `null` when the panel unmounts or the
workspace is protected. `BrowserController.layoutSideApps()` hands the host the
current insets and content size with `suppressed` = overlay open (a menu or
dialog, including a panel resize drag) **or** window full screen **or** a
protected workspace. It runs from `applyLayout` (before its Home early return),
`showActiveTab`, `setOverlayOpen` and `setSideAppBounds`.

The view is created on first show and then only hidden, so ordinary app state
and unsaved drafts survive closing or switching tools. Persistent storage
survives restart; application draft recovery remains owned by the app. Only
the selected, open tool can be visible, enforced from main-process preferences
even if a stale rectangle arrives. Panel selection and 320–520px width persist. Hiding a focused view returns focus to the chrome.
While hidden, the slot shows a placeholder mark.

## Navigation, popups and links

- `will-navigate`: non-web schemes are refused; a URL off the app's hosts is
  refused and opened as a tab (`openInTab`); tracking parameters are stripped.
- `will-redirect` off the hosts is refused and logged as `blocked`.
- `window.open`: at most 5 per 10 s. A focused `new-window` request for one of
  the app's own hosts (a sign-in window) gets a real popup via
  `popupWindowResponse`/`adoptPopupWindow` from
  [popup-windows.ts](../../electron/popup-windows.ts); everything else becomes a tab.
- `openFromSideApp` (main) opens a foreground tab in the active Account Space,
  or logs "Link blocked in Banking" and does nothing.
- Right-click offers Open link in new tab, Cut/Copy/Paste and Select all.
- Browser shortcuts (Ctrl+T, Ctrl+L …) work from inside the panel through
  `handleShortcut`.

Claude's list: `claude.ai`, `.claude.ai`, `anthropic.com`, `.anthropic.com`,
`accounts.google.com`, `appleid.apple.com` (sign-in round trips).

Notes allows only `easy-copy-notes.digitronics-electro.workers.dev`; no
workers.dev wildcard or authentication hosts are needed in personal mode.

## Session policy

Configured once per partition: permissions allow only
`clipboard-sanitized-write` from a main frame on the app's hosts (no camera,
microphone, notifications, location or screen); display capture is refused; the
tracker denylist and `DNT`/`Sec-GPC` headers apply as for tabs. Downloads save
through the native dialog when `downloadRisk` is `ordinary`; programs and
disguised files are cancelled and logged. Side-app downloads do not appear in
the Files panel.

## Channels and state

| Channel | Arguments | Effect |
| --- | --- | --- |
| `side-app:set-bounds` | `id`, `{x,y,width,height}` (0–16000) or `null` | place or hide |
| `side-app:command` | `id`, `back`/`forward`/`reload`/`home`/`open-in-tab` | `reload` of a crashed or empty view loads home; `open-in-tab` opens the current app URL (or home) as a tab |
| `side-app:clear-data` | `id` | closes the view, clears storage, cache and auth cache, logs "Claude signed out" or "Local Notes data cleared" (`vault` event) |

`BrowserSnapshot.sideApps` carries `{ id, name, status, canGoBack,
canGoForward }`; status is `idle`, `loading`, `ready`, `failed` (main-frame load
error other than `-3`) or `crashed`.

Tests: `PRIVATE_BROWSER_E2E_SIDE_APP_URL` (Claude) and
`PRIVATE_BROWSER_E2E_NOTES_URL` (Notes) replace their home URLs and host lists
(plain HTTP is admitted only for a loopback host), honoured only when
`!app.isPackaged`. `tests/electron/side-app.spec.ts` covers placement, isolation,
links, Banking, menus, full screen, tool switching, restart and partition-local
clearing against isolated local stand-ins. Native tests require a desktop and
OS-backed encryption; renderer preview tests cannot verify native views.

## Claude excerpts

Select text on a regular webpage, then choose **Copy approved excerpt for
Claude** in the browser menu. The preview has the exact redacted text and the
source origin. The selected page and Account Space must still match when
copying. Cancel and expiry discard the approval. The app copies text to the
guarded clipboard for 30 seconds. The user pastes and sends it in Claude.
Banking, protected pages and Google service pages are excluded.

## Notes workflow and data

Open **Notes** from the side-panel tabs or browser menu, or toggle with
**Ctrl+Shift+Y** (Cmd+Shift+Y on macOS). Opening focuses its tool tab; Tab reaches
controls and the native page. Search, select a language/variant, expand previews,
then **Copy** or **Fill & Copy**. Click the webpage and paste normally. Copy
preserves whitespace, Arabic, Unicode and emoji. Reload retries failures and
crashes; **Library home** returns to the app's library; **Open in new tab** uses
an ordinary Account Space session with separate local storage.

**Clear local Notes data** requires confirmation: only this panel's partition
is cleared, cloud records remain, and unsynced changes/drafts can be lost. Export
from the app's **Library options → Backup & Restore** beforehand. Closure,
workspace switches, reloads and updates never clear it. Existing cloud sync may
rehydrate cloud records after clearing; cookies and IndexedDB are never copied
between panel and tabs.

`surface=browser` affects only presentation: compact Library header, smaller
outer spacing, no PWA installation controls, and a home link preserving the
query. Authentication, owner identity, API behavior, permissions and storage are
unchanged. The app caches its own shell and uses local IndexedDB offline after
initial loading. CSP and frame protections remain unchanged.

Production requires sign-in. Personal mode is shared and labelled as such.
Local Notes storage uses IndexedDB in the panel partition.

Use **Search Notes**, **Favorites**, or **Recent** to find a note. The library
search accepts `lang:darija` and `tag:delivery`. **Export Notes** opens its existing backup
screen. The clear confirmation reports the latest sync time and local work to
preserve before clearing.

On an ordinary page, select visible text and choose **Save selected text to
Notes…** in the context menu. Review the bounded excerpt and whether to include
its source site. **Open Notes draft** passes the edited text to the pinned Notes
view. Choose **Create Snippet** there to add it to the library. **Copy excerpt**
is a separate action. The browser refuses protected pages, form controls,
child frames and stale selections. It sends neither clipboard contents nor note
text to Claude or an AI provider.

## Adding an app

Add its id to `SideAppId`/`SIDE_APP_IDS`, a `SIDE_APPS` entry, a side panel
tool in `ui-preferences.ts` and `SIDE_PANEL_TABS`, and a `case` in App.tsx's
panel switch. Channels already take the id.

## Gotchas

- A Cloudflare challenge response shows a prompt to complete the check in the
  side panel. Sign-in routes show a separate hint.
- **Sign-in providers other than Google, Apple and email codes** (company SSO)
  redirect off the allowlist and are refused. The fallback opens the app home
  in the active regular Account Space. Load failures and crashes offer Retry.
- The chrome's screenshots never include the native view; capture its
  `webContents` instead.

For the real notes library in Electron, start the sibling Easy Copy Notes local
Worker after its build and local migrations, then run:

```sh
PRIVATE_BROWSER_E2E_NOTES_WORKER_URL=http://127.0.0.1:8787 npx playwright test --config playwright.electron.config.ts tests/electron/notes-library.spec.ts
```

This supplementary harness uses the production SideAppHost in native Electron
and a local D1 library, with exact clipboard readback from main, real paste,
template filling, backup import/export and offline reload. It does not replace
full-browser tests for Banking, overlay/layout, IPC, Account Spaces or restart.
The optional test is skipped without a loopback HTTP Worker URL.
