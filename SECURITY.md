# Security model

## Trust boundaries

Private Browser treats every loaded website as hostile. Remote pages run in sandboxed `WebContentsView` instances with Node.js disabled, context isolation enabled, no preload script, no privileged IPC and strict protocol filtering. The trusted React browser chrome runs separately with a small, typed preload bridge.

Each workspace uses a separate persistent Electron session partition, preventing cookies and authenticated sessions from crossing workspace boundaries.

## Vault

Credentials and TOTP secrets are encrypted using Electron `safeStorage` before being written to disk. The vault file and browser-state file are created with owner-only permissions where the operating system supports them. Vault metadata exposed to the UI never contains passwords or TOTP secrets.

Autofill is deliberately manual and restricted to an exact hostname match. A website can still observe credentials entered into its own form, just as it can in any password manager; users must verify the domain before filling.

## AI data controls

- Banking workspace and detected banking/payment pages reject page extraction.
- Page extraction reads rendered text only and never reads input values, cookies, local storage or authentication headers.
- Sensitive-pattern redaction runs locally before preview.
- The user approves the exact sanitized preview for one request.
- Every local read, approval, denial and vault access is logged without secret values.
- No AI vendor, API key or automatic cloud transmission ships in this release.

## Permissions

Remote sites are denied sensitive Electron permissions by default. Fullscreen and sanitized clipboard writes are the only allowed permissions in the initial release. Popups are converted to ordinary sandboxed tabs. Non-HTTP(S) navigation is blocked.

## Reporting

Do not open a public issue containing credentials or private browsing data. Rotate any exposed credential before reporting a security problem.
