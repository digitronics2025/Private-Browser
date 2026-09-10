# Private Browser

Private Browser is a Windows-first Chromium work browser for Digitronics. It keeps business and personal accounts separated, makes sensitive AI access explicit, and stores credentials using operating-system encryption.

## What is included

- Real Chromium browsing in native Electron `WebContentsView` tabs.
- Five persistent, cookie-isolated workspaces: Digitronics, TenTen, Development, Personal and Banking.
- Chrome-style tabs, address/search bar, navigation, bookmarks, history and download management.
- Tracker blocking for common analytics and advertising hosts.
- Crash/session restoration without storing form values or page content.
- Local page extraction and sensitive-data redaction before optional cloud approval.
- AI access disabled entirely in the Banking workspace and on detected banking/payment pages.
- OS-encrypted local credential vault, explicit same-domain autofill and RFC 6238 TOTP codes.
- Safe one-click routines that open common work setups without sending, buying, publishing or deleting anything.
- An auditable privacy activity log.

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

The installer is written to `release/Private-Browser-0.1.0-Setup.exe`. GitHub Actions also creates a downloadable Windows artifact for every push to `main`.

## Privacy model

Local browser state never includes passwords, form contents, cookies or AI page text. Workspace cookies live in distinct Electron session partitions. Vault values are encrypted through Electron `safeStorage`, which uses the operating system's credential protection.

The AI panel first extracts visible page text locally. It removes common credentials, tokens, card numbers, JWTs and authenticator secrets. The sanitized preview must be approved for the current request before a cloud connector may use it. This release intentionally does not bundle an AI provider or API key.

## Current scope

This is a functional foundation, not a Chromium fork. It is optimized for a private single-user Windows workflow. Android sync, cloud AI providers, extension compatibility, passkey management UI and encrypted cross-device sync are planned modules; Chromium's ordinary website WebAuthn/passkey flow remains available where supported by the host OS.

See [SECURITY.md](SECURITY.md) before expanding privileged features.
