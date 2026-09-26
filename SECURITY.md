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

Each Account Space uses a separate persistent Electron session partition,
preventing cookies and authenticated sessions from crossing accounts. Fixed
workspaces remain policy boundaries: Banking denies privileged behavior before
any Account Space grant is consulted, while Development retains controlled
DevTools. New partition names and Google subjects never cross the preload bridge.

The browser chrome draws menus and dialogs over the page area by briefly hiding
the native page view. So that the page does not disappear behind an open menu,
the main process may hand the trusted chrome renderer a still JPEG of the active
page (`browser:freeze-content`). The image is held in renderer memory only while
the menu is open and never written to disk or sent anywhere. It is never produced
for Banking or other protected workspaces, for `isProtectedPage` URLs, or for a
hidden view; those show a neutral backdrop instead. Page layout insets sent by the
renderer are clamped so the address bar and its security warning can never be
covered by page content.

The Claude side panel is a remote page under the same rules: its own sandboxed
view with no preload, its own session partition that no tab shares, no access to
any tab's content, top-level navigation limited to Claude's own and its sign-in
providers' hosts (everything else opens as an ordinary tab), only clipboard
write permission, dangerous downloads refused, and a renderer-supplied rectangle
clamped to the side panel. It is hidden and cannot open tabs while Banking is
active. Browser extensions are not supported.

## Vault

MyVault stores credentials, TOTP secrets and passkeys in one envelope encrypted with AES-256-GCM under a random data key, which is itself wrapped by a key derived from the master password with Argon2id. The device token, sync state, Windows Hello wrap and remembered picks are separate files encrypted with Electron `safeStorage`. Files are written with owner-only mode bits, which Windows ignores; there the protection is the user profile's own access control. Vault metadata exposed to the UI never contains passwords or TOTP secrets. Passwords and TOTP values are copied directly by the main process and cleared from the clipboard after 30 seconds if unchanged; only a digest of the copied value is kept for that check. Windows clipboard history (Win+V), when the user has it turned on, keeps its own copy that this clear does not reach — the copy message says so, and Fill avoids the clipboard entirely.

Windows Hello unlock is optional and requires the master password to turn on. It stores a second copy of the vault data key, encrypted under a key derived from a Windows Hello signature that the TPM-backed Hello container produces only after face, fingerprint or PIN; that copy is itself `safeStorage`-encrypted. It never replaces the master password, which remains the only way to unlock on another device or after the Hello key is removed.

If the vault cannot be decrypted, writes are disabled to prevent silent data loss. The recovery action preserves the unreadable encrypted file as a timestamped backup before creating a new vault.

Automatic fill and the side panel's Fill require an exact origin match — scheme, host and port. Only the login picker (below) relaxes the scheme, and only upward: a login saved for `http` may be picked on the `https` page of the same address, and a credential saved for `https` is never filled into an `http` page. A website can still observe credentials entered into its own form, just as it can in any password manager; users must verify the domain before filling.

The login picker (the list of saved accounts under a focused sign-in field) is drawn by the browser, not the page. It is a separate sandboxed view with context isolation, no Node, no DevTools, a nonce CSP and a preload with exactly two channels (`fill-picker:choose`, `fill-picker:highlight`). The page receives nothing from it, and it receives only usernames, titles and saved hosts, never an entry id or a secret. Besides exact-origin logins it offers, as Chrome does, logins saved for other addresses of the same site: same registrable domain per the Public Suffix List (so `a.co.ma` and `b.co.ma` are different sites), same port, never an https credential into an http page, and never for IP addresses, `localhost` or punycode. Each is labelled with the address it was saved for and fills only when the user picks it; nothing fills a same-site login automatically. The last pick per site is remembered on this device in `safeStorage` ciphertext only. It opens only in response to genuine user input, and a choice is a row index honoured once, from that view, while the fill context is unchanged. Banking and Development never show it.

## Account Spaces and local browsing data

Saved credentials, Account Space metadata and grants, the AI provider key and the
download-service token are encrypted with Electron `safeStorage`. Each account
has an independent encrypted file so corruption is quarantined. **Browsing
history, bookmarks, open-tab URLs and the privacy log are not encrypted**; they
are split into a minimal v2 manifest and per-account JSON. Anyone running as the
Windows user may read those URLs and titles. Plaintext state contains only opaque
account/workspace IDs, never email, Google subject, partition key or OAuth data.

