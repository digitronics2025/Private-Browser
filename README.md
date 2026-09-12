# Private Browser

Private Browser is a Windows-first Chromium work browser for Digitronics. It keeps business and personal accounts separated, makes sensitive AI access explicit, and stores credentials using operating-system encryption.

## What is included

- Real Chromium browsing in native Electron `WebContentsView` tabs.
- Five persistent, cookie-isolated workspaces: Digitronics, TenTen, Development, Personal and Banking.
- Chrome-style tabs, address/search bar, navigation, a full bookmarks bar,
  history and download management.
- Local Chrome migration for bookmark-bar folders and history, plus secure
  Password Manager CSV import directly into the encrypted Vault.
- Tracker blocking for common analytics, advertising and session-replay hosts,
  tracking-parameter removal, DNT/GPC, and WebRTC private-address protection.
- Crash/session restoration without storing form values or page content.
- Local page extraction, sensitive-data redaction and single-use cloud approval tokens.
- AI access disabled entirely in the Banking workspace, and on banking or payment pages the app recognises. Recognition is best-effort and errs towards refusing; put a bank in the Banking workspace to be certain.
- OS-encrypted local credential vault, explicit same-domain autofill, RFC 6238 TOTP codes and automatic clipboard clearing.
- Encrypted, user-configurable OpenAI-compatible cloud AI provider with one approval required per request.
- Windows default-browser registration and single-instance external-link handling.
- Safe one-click routines that open common work setups without sending, buying, publishing or deleting anything.
- An auditable privacy activity log.
- A Cloudflare-native private release service with D1 metadata, R2 installers, a protected download page and resumable downloads.
- OS-encrypted update-service configuration with startup and daily release checks.
- A Development-workspace cockpit with native Chromium Elements, Console, Sources, Network, Performance, Application and Recorder tools; F12/Ctrl+Shift+I shortcuts; right-click element inspection; and sanitized AI-ready diagnostic reports.
- Hardened Electron fuses, explicit certificate/webview denial, bounded IPC,
  strict site permissions, risky-download blocking and a locked-down Banking workspace.

## Run locally

Requirements: Node.js 20+ and Windows 10/11 for the final desktop installer.

```bash
npm install
npm run dev
```

The development command launches Vite on localhost and opens the Electron application.

To migrate from Chrome, open **Settings → Import from Chrome**, choose the Chrome
profile and destination workspace, then import bookmarks and/or history. Chrome
passwords can be exported as CSV and selected in the same panel; delete that
unencrypted CSV after checking the Vault. Cookies, live sessions, payment cards,
extensions and account tokens are not copied.

Open a webpage in the **Development** workspace, then select **Dev** in the right sidebar or press **F12** / **Ctrl+Shift+I**. Right-click a page element for exact inspection. The diagnostic report deliberately excludes page text, form values, cookies, storage, headers, request bodies, query strings and fragments, and developer access is blocked for Banking and detected payment pages.

## Verify and build

```bash
npm run check
```

Create the Windows installer on a Windows machine:

```bash
npm run dist
```

The installer is written to `release/Private-Browser-<version>-Setup.exe`. GitHub Actions also creates a downloadable Windows artifact and CycloneDX SBOM for every push to `main`.

The release workflow automatically code-signs when the two Windows signing
secrets documented in `SECURITY.md` are configured. Until then, Windows
SmartScreen may show an unknown-publisher warning.

## Cloudflare download service

The `cloudflare/` project contains the Worker, D1 migrations, private R2 release flow, protected download page and automated deployment/publishing workflows. Cloudflare account identifiers and credentials must be configured privately in the repository settings before running **Deploy download service**; they are intentionally not included in source documentation.

Main-branch Windows artifacts can receive a temporary test bootstrap from the PRIVATE_BROWSER_DOWNLOAD_URL repository variable and PRIVATE_BROWSER_DOWNLOAD_TOKEN Actions secret. On first launch the app imports that connection into Electron safeStorage, respects a later Disconnect action, and removes the bootstrap resource when Windows permissions allow. Settings always allows the endpoint and token to be rotated. Treat the bundled client token as distributable test configuration rather than a production-grade secret.

After deployment, open **Settings → Private downloads** in the desktop app to connect the Worker and check for releases. The connection is encrypted with Windows credential protection and is never returned to the renderer after it is saved.

## Privacy model

Local browser state never includes passwords, form contents, cookies or AI page text. Workspace cookies live in distinct Electron session partitions. Vault values are encrypted using Electron `safeStorage`, which uses the operating system's credential protection.

The AI panel first extracts visible page text locally. It removes common credentials, tokens, card numbers, JWTs and authenticator secrets, strips the page URL down to its origin, and protects banking/payment pages. The sanitized preview must be approved for one request. You can connect any public HTTPS OpenAI-compatible endpoint; its API key is stored with operating-system encryption.

## Current scope

This is a functional desktop browser, not a Chromium fork. It is optimized for a private single-user Windows workflow. Android, extension compatibility, a passkey-management UI and encrypted cross-device sync remain future modules; Chromium's ordinary website WebAuthn/passkey flow remains available where supported by the host OS.

See [SECURITY.md](SECURITY.md) before expanding privileged features.
