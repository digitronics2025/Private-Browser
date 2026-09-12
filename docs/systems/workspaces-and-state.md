---
system: workspaces-and-state
sources:
  - electron/state-store.ts
verified_at: fd870404
---

# Workspaces and Persisted State

> Last verified: 2026-09-12

## Agent Brief

**Scope.** [state-store.ts](../../electron/state-store.ts) defines the five
workspaces and owns everything that survives a restart: the on-disk
`browser-state.json`, the atomic save, and the validation that runs when it is
read back. It is the only place in the app that writes plain-text state to disk.

**This doc does not cover the encrypted stores.** The vault, the AI provider and
the download service each keep their own `safeStorage`-encrypted file and are
documented in [vault.md](vault.md), [ai-consent.md](ai-consent.md) and
[release-and-updates.md](release-and-updates.md).

**Neighbours.**

- **Who reads and mutates this state** → [browser-shell.md](browser-shell.md).
- **The wire shape versus the disk shape** → [ipc-contract.md](ipc-contract.md).
- **`isAllowedRemoteUrl`, used as the URL filter here** →
  [security-boundary.md](security-boundary.md).

### Invariants

1. **Every workspace always has at least one tab.** `sanitizeState` backfills, and
   `activeTab()` in the shell is typed as never failing because of it. →
   **sanitizeState**
2. **The saved file is replaced, never edited in place.** Write to `.tmp`, then
   rename. → **StateStore**
3. **Anything unreadable becomes defaults, silently.** There is no migration and
   no recovery. → **Corrupt or Unreadable State**
4. **A URL only persists if it is http or https, or the literal home marker.** →
   **sanitizeState**

### Where to look

<!-- routing:start -->