Version-1 migration preserves the source and a timestamped byte-for-byte backup,
stages per-account files first and publishes the manifest last. Unknown/corrupt
state opens read-only recovery. A fresh start or restore requires explicit
confirmation and preserves the unreadable input.

Google OAuth uses external allowlisted browser executables, PKCE S256 and an
exact single-use loopback callback. The official library verifies ID-token
signatures; issuer, audience, expiry, nonce, verified email and unique stable
subject are checked before encrypted storage. Refresh tokens are encrypted;
access/ID tokens, codes and PKCE values remain memory-only. Avatar downloads are
Google-host-only, redirect-free, bounded and magic-byte validated.

## AI data controls

- The Banking workspace rejects page extraction outright. Detected banking and
  payment pages are also rejected, but that detection is a best-effort keyword
  match and cannot cover every institution — the workspace is the guarantee, the
  keyword list is a safety net. It errs towards refusing.
- Page extraction reads rendered text only and never reads input values, cookies, local storage or authentication headers.
- Sensitive-pattern redaction runs locally before preview.
- Page previews for the AI assistant include only the page origin: query parameters, paths and fragments are never shared. Developer diagnostics previews (Development workspace only) include the sanitized origin and path, never the query or fragment, and are shown in full before approval.
- The user approves the exact sanitized preview through a five-minute, single-use capability token.
- Approval also binds the opaque Account Space, exact tab, Google-service class
  and source revision. Mailbox content is never cloud-model input.
- Every local read, approval, denial and vault access is logged without secret values.
- Cloud AI is disabled until the user configures a public HTTPS OpenAI-compatible provider. The API key is OS-encrypted and never returned to the renderer.
- Provider redirects are rejected to prevent HTTPS-to-local-network request pivots.

## Permissions

Remote sites are denied sensitive Electron permissions by default. Decisions are
keyed by Account Space, exact origin and capability, with deny/once/session/always
choices. Notifications are restricted to exact Gmail, Calendar and Meet origins;
camera/microphone and display capture are Meet-only, and display capture requires
the active visible tab plus a source picker every time. Banking denies before
saved grants. Popups become tabs in the originating account, except a
`window.open` popup from the page in front (payment and sign-in flows), which
opens as a sandboxed, preload-free window in the same account session, titled
with its host, confined to http(s), and closed with its tab.

Google service access uses narrow main-process clients, bounded ten-second
requests and scope checks. Gmail sends, calendar mutations, Drive permission
changes and AI-initiated writes require payload-bound single-use confirmations.
Encrypted Drive backup uses AES-256-GCM and `drive.appdata`; it excludes cookies,
tokens, mail/file contents, downloads, AI logs and My Vault.

Every site permission requires a top-level HTTPS page (or a localhost
development page). Banking denies every site permission, popup and download. Common campaign
identifiers are removed from navigations, DNT and Global Privacy Control headers
are sent, common tracker hosts are blocked, and cleartext or punycode domains are
visibly marked in the address bar.

Private Browser opens only documents, images, media and archives. Every other
download type — executables, scripts, installers such as `.msix`, disk images,
shortcuts — and every deceptive double extension is labelled and cannot be
opened from Private Browser unless it matches the checksum of the release
manifest. This does not replace operating-system malware scanning.

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
and require an exact executable/argument/cwd approval keyed to a fingerprint
(for a Playwright run, the runner, test kind, project and target URL).
Live checks are passive and origin-approved; payment, banking, checkout, crawl,
attack, and credential-guessing targets are blocked.

Page tests use new Playwright contexts without imported cookies, storage,
passwords, or headers. Reports remain in extension-local storage. AI diagnostic
bundles are double-redacted; DOM metadata and screenshots default off. Model
edits require workspace containment, a matching current file hash, a visible
VS Code review, and modal approval before `WorkspaceEdit` can apply them.

## Release service

