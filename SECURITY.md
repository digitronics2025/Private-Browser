# Security model

## Trust boundaries

Private Browser treats every loaded website as hostile. Remote pages run in sandboxed `WebContentsView` instances with Node.js disabled, context isolation enabled, no preload script, no privileged IPC and strict protocol filtering. The trusted React browser chrome runs separately with a small, typed preload bridge.

Each workspace uses a separate persistent Electron session partition, preventing cookies and authenticated sessions from crossing workspace boundaries.

## Vault

Credentials and TOTP secrets are encrypted using Electron `safeStorage` before being written to disk. The vault file and browser-state file are created with owner-only permissions where the operating system supports them. Vault metadata exposed to the UI never contains passwords or TOTP secrets. Passwords and TOTP values are copied directly by the main process and cleared from the clipboard after 30 seconds if unchanged.

If the vault cannot be decrypted, writes are disabled to prevent silent data loss. The recovery action preserves the unreadable encrypted file as a timestamped backup before creating a new vault.

Autofill is deliberately manual and restricted to an exact hostname match. A website can still observe credentials entered into its own form, just as it can in any password manager; users must verify the domain before filling.

## AI data controls

- Banking workspace and detected banking/payment pages reject page extraction.
- Page extraction reads rendered text only and never reads input values, cookies, local storage or authentication headers.
- Sensitive-pattern redaction runs locally before preview.
- Query parameters, URL paths and fragments are never shared; only the page origin is included.
- The user approves the exact sanitized preview through a five-minute, single-use capability token.
- Every local read, approval, denial and vault access is logged without secret values.
- Cloud AI is disabled until the user configures a public HTTPS OpenAI-compatible provider. The API key is OS-encrypted and never returned to the renderer.
- Provider redirects are rejected to prevent HTTPS-to-local-network request pivots.

## Permissions

Remote sites are denied sensitive Electron permissions by default. Fullscreen and sanitized clipboard writes are the only allowed permissions in the initial release. Popups are converted to ordinary sandboxed tabs. Non-HTTP(S) navigation is blocked.

## Release service

Installer binaries are private R2 objects. D1 contains only release metadata and the R2 object key. Desktop checks use a client-only bearer token stored through Electron `safeStorage`; the renderer receives status and signed URLs, never the token. Publishing uses a separate administrator key.

Download-page and binary URLs are HMAC-signed, purpose-bound and expire after 15 minutes. Signatures bind binary access to the active D1 release ID, so replacing the active release invalidates prior installer links. Invalid or expired credentials return a generic `404`. Responses disable caching and referrers, and the page uses a restrictive Content Security Policy and `noindex` controls.

Test installers may contain a CI-generated bootstrap holding the shared client download token so a private single-user build connects on first launch. The app immediately copies it into OS-encrypted storage and attempts to remove the bootstrap file. Because a credential distributed inside a desktop installer can be extracted, this test token is not considered confidential and must be rotated before broader distribution. Production enrollment should issue revocable device-specific credentials instead of bundling a shared bearer token.

The Worker checks R2 object size against D1 before publication and again before serving. The release workflow calculates SHA-256 from the exact installer uploaded to R2. Resumable downloads are restricted to one validated byte range per request.

## Known external requirement

The generated Windows installer is reproducible but unsigned. A trusted code-signing certificate is required to eliminate Windows unknown-publisher warnings.

## Reporting

Do not open a public issue containing credentials or private browsing data. Rotate any exposed credential before reporting a security problem.
