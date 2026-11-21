# Changelog

The [download page](https://private-browser-downloads.digitronics-electro.workers.dev/#release-history)
lists stable versions with their publication dates. Read the
[desktop highlights](docs/desktop-release-notes/) for individual changes.

## Unreleased

- Connect Claude Code or Codex to the isolated Agent Workspace. Review
  consequential actions in the browser and stop sessions from its toolbar.

## 0.6.40

- Generate passwords, passphrases and PINs inside the secure MyVault editor.
  Review the login and press Save to store it.

## 0.6.39

- Edit bookmark addresses, review duplicates, and preview bulk move or delete
  actions. Undo the last bulk change in the same Account Space.

## 0.6.38

- See file type, release checksum and Windows publisher details separately.
  Recover from side-app loading errors with the matching action.

## 0.6.37

- Use a native page context menu. Preview opening a bookmark folder in background
  tabs. Pin and reorder New Tab shortcuts and hide recent sites if desired.

## 0.6.36

- Build routines with a destination Account Space for each page. Reuse open
  tabs and keep a manual checklist between shifts.

## 0.6.35

- Pin and group tabs by Account Space, undo bulk closes, and select tabs to
  restore after startup failures. Windows Default Apps and a test link are
  available from Settings.

## 0.6.34

- Find tabs, bookmarks and retained history from the address bar. Route
  external links into a regular Account Space, and see only that space's
  downloads. Browse large bookmark collections in pages.

## 0.6.0 — 2026-09-14

- Redesigned the browser frame in a Chrome-familiar "Chrome Precision" style with
  the original Private Browser shield and teal palette, in light and dark themes.
- Merged the title row into one tab strip with the native Windows caption buttons,
  drag-to-reorder tabs, middle-click close, mute, tab search and a protection
  status popup.
- Added a real keyboard-accessible browser menu, a compact profile menu with
  workspace and Account Space switching, find in page, zoom, print, reopen closed
  tab and full screen, plus standard Chrome shortcuts that now work identically
  from the page and from the browser controls.
- Rebuilt the bookmarks bar with favicons, nested folder menus, overflow,
  reordering, rename/delete, export and Always/New Tab/Hidden modes, and added
  Bookmarks and History panels.
- Replaced the permanent sidebar with a closed-by-default, resizable side panel
  that remembers its width and tool, and a New Tab page with customisable
  shortcuts and backgrounds.
- Fixed a startup race that could leave the browser window hidden when the page
  became ready before loading finished.
- Computed the page position from one shared layout module in both processes, so
  web content always starts directly below the visible chrome and ends at the side
  panel, across resizing, maximising, display scaling and full screen.

## 0.5.10 — 2026-09-13

- Fixed Cloudflare login verification by preserving Electron's stable default
  embedded-browser identity instead of advertising Google Chrome in the legacy
  User-Agent while Client Hints identified Chromium.
- Added a real Electron regression that completes Cloudflare's official
  Turnstile test-key flow inside an isolated Account Space.

## 0.5.9 — 2026-09-13

- Added an explicit, security-header-protected favicon route for the public
  download page so production browsers no longer log a missing-resource error.

## 0.5.8 — 2026-09-12

- Added a dedicated in-app Updates page that automatically compares the installed
  version with the latest stable D1 release and clearly reports current,
  available, loading and retryable-error states.
- Added a public read-only latest-release manifest while retaining the existing
  authenticated client routes as an encrypted private override.
- Added release build, publication time, notes, source commit, SHA-256 and
  developer details, plus a verified-download action that keeps installer links
  short-lived and checks the downloaded file before it can be opened.

## 0.5.7 — 2026-09-12

- Fixed Cloudflare human-verification compatibility by removing Electron and
  packaged application identity tokens from the Chromium user agent while
  keeping network headers, JavaScript and client hints aligned.
- Added real Electron regression coverage for the packaged browser identity.

## 0.5.6 — 2026-09-12

- Added Chrome-style automatic MyVault filling for matching normal HTTPS login
  forms, with delayed-form retries, empty-field protection and no auto-submit.
- Kept automatic fill disabled in Banking and Development, and excluded signup,
  password-reset, new-password, insecure and certificate-error pages.
- Fixed the local browser preview so opening MyVault displays the autofill state
  without a missing-listener crash.
- Added a public Cloudflare download page with automatic current-version metadata,
  publication time, five-release history, signed installer delivery, checksum
  details, responsive design and the developer profile.

## 0.5.0 — 2026-09-12

- Added local Chrome profile detection, selective bookmark/history import and a
  Chrome-style bookmarks bar that preserves folders, ordering and overflow.
- Replaced the independent browser credential store with a brokered MyVault
  envelope, offline editing, scoped device pairing and explicit CAS conflicts.
- Added hardened one-shot secret dialogs and metadata-only renderer IPC; master
  passwords, device tokens, decrypted payloads and entry secrets stay trusted.
- Replaced page-world autofill with exact-origin, navigation-bound, single-use
  isolated-world fills that recognize login fields and never submit.
- Added deliberate Save/Update capture, recoverable legacy migration, direct
  Chrome CSV import and central Banking/Development workspace policy.
- Ported the reviewed passkey ceremony core behind a disabled release gate; OS
  WebAuthn remains unchanged until packaged first-script interception is proven.
- Fixed the hardened package fuse set so the installed application loads its
  shipped V8 snapshot and starts successfully.
- Fixed standalone VSIX naming so browser releases retain the extension's own
  `0.4.0` package version.

## 0.4.0 — 2026-09-12

- Added dynamic Account Spaces beneath the five existing workspaces with opaque
  partitions, account-scoped tabs/bookmarks/history/permissions and independent
  encrypted records.
- Added byte-preserving, retry-safe version-1 migration and read-only recovery
  for global or per-account corruption.
- Added secure external-browser Google Desktop OAuth with PKCE, verified identity
  claims, least-privilege Gmail/Drive/Calendar/Contacts modules and narrow APIs.
- Added payload-bound confirmations for Google mutations and account-bound AI
  consent that keeps Google data local by default.
- Added AES-256-GCM Drive app-data backup with verified recovery codes, ETag
  conflict handling and strict exclusions.
- Replaced the avatar shortcut with an accessible account switcher and responsive
  manager, plus account-scoped permission and recovery overlays.
- Added browser and real Electron Playwright coverage proving partition isolation
  and retained Banking/Development policy.
- Added local Chrome profile detection and selective bookmark/history import.
- Added a Chrome-style bookmarks bar with preserved folders, ordering, Other
  bookmarks, overflow menus, and the Ctrl+Shift+B visibility shortcut.
- Added secure Chrome Password Manager CSV import directly into the OS-encrypted
  Vault, with duplicate and unsafe-entry filtering.
- Added the authenticated Private Browser Bridge and private VS Code extension.
- Added explicit workspace, command, live-origin, AI-context, and patch approvals.
- Added Vite/React, Node/PWA, Electron, Worker, WordPress, and Android adapters.
- Added isolated Playwright page checks, bounded local reports, and guarded AI fixes.
- Added bundled and standalone VSIX packaging plus Windows CI smoke coverage.

## 0.3.4 — 2026-09-10

- Hardened packaged Electron executables with sandbox, cookie-encryption,
  Node/inspection-disable, ASAR-integrity and ASAR-only fuses.
- Added explicit certificate and webview denial, WebRTC private-address
  protection, IPC payload/rate limits, and CodeQL/dependency-update automation.
- Added DNT/GPC headers, broader tracker blocking, campaign-id removal, and
  visible warnings for cleartext and internationalized domains.
- Locked Banking down further by denying site permissions, popups, downloads
  and history, and blocked unverified executable or deceptive downloads.
- Added CycloneDX SBOM artifacts and optional Windows code signing in CI.

## 0.3.1 — 2026-09-10

- Added an optional CI-generated test bootstrap so packaged Windows builds connect to the private Cloudflare download service on first launch.
- Imported bootstrap credentials into OS-encrypted storage, retained Settings-based rotation, and made Disconnect persistent.
- Made the signed download page directly available from Settings even when the installed version is current.
- Added post-publication live verification for authenticated manifests, signed pages, full downloads, range requests, resumed downloads and checksum integrity.

## 0.3.0 — 2026-09-10

- Added a Cloudflare Worker release service with separate client and administrator authentication.
- Added D1 release metadata and private R2 installer storage; executable binaries never enter D1.
- Added a private branded download page with HMAC-signed, expiring links.
- Added `update.json`, resumable byte-range downloads, correct executable metadata and SHA-256 release checksums.
- Added an OS-encrypted Cloudflare connection in desktop settings, manual and daily update checks, and in-browser release downloads.
- Added D1 migrations, Worker deployment automation and automatic R2 publishing after verified Windows builds.
- Expanded validation to cover signed links, metadata sanitization, range handling, manifest origin pinning and Worker bundling.

## 0.2.0 — 2026-09-10

- Replaced mutable AI approvals with expiring, single-use capability tokens.
- Added a functional encrypted OpenAI-compatible cloud provider and one-request consent flow.
- Prevented URL query strings, paths and fragments from entering cloud AI context.
- Moved password and TOTP copying into the main process and added 30-second clipboard clearing.
- Added corrupt-vault detection, write protection and recoverable reset backups.
- Added persisted-state repair, credential-bearing URL rejection and private-network AI endpoint blocking.
- Fixed inactive-tab closure, renderer shortcuts, nonfunctional settings controls and external-link startup handling.
- Added Windows default-browser registration, single-instance behavior and HTTP security indicators.
- Expanded the security suite and updated documentation.

## 0.1.0 — 2026-09-10

- Added the Windows-first Chromium browser shell and native tab lifecycle.
- Added five cookie-isolated workspaces and persistent session restoration.
- Added bookmarks, history, downloads, tracker blocking and keyboard shortcuts.
- Added local-first AI page previews with redaction, one-request approval and protected-page denial.
- Added an OS-encrypted credential vault, same-domain autofill and local TOTP generation.
- Added safe workspace automations, a privacy activity log and a custom application icon.
- Added automated tests, production builds and GitHub Actions Windows installer packaging.
