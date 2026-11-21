---
system: chrome-import
sources:
  - electron/chrome-importer.ts
verified_at: dcd6823a
---

# Chrome Import

Settings also accepts standard Netscape bookmark HTML exported by a browser.
The import reads a local file of up to 16 MB into the active regular Account
Space. Toolbar placement and nested folder names are kept. Exact duplicates
and unsupported addresses are counted as skipped.

The Chrome profile flow shows the destination, folder counts, history dates
and skip reasons before any records are saved. Confirmation spends that exact
preview and requires a new review if the destination or accepted records
change. Undo is available for the latest import into each Account Space during
the session. Existing browsing data and edited bookmarks stay.

> Last verified: 2026-11-21

## Agent Brief

**Scope.** `chrome-importer.ts` discovers local Google Chrome profiles and reads
bookmarks and browsing history into typed, sanitized records. Password CSV rows
are handed directly to the trusted MyVault migration/import service.
All work is local in the Electron main process; profile paths and secrets never
cross the preload bridge.

### Invariants

1. Only `Default` and `Profile N` directories discovered below Chrome's known
   per-platform user-data directory may be read; the renderer never supplies a
   filesystem path.
2. Imported URLs must pass `isAllowedRemoteUrl`, so `chrome:`, `file:`, `data:`
   and `javascript:` entries are dropped.
3. Passwords, notes, and the selected CSV path stay in main. The review returns
   counts and bounded skip metadata. Approved logins are written by `VaultBroker`.
4. History is queried from a temporary copy and the temporary directory is
   removed in `finally`, so Chrome's live SQLite database is never opened for
   writing.
5. Bookmark and history records are created with the explicitly selected opaque
   Account Space ID. The main process verifies that the ID belongs to the named
   non-Banking workspace, and deduplication includes the Account Space ID.
6. Bookmark size validation and reading use one open file descriptor, so a path
   swap cannot change the file between validation and parsing. History and its
   optional WAL/SHM sidecars are copied directly and tolerate only `ENOENT`.

## Supported Data

- **Bookmarks:** reads Chrome's `Bookmarks` JSON, preserving bookmark-bar versus
  other-bookmarks placement, nested folder names and per-level source order.
  A nameless Chrome bookmark imports with an empty title (not its URL), so the
  bar shows it as an icon alone, as Chrome does.
  Empty and nested folders stay in their destination Account Space. Import limits
  are 25,000 bookmarks, 5,000 saved folders and 20 folder levels. The bookmark
  manager can create folders, move bookmarks or whole folders, and choose a
  folder when saving the current page. Shift-click the star to open the folder
  chooser. On the bar, Shift+Alt+Left or Right reorders the focused item.
- **History:** copies and opens the selected profile's `History` SQLite database
  read-only, selecting up to 10,000 newest visible URLs and converting Chrome's
  1601-based microsecond timestamps to ISO time.
- **Passwords:** the wizard explains Chrome export, previews the selected CSV,
  and shows skips by reason. Main limits the file to 20 MB and accepts up to
  5,000 candidate logins. It preserves password whitespace. Confirm rechecks
  the exact file and the unlocked vault. Duplicates by origin and username are
  skipped. New logins are written in one encrypted save. The wizard explains
  how to remove the plaintext CSV after verifying the import.
  [Chrome export instructions](https://support.google.com/chrome/answer/13068232)

The setup guide suggests a destination when the profile name matches one
unlocked Account Space in the current workspace. Confirm an existing destination
or create one before previewing. The local import receipt prevents importing
the same profile again after restart. The preview can separately include a
supported search preset, Home and startup preferences for the destination
workspace. A concurrent settings edit requires a fresh preview.

Cookies, sessions, payment cards, extensions, account tokens and autofill
profiles stay in Chrome. Keeping authentication state outside the import
preserves browser session isolation.

The Setup guide includes an add-on checklist. Match each Chrome add-on to its
task, test the browser's own MyVault, Privacy or Developer tools when they fit,
and keep Chrome for tasks that still require an add-on. Electron supports a
subset of extension APIs. [Electron extension support](https://www.electronjs.org/docs/latest/api/extensions)

## Public Functions

- `listChromeProfiles(userDataDirectory?)` returns display-safe profile metadata.
- `readChromeProfile(...)` validates the profile id and non-Banking Account Space target,
  returning accepted bookmarks/history plus result counters.
- `parseChromeBookmarks(...)` and `describeChromePasswordCsv(...)` are pure
  parsers. The password parser counts unsupported origins and invalid rows.

## Related Systems

- [browser-shell.md](browser-shell.md) applies imports and reports local reads.
- [workspaces-and-state.md](workspaces-and-state.md) persists bookmarks/history.
- [vault.md](vault.md) encrypts imported passwords.
- [renderer-ui.md](renderer-ui.md) owns the import wizard and bookmarks bar.
