# Private Browser

Private Browser is a Windows-first Chromium work browser for Digitronics. It keeps business and personal accounts separated, makes sensitive AI access explicit, and stores credentials using operating-system encryption.

## What is included

- Real Chromium browsing in native Electron `WebContentsView` tabs.
- Five persistent, cookie-isolated workspaces: Digitronics, TenTen, Development, Personal and Banking.
- Chrome-style tabs, address/search bar, navigation, bookmarks, history and download management.
- Tracker blocking for common analytics and advertising hosts.
- Crash/session restoration without storing form values or page content.
- Local page extraction, sensitive-data redaction and single-use cloud approval tokens.
- AI access disabled entirely in the Banking workspace and on detected banking/payment pages.
- OS-encrypted local credential vault, explicit same-domain autofill, RFC 6238 TOTP codes and automatic clipboard clearing.
- Encrypted, user-configurable OpenAI-compatible cloud AI provider with one approval required per request.
- Windows default-browser registration and single-instance external-link handling.
- Safe one-click routines that open common work setups without sending, buying, publishing or deleting anything.
- An auditable privacy activity log.
- A Cloudflare-native private release service with D1 metadata, R2 installers, a protected download page and resumable downloads.
- OS-encrypted update-service configuration with startup and daily release checks.

## Run locally

Requirements: Node.js 20+ and Windows 10/11 for the final desktop installer.

```bash
npm install
npm run dev
```

The development command launches Vite on localhost and opens the Electron application.

## Verify and build

```bash
npm run check
```

Create the Windows installer on a Windows machine:

```bash
npm run dist
```

The installer is written to `release/Private-Browser-0.3.1-Setup.exe`. GitHub Actions also creates a downloadable Windows artifact for every push to `main`.

The installer is not code-signed yet, so Windows SmartScreen may show an unknown-publisher warning. Production distribution requires a trusted code-signing certificate.

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
