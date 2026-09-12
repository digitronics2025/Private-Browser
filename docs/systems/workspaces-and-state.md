---
system: workspaces-and-state
sources:
  - electron/state-store.ts
  - electron/account-space-state.ts
  - electron/runtime-state-store.ts
verified_at: 7063e89
---

# Workspaces and Persisted State

> Last verified: 2026-09-12

## Agent Brief

The five fixed workspaces are security and purpose boundaries. Dynamic Account
Spaces sit beneath them and own browser sessions and browsing records. Read
[google-account-spaces.md](google-account-spaces.md) before changing persistence,
migration, recovery, or account membership.

`state-store.ts` defines the workspace catalogue and validated legacy version-1
format used as migration input. Runtime version-2 persistence is owned by
`AccountSpaceStateStore` and `RuntimeStateStore`; new code must not write v2 data
into `browser-state.json`.

## Workspace policy

| Workspace | Purpose | Special policy |
| --- | --- | --- |
| Digitronics | business | standard isolated browsing |
| TenTen | business | standard isolated browsing |
| Development | engineering | controlled Chromium DevTools and VS Code bridge |
| Personal | personal | standard isolated browsing |
| Banking | financial | denies AI, DevTools, permissions, popups and downloads |

Workspace policy applies to every Account Space it owns. Moving an Account Space
between workspaces is unsupported; opening or moving a link requires an explicit
destination account already in the intended workspace.

## Version-1 compatibility

`PersistedState` version 1 contains active workspace, tabs, active tab per
workspace, bookmarks, history, privacy log, tracker preference, and bookmark-bar
visibility. URLs are limited to HTTP(S) or `private://home`; collections are
capped and each workspace is repaired to at least one tab.

On first Account Spaces launch, the exact original file remains in place and a
timestamped byte-identical backup is created. One encrypted default Account Space
per workspace retains the original `persist:private-browser-<workspaceId>`
partition and receives all surviving records for that workspace. Bookmark folder,
ordering, and bar-location metadata are retained. The active workspace and tab
are preserved.

Unknown or corrupt v2 data never falls back to defaults. It opens read-only
recovery and preserves evidence before any confirmed restore or fresh start.

## Version-2 plaintext boundary

The manifest contains opaque UUID references, active selection, tracker and
bookmark-bar preferences, and the privacy log. Per-account browsing files contain
URLs, titles, bookmark hierarchy, and history plus workspace/account IDs. They do
not contain email, display name, Google subject, partition key, OAuth data,
permission grants, or descriptive account metadata. Those fields live in
independent `safeStorage`-encrypted account records.

Chrome bookmark and history import requires an explicit non-Banking Account Space
destination. Imported records carry that account ID at creation, and duplicate
detection includes it, so one account cannot suppress or expose another account's
records. Password CSV import is separate and goes directly to My Vault.

The privacy log remains local plaintext and must never contain secrets or model
input. Banking does not write ordinary browsing history.

## Invariants and gotchas

- Every workspace has at least one account and every account has at least one tab
  after validation.
- Tab IDs are globally unique; malformed duplicates are discarded before
  `BrowserController` can map a tab ID to a live `WebContentsView`.
- A manifest is written last during migration and atomically replaced on updates.
- Migration IDs are stable for a source fingerprint, so a retry cannot create a
  second set of legacy partitions.
- Only opaque IDs cross the plaintext manifest/renderer boundary; partition names
  resolve exclusively in the main process.
- The bookmark bar filters by both workspace and active Account Space.
- Do not remove `state-store.ts`: it remains the v1 parser and workspace source of
  truth until the supported migration window is intentionally retired.

## Related Systems

- [google-account-spaces.md](google-account-spaces.md) — encrypted records,
  recovery, and per-account partition lifecycle.
- [chrome-import.md](chrome-import.md) — local import bounds and exclusions.
- [browser-shell.md](browser-shell.md) — runtime navigation and tab views.
- [ipc-contract.md](ipc-contract.md) — renderer-visible snapshots and commands.
