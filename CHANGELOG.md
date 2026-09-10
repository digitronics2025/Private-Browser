# Changelog

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
