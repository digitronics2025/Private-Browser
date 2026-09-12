# Security model

## Trust boundaries

Private Browser treats every loaded website as hostile. Remote pages run in sandboxed `WebContentsView` instances with Node.js disabled, context isolation enabled, no preload script, no privileged IPC and strict protocol filtering. The trusted React browser chrome runs separately with a small, typed preload bridge.

The packaged Electron executable disables `ELECTRON_RUN_AS_NODE`, Node options
and CLI debugging, enables cookie encryption and embedded ASAR integrity, and
loads the application only from its ASAR. Chromium's process sandbox is enabled
globally. Certificate errors are rejected, `<webview>` attachment is refused,
WebRTC is restricted to the default public interface, and IPC payloads are
size-bounded and rate-limited after a main-frame trusted-sender check. The chrome
renderer is pinned to its packaged file (or the configured local dev origin), so
a remote page cannot navigate the privileged window and inherit its preload API.

Each workspace uses a separate persistent Electron session partition, preventing cookies and authenticated sessions from crossing workspace boundaries.

## Vault

Credentials and TOTP secrets are encrypted using Electron `safeStorage` before being written to disk. The vault file and browser-state file are created with owner-only permissions where the operating system supports them. Vault metadata exposed to the UI never contains passwords or TOTP secrets. Passwords and TOTP values are copied directly by the main process and cleared from the clipboard after 30 seconds if unchanged.

If the vault cannot be decrypted, writes are disabled to prevent silent data loss. The recovery action preserves the unreadable encrypted file as a timestamped backup before creating a new vault.

Autofill is deliberately manual and restricted to an exact hostname and port match. The scheme is checked asymmetrically: a credential saved for `https` is never filled into an `http` page, while a page served over `https` is always acceptable. A website can still observe credentials entered into its own form, just as it can in any password manager; users must verify the domain before filling.

## Local browsing data

Saved credentials, the AI provider key and the download-service token are
encrypted with Electron `safeStorage`. **Browsing history, bookmarks, open tab
URLs and the privacy log are not** — they are written as plaintext JSON in the
application's own data directory, so the app can still start when the operating
system keychain is unavailable. The file is created with owner-only permissions
where the OS supports them, which on Windows is largely advisory. Anyone with an
account on the machine, or any process running as the user, can read that file.
Nothing in it leaves the device.

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

Those two permissions require a top-level HTTPS page (or localhost development
page). Banking denies every site permission, popup and download. Common campaign
identifiers are removed from navigations, DNT and Global Privacy Control headers
are sent, common tracker hosts are blocked, and cleartext or punycode domains are
visibly marked in the address bar.

Executable, script and deceptive double-extension downloads are labelled and
cannot be opened from Private Browser unless they match the checksum of the
release manifest. This does not replace operating-system malware scanning.

## Developer tools

Chromium DevTools attach only to non-home pages in the Development workspace. They are refused in every other workspace and on detected banking or payment URLs, and are closed whenever the user switches tabs or workspaces or a tab commits a protected navigation. Page context menus expose exact element inspection only inside that boundary.

Developer diagnostics are process-memory-only, bounded per tab, and collect only console warnings/errors, failed-request method/status/type, sanitized source URLs, and aggregate document counts. They never collect page text, input values, cookies, local or session storage, headers, request or response bodies. URL credentials, queries and fragments are removed, high-entropy path segments and sensitive text patterns are redacted, and the user explicitly copies the resulting report before it can reach another tool.

## VS Code bridge

The VS Code companion does not expose TCP, remote debugging, a renderer socket,
or a webpage API. Electron main owns a random per-launch Windows named pipe and
an owner-local rendezvous file. Ed25519 device identities are stored with
Electron `safeStorage` and VS Code `SecretStorage`; ephemeral X25519/HKDF keys
protect 15-minute AES-256-GCM sessions with signed negotiation, sequence-bound
frames, replay rejection, strict size limits, and automatic reconnect/rekey.

VS Code Workspace Trust and a separate modal folder grant are both mandatory.
Every path is canonicalized and kept beneath that folder; traversal, symlinks,
UNC escapes, secret names, and browser profiles are refused. Commands are
detected from trusted files, executed without a browser-supplied shell string,
and require an exact executable/argument/cwd approval keyed to a fingerprint.
Live checks are passive and origin-approved; payment, banking, checkout, crawl,
attack, and credential-guessing targets are blocked.

