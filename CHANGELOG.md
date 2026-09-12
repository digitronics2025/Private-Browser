# Changelog

## 0.4.0 — 2026-09-12

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