| You are changing… | Section |
| --- | --- |
| adding, renaming or recolouring a workspace | [The Five Workspaces](#the-five-workspaces) |
| what banking is and is not allowed to do | [What the Protected Flag Gates](#what-the-protected-flag-gates) |
| a field that must survive a restart | [PersistedState](#persistedstate) |
| what a brand-new install starts with | [createDefaultState](#createdefaultstate) |
| how and when state reaches disk | [StateStore](#statestore) |
| a validation rule, cap or filter applied on load | [sanitizeState](#sanitizestate) |
| a user who lost their tabs or bookmarks | [Corrupt or Unreadable State](#corrupt-or-unreadable-state) |
| state that vanished or was silently trimmed | [Gotchas](#gotchas) |

<!-- routing:end -->

### Before you write

- Never bump `version` without writing a migration first; the load path deletes
  everything it does not recognise.
- Adding a workspace is two files: the union in `types.ts` and the array here.
- Runtime caps are the caller's job — `sanitizeState` only runs on load.
- Do not put secrets in this file. It is plain JSON.

## Overview

`state-store.ts` is two exported values and one class: the `WORKSPACES` constant,
`createDefaultState()`, `sanitizeState()`, and `StateStore`, which is constructed
once in `main.ts` against
`join(app.getPath('userData'), 'browser-state.json')`. Everything is synchronous.

## The Five Workspaces

`WORKSPACES` is a plain exported array, in sidebar order.

| id | name | colour | icon | protected |
| --- | --- | --- | --- | --- |
| `digitronics` | Digitronics | `#5b8cff` | `D` | no |
| `tenten` | TenTen | `#ffbd59` | `T` | no |
| `development` | Development | `#a78bfa` | `</>` | no |
| `personal` | Personal | `#4fd1a5` | `P` | no |
| `banking` | Banking | `#ff6b7a` | `$` | **yes** |

- The id set is duplicated as the `WorkspaceId` union in
  [types.ts](../../electron/types.ts). Adding a workspace means editing both.
- There is no lookup map. Every membership test in the app is
  `WORKSPACES.some((item) => item.id === candidate)`, and every lookup is a
  `.find(...)`.
- Order matters twice: it is the sidebar order, and `createDefaultState` mints
  the default tabs in it.
- The whole array is shipped to the renderer inside every `BrowserSnapshot`, so
  the renderer never imports this file.

## What the Protected Flag Gates

`protected: true` on `banking` gates exactly **one** behaviour, in `main.ts`:

```ts
if (workspace.protected || isProtectedPage(tab.url)) {
  this.addPrivacyEvent('blocked', 'AI access blocked', `Protected page: ${tab.title}`);
  throw new Error('AI access is disabled for protected and banking pages');
}
```

The check sits at the top of `prepareAiPreview`, so no page in the banking
workspace can ever be read for the assistant — the privacy event is written first
and the call then fails. See [ai-consent.md](ai-consent.md).

It gates nothing else. There is no separate session, no different permission set,
no download restriction, no history exclusion and no vault rule attached to the
flag. The banking workspace's isolation comes from having its own session
partition, which every workspace has.

The renderer reads it once, to draw a padlock in place of the workspace icon —
see [renderer-ui.md](renderer-ui.md).

## PersistedState

Declared in [types.ts](../../electron/types.ts); this is the entire on-disk shape.

| Field | Type | Notes |
| --- | --- | --- |
| `version` | `1` | a literal type; the load path rejects any other value |
| `activeWorkspaceId` | `WorkspaceId` | which workspace the window opens on |
| `tabs` | `Array<Pick<BrowserTab, 'id' \| 'workspaceId' \| 'title' \| 'url' \| 'isHome'>>` | the `Pick` is where the persist/runtime split is declared |
| `activeTabByWorkspace` | `Partial<Record<WorkspaceId, string>>` | declared partial, always complete after a load |
| `bookmarks` | `Bookmark[]` | Chrome-compatible bar/other placement, folder path and order metadata |
| `history` | `HistoryEntry[]` | newest first |
| `privacyLog` | `PrivacyEvent[]` | newest first |
| `trackerBlocking` | `boolean` | one global toggle, not per workspace |

`loading`, `canGoBack`, `canGoForward` and `favicon` are deliberately excluded by
the `Pick`: they belong to the live `WebContentsView` and are rebuilt empty on
every launch. Nothing about downloads is persisted at all.

## createDefaultState

Builds a fresh state with one home tab per workspace, each with its own
`randomUUID()`:

- `activeWorkspaceId` is `'digitronics'`.
- `activeTabByWorkspace` is built from those tabs with `Object.fromEntries(...)`
  and cast `as Record<WorkspaceId, string>` — that cast is what reconciles the
  complete object with the `Partial` type on the field.
- `bookmarks`, `history` and `privacyLog` start empty; the bookmarks bar starts visible.
- `trackerBlocking` starts `true`. Tracker blocking is on by default.

It is called from two places: the load fallback, and `sanitizeState`, which uses
it as a source of replacement tabs.

## StateStore

```ts
constructor(private readonly filePath: string) { this.state = this.load(); }
get(): PersistedState { return structuredClone(this.state); }
update(mutator): PersistedState { mutator(this.state); this.save(); return this.get(); }
```

- **`get()` hands back a deep clone.** Callers cannot mutate the live state by
  accident, and every call pays a full copy. `main.ts` calls it inside the network
  request filter, which is where that cost shows up — see
  [browser-shell.md](browser-shell.md).
- **`update()` is the only write path.** It mutates the live object, saves, and
  returns a fresh clone. There is no batching, no debounce and no async: one
  `update` is one complete JSON serialise, one file write and one rename, on the
  main-process thread.

`save()`:

1. `mkdirSync(dirname, { recursive: true })` — the directory is created on every
   save, not once.
2. `writeFileSync` to a sibling `.tmp` path with
   `JSON.stringify(state, null, 2)` and `{ mode: 0o600 }` — pretty-printed with a
   two-space indent, so the file is several times larger than it needs to be.
3. `renameSync(tmp, filePath)` — the replacement is atomic, so a reader never sees
   a half-written file.

`mode: 0o600` is applied by the underlying `open()` when the temporary file is
created. The only packaging target is Windows (`electron-builder --win nsis`),
where that POSIX mode is not enforced; what actually protects the file there are
the ACLs it inherits from `app.getPath('userData')`.

## sanitizeState

Runs on load, after the version check, over whatever `JSON.parse` returned. Every
rule in one place:

| What | Kept | Otherwise |
| --- | --- | --- |
| a tab | `workspaceId` in `WORKSPACES` **and** `typeof id === 'string'` **and** url is `private://home` or passes `isAllowedRemoteUrl` | dropped |
| tab count | the first 100 after filtering | the rest dropped |
| `tab.title` | a string, truncated to 500 characters | replaced with `'New tab'` |
| `tab.isHome` | `true` when the url is the home marker, else `Boolean(tab.isHome)` | — |
| empty workspace | a fresh default home tab is appended | — |
| `activeTabByWorkspace` | the requested id, only if a surviving tab has it **and** belongs to that workspace | that workspace's first tab |
| `activeWorkspaceId` | if it is in `WORKSPACES` | `'digitronics'` |
| a bookmark | valid workspace and remote URL; first 25,000; legacy rows gain bar placement and order defaults | dropped, or `[]` if not an array |
| a history entry | valid workspace and remote URL; first 10,000 | dropped, or `[]` if not an array |
| a privacy event | `Array.isArray` only; first 100 | `[]` if not an array |
| `trackerBlocking` | `input.trackerBlocking !== false` | anything that is not literally `false` reads as on |

Two ordering details that are easy to miss:

- The tab filter runs **before** the per-workspace backfill, and the backfill
  takes its replacement from the `defaults` object created inside this same call.
  A backfilled tab therefore gets a brand new id every time it is backfilled.
- `activeTabByWorkspace` is rebuilt from scratch for all five workspaces after the
  backfill, so it can never point at a tab that no longer exists.

Privacy events are the one collection whose **items** are not validated at all —
only the array-ness and the length. A persisted event with an unknown `kind`
reaches the renderer as-is.

## Corrupt or Unreadable State

One `try`/`catch` covers the read, the parse, the version check and the whole of
`sanitizeState`:

```ts
try {
  const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as PersistedState;
  if (parsed.version !== 1 || !Array.isArray(parsed.tabs)) throw new Error('Unsupported state');
  return sanitizeState(parsed);
} catch {
  return createDefaultState();
}
```

A missing file, unreadable bytes, malformed JSON, a wrong `version`, a non-array
`tabs`, or any throw inside `sanitizeState` all land in the same branch: the app
starts with defaults.

- Nothing is preserved, nothing is logged, and the renderer is never told.
- The next `update()` — a navigation, a title change, a privacy event — overwrites
  the unreadable file, so the evidence is gone within seconds of launch.
- This is deliberately unlike the vault, which raises a `vault-corrupt` reason
  through `vault:list` and keeps the unreadable file as a backup when reset. See
  [vault.md](vault.md).

## Related Systems

- [browser-shell.md](browser-shell.md) — the only consumer; every mutation goes
  through `store.update(...)`.
- [ipc-contract.md](ipc-contract.md) — `PersistedState` versus the
  `BrowserSnapshot` the renderer sees.
- [security-boundary.md](security-boundary.md) — `isAllowedRemoteUrl`, the URL
  filter used three times here.
- [renderer-ui.md](renderer-ui.md) — draws the workspaces and the padlock.

## Gotchas

- **There is no migration path.** `version !== 1` discards the file. Shipping a
  version 2 without writing a migration first wipes every user's tabs, bookmarks
  and history on their next launch, with no warning and no backup.
- **`sanitizeState` runs on load, never on save.** Runtime paths therefore carry
  their own caps: navigation keeps 10,000 history rows, Chrome import refuses to
  exceed 25,000 bookmarks/10,000 history rows, and the privacy log keeps 100.
- **The same `slice(0, n)` means opposite things.** Tabs are `push`ed, so slicing
  keeps the oldest 100 and drops the newest. Bookmarks, history and privacy events
  are `unshift`ed, so slicing keeps the newest and drops the oldest.
- **`sanitizeState(input: PersistedState)` types its input as already valid**,
  which is the one thing it cannot be. The `typeof tab.id === 'string'` and
  `Array.isArray` checks exist because the annotation is a lie about what
  `JSON.parse` returns — and everything the checks do not cover
  (`bookmark.title`, `history.visitedAt`, every field of a privacy event) is
  trusted verbatim.
- **A crash between write and rename leaves a `browser-state.json.tmp`.** Nothing
  reads it and nothing cleans it up.
- **Every state change is a synchronous whole-file write.** A page title update, a
  navigation, a privacy event — each one re-serialises and rewrites the entire
  file on the main-process thread. A busy page can trigger several per second.
- **`isHome` and the URL can disagree.** A persisted tab with a real URL and
  `isHome: true` keeps both, and the shell then skips loading it on show.
- **Adding a workspace touches two files.** Miss the `WORKSPACES` entry and the
  code still typechecks while every `WORKSPACES.some(...)` guard silently rejects
  the new id at runtime.