Page tests use new Playwright contexts without imported cookies, storage,
passwords, or headers. Reports remain in extension-local storage. AI diagnostic
bundles are double-redacted; DOM metadata and screenshots default off. Model
edits require workspace containment, a matching current file hash, a visible
VS Code review, and modal approval before `WorkspaceEdit` can apply them.

## Release service

Installer binaries are private R2 objects. D1 contains only release metadata and the R2 object key. Desktop checks use a client-only bearer token stored through Electron `safeStorage`; the renderer receives status and signed URLs, never the token. Publishing uses a separate administrator key.

Download-page and binary URLs are HMAC-signed, purpose-bound and expire after 15 minutes. Signatures bind binary access to the active D1 release ID, so replacing the active release invalidates prior installer links. Invalid or expired credentials return a generic `404`. Responses disable caching and referrers, and the page uses a restrictive Content Security Policy and `noindex` controls.

Installers ship **without** an embedded download credential by default. A private single-user build may opt in by setting the repository variable `PRIVATE_BROWSER_BUNDLE_UPDATE_TOKEN` to `true`, which bundles a CI-generated bootstrap holding the shared client download token so the build connects on first launch. The app copies it into OS-encrypted storage and removes the bootstrap file — and removes it even when OS encryption is unavailable and the value could not be stored, rather than leaving a shared credential readable on disk.

That opt-in is deliberately awkward, because a credential distributed inside a desktop installer can be extracted by anyone holding the file, and this one is shared by every client rather than issued per device. Any installer built with it must be treated as carrying a public token: rotate `PRIVATE_BROWSER_DOWNLOAD_TOKEN` before the file goes anywhere beyond the machine it was built for. Production enrollment should issue revocable device-specific credentials instead.

The Worker checks R2 object size against D1 before publication and again before serving. The release workflow calculates SHA-256 from the exact installer uploaded to R2. Resumable downloads are restricted to one validated byte range per request.

## Credentials in the repository

No credential is ever stored in a tracked file. `.gitignore` is itself committed and public; it keeps named paths out of the index and nothing more, and `git add -f` bypasses it entirely. Enforcement is [scripts/secret-guard.mjs](scripts/secret-guard.mjs), which refuses vendor token shapes, private key blocks, URLs carrying embedded credentials, and any path that names an environment or key file regardless of its contents.

It reads credential assignments in both forms, because both have appeared here: a quoted literal in source, and an unquoted `NAME=VALUE` dotenv line — the latter only when the whole line has that shape, so ordinary code such as `const token = randomUUID()` is not flagged. Names are matched as substrings of the surrounding identifier: `PRIVATE_BROWSER_ADMIN_API_KEY` must match, and a word-boundary anchor never fires there because `_` is a word character. Values are dismissed as fixtures only on evidence — a documented placeholder, a repeated character, a run of six consecutive characters, or lowercase words joined by separators with no digit anywhere. One uppercase letter or one digit is enough to disqualify a value from that dismissal.

It runs in two places: `.githooks/pre-commit` scans staged additions and blocks the commit, and `npm run secrets:check` scans every tracked file as the first step of `npm run check`, so a secret cannot survive by never being re-staged. A deliberate fixture is exempted with a `secret-guard:allow` marker on the line — the exemption is per line, visible in review, and never a directory or file-wide silence.

Local values belong in `.env` or `cloudflare/.dev.vars`; production values are set with `wrangler secret put`, which cannot be read back, so the value is recorded in the operator's own vault first. A credential that reaches a commit stays in history after deletion. Rotate it; do not delete it and assume it is gone.

## Known external requirement

The generated Windows installer is reproducible and the workflow is ready to
sign when `WINDOWS_CODE_SIGNING_CERTIFICATE` and
`WINDOWS_CODE_SIGNING_PASSWORD` repository secrets are configured. Until then,
the release remains unsigned and Windows can show an unknown-publisher warning.
A commercial URL-reputation feed is also still required for live phishing and
malware-site intelligence; Google Safe Browsing's free service is not licensed
for this business use case.

## Reporting

Do not open a public issue containing credentials or private browsing data. Rotate any exposed credential before reporting a security problem.
