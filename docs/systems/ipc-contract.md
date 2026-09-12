---
system: ipc-contract
sources:
  - electron/preload.cts
  - electron/types.ts
  - electron/ipc-guard.ts
verified_at: a632cc6d
---

# IPC Contract

> Last verified: 2026-09-12

## Agent Brief

**Scope.** The whole surface between the Electron main process and React,
including Chrome import, metadata-only `vault:*` intents, `vault:state`, other
subscriptions and every shared payload type. Defined in
[preload.cts](../../electron/preload.cts) and
[types.ts](../../electron/types.ts).

**This doc does not cover what the handlers do.** The main-process side of every
channel lives in [browser-shell.md](browser-shell.md) (registration, the
trusted-sender check, the browser methods) and in [vault.md](vault.md),
[ai-consent.md](ai-consent.md) and
[release-and-updates.md](release-and-updates.md) for the three facade groups.

**Neighbours.**

- **Who registers these channels** → [browser-shell.md](browser-shell.md).
- **Who calls them** → [renderer-ui.md](renderer-ui.md).
- **`ReleaseManifest` on the server side** → [release-and-updates.md](release-and-updates.md).

### Invariants

1. **Adding or renaming a channel is three edits, not one.** Channel string in
   `main.ts`, method in `preload.cts`, payload type in `types.ts`. →
   **The Contract Is Written Three Times**
2. **Types do not enforce runtime input.** The shared handler authenticates the
   sender and bounds rate and payload size; business methods validate values. →
   **The Contract Is Written Three Times**
3. **Only these keys reach the renderer.** `contextBridge` exposes exactly the
   `api` object; nothing else is reachable from page or chrome JavaScript. →
   **The Bridge**
4. **The three `on*` methods return an unsubscribe function.** Dropping it leaks a
   listener on every re-render. → **Main to Renderer Events**
5. **The normal preload never accepts or returns vault secrets.** Unlock,
   pairing, edit and confirmation values travel through a separate one-shot
   preload whose nonce, sender, kind, size and lifetime are checked in main.

### Where to look

<!-- routing:start -->

