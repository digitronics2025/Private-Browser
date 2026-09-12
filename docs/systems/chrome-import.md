---
system: chrome-import
sources:
  - electron/chrome-importer.ts
verified_at: 1e9a38cd
---

# Chrome Import

> Last verified: 2026-09-12

## Agent Brief

**Scope.** `chrome-importer.ts` discovers local Google Chrome profiles and reads
bookmarks and browsing history into typed, sanitized records. It also parses a
user-selected Chrome password CSV for direct insertion into the encrypted Vault.
All work is local in the Electron main process; profile paths and secrets never
cross the preload bridge.

### Invariants

1. Only `Default` and `Profile N` directories discovered below Chrome's known
   per-platform user-data directory may be read; the renderer never supplies a
   filesystem path.
2. Imported URLs must pass `isAllowedRemoteUrl`, so `chrome:`, `file:`, `data:`
   and `javascript:` entries are dropped.
3. Password CSV contents never reach the renderer. The bridge returns counts and
   warnings only, and the caller writes accepted items directly to `VaultStore`.
4. History is queried from a temporary copy and the temporary directory is
   removed in `finally`, so Chrome's live SQLite database is never opened for
   writing.
5. Bookmark and history records are created with the explicitly selected opaque
   Account Space ID. The main process verifies that the ID belongs to the named
   non-Banking workspace, and deduplication includes the Account Space ID.

## Supported Data

- **Bookmarks:** reads Chrome's `Bookmarks` JSON, preserving bookmark-bar versus
  other-bookmarks placement, nested folder names and per-level source order.
  Empty folders are not represented because the app persists URL entries rather
  than folder nodes. The hard safety cap is 25,000 URL bookmarks.
- **History:** copies and opens the selected profile's `History` SQLite database
  read-only, selecting up to 10,000 newest visible URLs and converting Chrome's
  1601-based microsecond timestamps to ISO time.
- **Passwords:** parses Chrome Password Manager's CSV export, validates lengths
  and web URLs, and caps input at 5,000 credentials. Duplicate `(url, username)`
  pairs are skipped by `VaultStore.addMany`.

Cookies, sessions, payment cards, extensions, account tokens, search engines and
autofill profiles are not copied. The current product has no compatible storage
or runtime for most of them, and copying authentication state would violate the
browser's session-isolation boundary.

## Public Functions

- `listChromeProfiles(userDataDirectory?)` returns display-safe profile metadata.
- `readChromeProfile(...)` validates the profile id and non-Banking Account Space target,
  returning accepted bookmarks/history plus result counters.
- `parseChromeBookmarks(...)` and `parseChromePasswordCsv(...)` are pure parsers
  exported for unit tests.

## Related Systems

- [browser-shell.md](browser-shell.md) applies imports and reports local reads.
- [workspaces-and-state.md](workspaces-and-state.md) persists bookmarks/history.
- [vault.md](vault.md) encrypts imported passwords.
- [renderer-ui.md](renderer-ui.md) owns the import wizard and bookmarks bar.
