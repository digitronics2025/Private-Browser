# Security model

## Trust boundaries

Private Browser treats every loaded website as hostile. Remote pages run in sandboxed `WebContentsView` instances with Node.js disabled, context isolation enabled, no preload script, no privileged IPC and strict protocol filtering. The trusted React browser chrome runs separately with a small, typed preload bridge.

Each workspace uses a separate persistent Electron session partition, preventing cookies and authenticated sessions from crossing workspace boundaries.

## Vault

Credentials and TOTP secrets are encrypted using Electron `safeStorage` before being written to disk. The vault file and browser-state file are created with owner-only permissions where the operating system supports them. Vault metadata exposed to the UI never contains passwords or TOTP secrets. Passwords and TOTP values are copied directly by the main process and cleared from the clipboard after 30 seconds if unchanged.

If the vault cannot be decrypted, writes are disabled to prevent silent data loss. The recovery action preserves the unreadable encrypted file as a timestamped backup before creating a new vault.

Autofill is deliberately manual and restricted to an exact hostname and port match. The scheme is checked asymmetrically: a credential saved for `https` is never filled into an `http` page, while a page served over `https` is always acceptable. A website can still observe credentials entered into its own form, just as it can in any password manager; users must verify the domain before filling.

## AI data controls

- The Banking workspace rejects page extraction outright. Detected banking and
  payment pages are also rejected, but that detection is a best-effort keyword
  match and cannot cover every institution — the workspace is the guarantee, the
  keyword list is a safety net. It errs towards refusing.
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

Installers ship **without** an embedded download credential by default. A private single-user build may opt in by setting the repository variable `PRIVATE_BROWSER_BUNDLE_UPDATE_TOKEN` to `true`, which bundles a CI-generated bootstrap holding the shared client download token so the build connects on first launch. The app copies it into OS-encrypted storage and removes the bootstrap file — and removes it even when OS encryption is unavailable and the value could not be stored, rather than leaving a shared credential readable on disk.

That opt-in is deliberately awkward, because a credential distributed inside a desktop installer can be extracted by anyone holding the file, and this one is shared by every client rather than issued per device. Any installer built with it must be treated as carrying a public token: rotate `PRIVATE_BROWSER_DOWNLOAD_TOKEN` before the file goes anywhere beyond the machine it was built for. Production enrollment should issue revocable device-specific credentials instead.

The Worker checks R2 object size against D1 before publication and again before serving. The release workflow calculates SHA-256 from the exact installer uploaded to R2. Resumable downloads are restricted to one validated byte range per request.

## Known external requirement

The generated Windows installer is reproducible but unsigned. A trusted code-signing certificate is required to eliminate Windows unknown-publisher warnings.

## Reporting

Do not open a public issue containing credentials or private browsing data. Rotate any exposed credential before reporting a security problem.