| You are changing… | Section |
| --- | --- |
| what window.privateBrowser exposes | [The Bridge](#the-bridge) |
| adding, renaming or retyping a channel | [IPC Channels](#ipc-channels) |
| pushing something from main into the UI | [Main to Renderer Events](#main-to-renderer-events) |
| a field on a payload the UI reads | [Shared Payload Types](#shared-payload-types) |
| a channel that resolves nothing or does not exist | [The Contract Is Written Three Times](#the-contract-is-written-three-times) |
| a field on the release manifest, app or Worker side | [ReleaseManifest Is Declared Twice](#releasemanifest-is-declared-twice) |
| a type error crossing src/ and electron/ | [How the Renderer Gets These Types](#how-the-renderer-gets-these-types) |
| a payload field that looks unused or wrong | [Gotchas](#gotchas) |

<!-- routing:end -->

### Before you write

- Grep the channel string in all three files before changing anything.
- Prefer a named type in `types.ts` over an inline object literal in the preload.
- A type used by the Worker as well as the app must be checked at runtime — the
  compilers never see both copies.

## Overview

The renderer has no Node access and no `ipcRenderer`. Everything it can do to the
outside world goes through one frozen object, `window.privateBrowser`, built in
the preload and handed over by `contextBridge`. The preload is the only file that
names both a channel string and a TypeScript type, which makes it the closest
thing the project has to an interface definition — but it is a description, not an
enforcement.

## The Bridge

```ts
contextBridge.exposeInMainWorld('privateBrowser', api);
export type PrivateBrowserApi = typeof api;
```

- The exposed object is the literal `api` const: 40 `invoke` wrappers and three
  `on*` subscription helpers. Nothing else crosses.
- `PrivateBrowserApi` is derived with `typeof`, so the renderer's type follows the
  implementation automatically. This is the one place in the contract that cannot
  drift.
- The preload runs only in the chrome window. Tab views are created without a
  preload, so a page has no `window.privateBrowser` at all.

## IPC Channels

Argument and return types below are as **declared in the preload**. The main
process is what actually produces them; see the caveat in
[The Contract Is Written Three Times](#the-contract-is-written-three-times).
Every method returns a `Promise`, so the "Resolves with" column omits the wrapper.

### browser: — 20 channels

| Channel | Preload method | Arguments | Resolves with |
| --- | --- | --- | --- |
| `browser:get-state` | `getState()` | — | `BrowserSnapshot` |
| `browser:navigate` | `navigate(value)` | `value: string` | `void` |
| `browser:back` | `back()` | — | `void` |
| `browser:forward` | `forward()` | — | `void` |
| `browser:reload` | `reload()` | — | `void` |
| `browser:stop` | `stop()` | — | `void` |
| `browser:new-tab` | `newTab(workspaceId?, url?)` | `workspaceId?: WorkspaceId`, `url?: string` | `void` |
| `browser:close-tab` | `closeTab(tabId)` | `tabId: string` | `void` |
| `browser:activate-tab` | `activateTab(tabId)` | `tabId: string` | `void` |
| `browser:switch-workspace` | `switchWorkspace(workspaceId)` | `workspaceId: WorkspaceId` | `void` |
| `browser:set-layout` | `setLayout(layout)` | `{ top: number; left: number; right: number; bottom: number }` | `void` |
| `browser:toggle-bookmark` | `toggleBookmark()` | — | `void` |
| `browser:open-bookmark` | `openBookmark(id)` | `id: string` | `void` |
| `browser:toggle-bookmark-bar` | `toggleBookmarkBar()` | — | `void` |
| `browser:list-chrome-profiles` | `listChromeProfiles()` | — | `ChromeProfileSource[]` |
| `browser:import-chrome` | `importChrome(options)` | `ChromeImportOptions` | `ChromeImportResult` |
| `browser:import-chrome-passwords` | `importChromePasswords()` | — | `ChromeImportResult` |
| `browser:toggle-tracker-blocking` | `toggleTrackerBlocking()` | — | `void` |
| `browser:open-download` | `openDownload(id)` | `id: string` | `void` |
| `browser:show-download` | `showDownload(id)` | `id: string` | `void` |

`setLayout` is the only argument shape written as an inline object literal rather
than a named type. `main.ts` has its own unexported `Layout` interface with the
same four fields, and neither file imports the other.

### developer: — 12 channels

| Channel | Preload method | Arguments | Resolves with |
| --- | --- | --- | --- |
| `developer:toggle-tools` | `toggleDeveloperTools(mode)` | `mode: DevToolsMode` | `void` |
| `developer:capture-diagnostics` | `captureDeveloperDiagnostics()` | — | `DeveloperDiagnosticReport` |
| `developer:clear-diagnostics` | `clearDeveloperDiagnostics()` | — | `void` |
| `developer:bridge-status` | `getBridgeStatus()` | — | `BridgeStatus` |
| `developer:bridge-pair` | `beginBridgePairing()` | — | `BridgeStatus` |
| `developer:bridge-disconnect` | `disconnectBridge(revoke)` | `revoke: boolean` | `BridgeStatus` |
| `developer:bridge-projects` | `listBridgeProjects()` | — | `ProjectSummary[]` |
| `developer:bridge-select-project` | `selectBridgeProject(projectId)` | `projectId: string` | `ProjectInfo` |
| `developer:bridge-action` | `runBridgeAction(action, payload)` | bounded action and payload | protocol response |
| `developer:inspect-page` | `inspectDeveloperPage(selectElement)` | `selectElement: boolean` | `DeveloperPageInfo` |
| `developer:prepare-ai-preview` | `prepareDeveloperAiPreview(options)` | opt-in DOM/screenshot flags | `AiPagePreview` |
| `developer:install-extension` | `installBridgeExtension()` | — | status message |

The controller enforces the Development-workspace and protected-page boundary;
the renderer's disabled state is only presentation. `DevToolsMode` is
`'right' | 'bottom' | 'detach'`. Diagnostics are sanitized in the main process
before this bridge can return them.
The bridge channels are still chrome-renderer IPC; the authenticated named-pipe
protocol behind them is documented in [vscode-bridge.md](vscode-bridge.md).

### ai: — 6 channels

| Channel | Preload method | Arguments | Resolves with |
| --- | --- | --- | --- |
| `ai:prepare-preview` | `prepareAiPreview()` | — | `AiPagePreview` |
| `ai:approve-preview` | `approveAiPreview(previewId)` | `previewId: string` | `AiApproval` |
| `ai:provider-status` | `getAiProvider()` | — | `AiProviderStatus` |
| `ai:configure-provider` | `configureAiProvider(input)` | `input: AiProviderInput` | `AiProviderStatus` |
| `ai:clear-provider` | `clearAiProvider()` | — | `AiProviderStatus` |
| `ai:ask` | `askAi(token, question)` | `token: string`, `question: string` | `string` |
| `ai:revoke` | `revokeAiContext()` | — | `void` |

The two-step preview-then-approve shape and the token are the consent mechanism,
not a caching optimisation — see [ai-consent.md](ai-consent.md).

### vault: — 7 channels

| Channel | Preload method | Arguments | Resolves with |
| --- | --- | --- | --- |
| `vault:list` | `listVault()` | — | `VaultStatus` |
| `vault:add` | `addVaultItem(input)` | `input: VaultItemInput` | `VaultItemMeta` |
| `vault:remove` | `removeVaultItem(id)` | `id: string` | `boolean` |
| `vault:reset-corrupt` | `resetCorruptVault()` | — | `boolean` |
| `vault:copy-password` | `copyPassword(id)` | `id: string` | `void` |
| `vault:copy-totp` | `copyTotp(id)` | `id: string` | `{ secondsRemaining: number }` |
| `vault:autofill` | `autofill(id)` | `id: string` | `void` |

No channel ever returns a password or a TOTP secret. `copyPassword` and
`copyTotp` resolve with nothing useful because the value goes to the clipboard in
the main process; `VaultItemMeta` carries `hasTotp`, never the secret.

### system: — 3 channels

| Channel | Preload method | Arguments | Resolves with |
| --- | --- | --- | --- |
| `system:copy` | `copyText(value)` | `value: string` | `void` |
| `system:is-default-browser` | `getDefaultBrowserStatus()` | — | `boolean` |
| `system:set-default-browser` | `setDefaultBrowser()` | — | `boolean` |

### updates: — 5 channels

| Channel | Preload method | Arguments | Resolves with |
| --- | --- | --- | --- |
| `updates:status` | `getUpdateService()` | — | `UpdateServiceStatus` |
| `updates:configure` | `configureUpdateService(input)` | `input: UpdateServiceInput` | `UpdateServiceStatus` |
| `updates:clear` | `clearUpdateService()` | — | `UpdateServiceStatus` |
| `updates:check` | `checkForUpdates()` | — | `UpdateCheckResult` |
| `updates:open-page` | `openUpdatePage()` | — | `void` |

There is no mechanical rule mapping a channel name to a method name. Four break
the obvious one: `ai:provider-status` is `getAiProvider`, `system:copy` is
`copyText`, `system:is-default-browser` is `getDefaultBrowserStatus`, and
`updates:status` is `getUpdateService`. Several operations have a third name again
in the controller — `back()` calls `browser:back` which runs `goBack()`.

## Main to Renderer Events

Three channels flow the other way, via `webContents.send` in `main.ts` and
`ipcRenderer.on` in the preload.

| Channel | Preload method | Payload | Sent when |
| --- | --- | --- | --- |
| `browser:state` | `onState(cb)` | `BrowserSnapshot` | every `broadcast()` in the controller |
| `browser:focus-address` | `onFocusAddress(cb)` | none | Ctrl/Cmd+L pressed inside a page view |
| `updates:available` | `onUpdateAvailable(cb)` | `UpdateCheckResult` | a background check found a newer version |

Each helper wraps the caller's callback in a listener that strips the
`IpcRendererEvent` argument, and **returns an unsubscribe function** that calls
`removeListener`. App.tsx relies on that by returning the helper's result straight
out of a `useEffect`.

`browser:state` is a full snapshot every time — there are no deltas, and there is
no acknowledgement. `browser:focus-address` carries no payload; the renderer
decides what focusing means.

## Shared Payload Types

All in [types.ts](../../electron/types.ts), imported by the main process, the
preload and the renderer.

### Identity and workspaces

- `WorkspaceId` — `'digitronics' | 'tenten' | 'development' | 'personal' | 'banking'`.
  The literal union is the source of truth for the whole app; see
  [workspaces-and-state.md](workspaces-and-state.md).
- `Workspace` — `id`, `name`, `color`, `icon`, `protected`. Shipped inside every
  snapshot even though it is a compile-time constant, so the renderer never
  imports `WORKSPACES`.

### Browsing data

- `BrowserTab` — `id`, `workspaceId`, `title`, `url`, `favicon?`, `loading`,
  `securityWarning?`,
  `canGoBack`, `canGoForward`, `isHome`, `developerToolsAllowed`,
  `developerToolsOpen`.
- `Bookmark` — `id`, `title`, `url`, `workspaceId`, `createdAt`, `location`
  (`bar|other`), `folderPath`, `order`, `orderPath`.
- `HistoryEntry` — same, with `visitedAt` instead of `createdAt`.
- `DownloadEntry` — now also carries `checksum?: 'verified' | 'mismatch' | 'unchecked'`,
  set once a completed download has been compared with the release manifest
  ([browser-shell.md](browser-shell.md#downloads--checksum-verification)).
- `DownloadEntry` — `id`, `filename`, `receivedBytes`, `totalBytes`, `risk`,
  `state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'`, `savePath?`.
  The union is hand-written to mirror Electron's download states, and the main
  process assigns Electron's own state string straight into it.
- `PrivacyEvent` — `id`, `at`, `kind: 'local-read' | 'cloud-approved' | 'blocked' | 'vault'`,
  `title`, `detail`.

### The two aggregate shapes

- `BrowserSnapshot` — `workspaces`, `activeWorkspaceId`, `activeTabId`, `tabs`,
  `bookmarks`, `history`, `downloads`, `privacyLog`, `trackerBlocking`. What the
  renderer sees.
- `PersistedState` — `version: 1`, `activeWorkspaceId`,
  `tabs: Array<Pick<BrowserTab, 'id' | 'workspaceId' | 'title' | 'url' | 'isHome'>>`,
  `activeTabByWorkspace: Partial<Record<WorkspaceId, string>>`, `bookmarks`,
  `history`, `privacyLog`, `trackerBlocking`. What reaches disk.

These two are deliberately different, and the `Pick` is where the split is
declared: `loading`, `canGoBack`, `canGoForward`, `favicon`,
`developerToolsAllowed` and `developerToolsOpen` are runtime-only.
The snapshot also truncates `history` to 100 and `privacyLog` to 50, and adds
`downloads`, which is never persisted.

### AI

- `AiPagePreview` — `id`, `title`, `url`, `text`, `redactions`, `protectedPage`.
- `AiApproval` — `token`, `preview`.
- `AiProviderStatus` — `configured`, `endpoint?`, `model?`,
  `error?: 'provider-corrupt' | 'os-encryption-unavailable'`.
- `AiProviderInput` — `endpoint`, `model`, `apiKey`.

### Developer diagnostics

- `DevToolsMode` — `'right' | 'bottom' | 'detach'`.
- `DeveloperConsoleEntry` — timestamp, warning/error level, sanitized message,
  sanitized source and line.
- `DeveloperNetworkIssue` — timestamp, method, resource type, sanitized URL,
  optional status and error.
- `DeveloperDiagnosticReport` — schema version, capture/app metadata, sanitized
  page metadata and DOM counts, bounded console/network arrays, redaction count,
  and the preformatted AI-ready report.

### Vault

- `VaultItemInput` — `label`, `url`, `username`, `password`, `totpSecret?`.
- `VaultItemMeta` — `id`, `label`, `url`, `username`, `hasTotp`, `updatedAt`.
- `VaultStatus` — `available`,
  `reason?: 'os-encryption-unavailable' | 'vault-corrupt'`, `items`.

### Updates

- `UpdateServiceInput` — `endpoint`, `accessToken`.
- `UpdateServiceStatus` — `configured`, `currentVersion`, `endpoint?`,
  `error?: 'configuration-corrupt' | 'os-encryption-unavailable'`.
- `ReleaseManifest` — `schemaVersion: 1`, `appId: 'private-browser'`, `version`,
  `buildNumber`, `channel: 'stable' | 'beta'`, `publishedAt`, `filename`,
  `sizeBytes`, `sha256`, `commitSha`, `releaseNotes`, `downloadUrl`,
  `downloadPageUrl`, `expiresAt`. See below.
- `UpdateCheckResult` — `state: 'available' | 'up-to-date'`, `currentVersion`,
  `latest: ReleaseManifest`, `checkedAt`.

Every `error` and `reason` field is a closed string union with no catch-all
member, so a new failure mode inside a store means a new literal here **and** a
new branch in the renderer.

## The Contract Is Written Three Times

| File | What it declares |
| --- | --- |
| [main.ts](../../electron/main.ts) | the channel string and the handler body |
| [preload.cts](../../electron/preload.cts) | the method name, its arguments, its declared return type |
| [types.ts](../../electron/types.ts) | the payload shapes both sides name |

**Nothing enforces that the three agree.**

- `handle(channel: string, callback: (event, ...args: any[]) => unknown)` in
  `main.ts` takes `any[]`. The parameter annotations on each handler are
  hand-written assertions about values the compiler treats as `any`.
- `ipcRenderer.invoke` is typed `(channel: string, ...args: any[]): Promise<any>`,
  so the preload's `Promise<VaultItemMeta>` is a claim, not a check. A handler that
  returns something else compiles and ships.
- The channel strings are string literals in two files with no shared constant. A
  typo in either becomes a runtime rejection — `No handler registered for
  'browser:navigat'` — with no build-time signal.
- `preload.cts` and `main.ts` are in the same tsc program
  (`tsconfig.electron.json`), which catches a wrong *type* name but nothing about
  channel identity.

The practical rule: grep the channel string. It appears exactly twice in a healthy
tree, once per file.

## ReleaseManifest Is Declared Twice

`ReleaseManifest` in [types.ts](../../electron/types.ts) is a second, independent
declaration of the one in
[cloudflare/src/protocol.ts](../../cloudflare/src/protocol.ts). The field lists
are identical; the only spelling difference is `appId`, written as the literal
`'private-browser'` in the app and as `typeof APP_ID` in the Worker, where
`APP_ID` is that same string.

They cannot be compared by any compiler:

- `electron/**` is compiled by `tsconfig.electron.json`.
- `cloudflare/src/**` is compiled by `cloudflare/tsconfig.json`, a separate
  program with its own `include`.
- Neither directory imports the other, and neither is on the other's include path.

So a field added, renamed or retyped on one side is a silent no-op on the other
until something fails at runtime. The only real check is `validateManifest()` in
[update-service.ts](../../electron/update-service.ts), which validates the parsed
response field by field before it is cast — see
[release-and-updates.md](release-and-updates.md).

## How the Renderer Gets These Types

- [src/vite-env.d.ts](../../src/vite-env.d.ts) declares
  `Window.privateBrowser: PrivateBrowserApi`, importing that type from
  `'../electron/preload.cjs'` — the **compiled** extension. TypeScript resolves a
  `.cjs` specifier to a `.cts` source, so this works from a clean checkout without
  building the main process first.
- `src/App.tsx` imports the payload types from `'../electron/types'` directly.
- Both cross a tsconfig boundary: `electron/` is not in the root `tsconfig.json`
  `include`, so these files enter the renderer program as imported dependencies and
  are checked under the renderer's compiler options rather than the electron ones.

## Related Systems

- [browser-shell.md](browser-shell.md) — registers all 40 channels and sends all
  three events.
- [renderer-ui.md](renderer-ui.md) — the only consumer of the bridge.
- [workspaces-and-state.md](workspaces-and-state.md) — owns `PersistedState` and
  `WorkspaceId` at runtime.
- [vault.md](vault.md), [ai-consent.md](ai-consent.md),
  [release-and-updates.md](release-and-updates.md) — the behaviour behind the
  `vault:`, `ai:` and `updates:` namespaces.

## Gotchas

- **`AiPagePreview.protectedPage` is dead.** Its only construction site sets it to
  `false` unconditionally, and nothing reads it. A protected page never produces a
  preview at all — the call throws instead — so the field cannot ever be `true`.
- **Two channels report failure as `false`, not as a rejection.** `vault:remove`
  and `vault:reset-corrupt` resolve `boolean`, so "there was nothing to do" and
  "it worked" arrive through the same path and only the value tells them apart.
  Every other failure in the contract is a thrown error that surfaces as a
  rejected `invoke`.
- **`browser:state` has no sequence number.** A renderer that starts an action and
  then receives a snapshot cannot tell whether the snapshot reflects its action or
  predates it.
- **The three `on*` helpers must be unsubscribed.** They register a new listener
  every call. App.tsx returns each one's result from a `useEffect`; a caller that
  ignores the return leaks a listener per render.
- **`setLayout` has no named type.** Its shape is duplicated between an inline
  literal in the preload and the `Layout` interface in `main.ts`, and the main
  process clamps the values it receives — see
  [browser-shell.md](browser-shell.md).