**Distribution is public.** Anyone may download the current stable installer
from the Worker's landing page, which is deliberately indexable
(`x-robots-tag: index, follow`), and anyone may read the release manifest at
`/api/v1/releases/public/latest`. The premise this service protects is that
the installer a user receives is exactly the one built from this repository —
not that only some people can obtain it. That was decided when the public page
was added (`bbdb394`) and recorded in the 2026-09-24 pre-release audit.

Installer binaries are R2 objects with no public bucket access; every download
goes through the Worker. D1 contains only release metadata and the R2 object
key. Desktop update checks use the public manifest by default; an optional
client bearer token, stored through Electron `safeStorage`, selects the
private `/update.json` feed instead. The renderer receives status and signed
URLs, never a token. Publishing uses a separate administrator key.

Binary and private-page URLs are HMAC-signed, purpose-bound and expire after 15
minutes. Signatures bind binary access to the active D1 release ID, so replacing
the active release invalidates prior installer links. Invalid or expired
credentials return a generic `404`. Responses disable caching and referrers and
carry a restrictive Content Security Policy; the private token pages
(`/download/<token>`) are `noindex`.

Installers ship **without** an embedded download credential. The repository
variable `PRIVATE_BROWSER_BUNDLE_UPDATE_TOKEN=true` builds a private
single-user installer that bundles the shared client token; because
distribution is public, **CI refuses to publish such a build** — it stays a
GitHub artifact for the one machine it was made for, and the token must be
rotated before that file goes anywhere else. The app copies the bundled token
into OS-encrypted storage and removes the bootstrap file, even when OS
encryption is unavailable. Production enrollment should issue revocable
device-specific credentials instead.

The Worker checks R2 object size against D1 before publication and again before
serving. The release workflow calculates SHA-256 from the exact installer
uploaded to R2, and the desktop app verifies a downloaded installer against the
manifest before it will open it. Resumable downloads are restricted to one
validated byte range per request.

## Credentials in the repository

No credential is ever stored in a tracked file. `.gitignore` is itself committed and public; it keeps named paths out of the index and nothing more, and `git add -f` bypasses it entirely. Enforcement is [scripts/secret-guard.mjs](scripts/secret-guard.mjs), which refuses vendor token shapes, private key blocks, URLs carrying embedded credentials, and any path that names an environment or key file regardless of its contents.

It reads credential assignments in both forms, because both have appeared here: a quoted literal in source, and an unquoted `NAME=VALUE` dotenv line — the latter only when the whole line has that shape, so ordinary code such as `const token = randomUUID()` is not flagged. Names are matched as substrings of the surrounding identifier: `PRIVATE_BROWSER_ADMIN_API_KEY` must match, and a word-boundary anchor never fires there because `_` is a word character. Values are dismissed as fixtures only on evidence — a documented placeholder, a repeated character, a run of six consecutive characters, or lowercase words joined by separators with no digit anywhere. One uppercase letter or one digit is enough to disqualify a value from that dismissal.

It runs in two places: `.githooks/pre-commit` scans staged additions and blocks the commit, and `npm run secrets:check` scans every tracked file as the first step of `npm run check`, so a secret cannot survive by never being re-staged. A deliberate fixture is exempted with a `secret-guard:allow` marker on the line — the exemption is per line, visible in review, and never a directory silence. The guard itself and its test are the only whole-file exemptions, because they must contain the patterns they hunt for.

Local values belong in `.env` or `cloudflare/.dev.vars`; production values are set with `wrangler secret put`, which cannot be read back, so the value is recorded in the operator's own vault first. A credential that reaches a commit stays in history after deletion. Rotate it; do not delete it and assume it is gone.

## Known external requirement

The workflow is ready to sign the Windows installer when `WINDOWS_CODE_SIGNING_CERTIFICATE` and
`WINDOWS_CODE_SIGNING_PASSWORD` repository secrets are configured. Until then,
the release remains unsigned and Windows can show an unknown-publisher warning.
A commercial URL-reputation feed is also still required for live phishing and
malware-site intelligence; Google Safe Browsing's free service is not licensed
for this business use case.

## Reporting

Do not open a public issue containing credentials or private browsing data. Rotate any exposed credential before reporting a security problem.
