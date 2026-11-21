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

The Claude and Notes side panels are remote pages under the same rules: each has a sandboxed
view with no preload and a session partition that no tab shares, no access to
any tab's content, top-level navigation limited to each app's allowed
hosts (Notes uses its exact workers.dev host only) (everything else opens as an ordinary tab), only clipboard
write permission, dangerous downloads refused, and a renderer-supplied rectangle
clamped to the side panel. Each is hidden and cannot open tabs while Banking is
active. Browser extensions are not supported.

Notes uses its own persistent partition across unprotected workspaces, separate
from Claude and all Account Spaces. Its cloud deployment intentionally retains
personal shared access; loading it in the panel does not privatize it. IndexedDB
is not Vault-encrypted. Local data clearing is deliberate and partition-local;
cloud data is preserved. No page capture, insertion, clipboard read or AI sharing
is added.

## Vault

MyVault stores credentials, TOTP secrets and passkeys in one envelope encrypted with AES-256-GCM under a random data key, which is itself wrapped by a key derived from the master password with Argon2id. The device token, sync state, Windows Hello wrap and remembered picks are separate files encrypted with Electron `safeStorage`. Files are written with owner-only mode bits, which Windows ignores; there the protection is the user profile's own access control. Vault metadata exposed to the UI never contains passwords or TOTP secrets. Passwords and TOTP values are copied directly by the main process and cleared from the clipboard after 30 seconds if unchanged; only a digest of the copied value is kept for that check. The Windows vault copy writes the OS exclusion format atomically with the text to keep it out of clipboard history and sync. Clear now and normal quit remove the unchanged vault copy. Fill avoids the clipboard entirely.

Windows Hello unlock is optional and requires the master password to turn on. It stores a second copy of the vault data key, encrypted under a key derived from a Windows Hello signature that the TPM-backed Hello container produces only after face, fingerprint or PIN; that copy is itself `safeStorage`-encrypted. It never replaces the master password, which remains the only way to unlock on another device or after the Hello key is removed.

If the vault cannot be decrypted, writes are disabled to prevent silent data loss. The recovery action preserves the unreadable encrypted file as a timestamped backup before creating a new vault.

Automatic fill and the side panel's Fill require an exact origin match — scheme, host and port. Only the login picker (below) relaxes the scheme, and only upward: a login saved for `http` may be picked on the `https` page of the same address, and a credential saved for `https` is never filled into an `http` page. A website can still observe credentials entered into its own form, just as it can in any password manager; users must verify the domain before filling.

The login picker (the list of saved accounts under a focused sign-in field) is drawn by the browser, not the page. It is a separate sandboxed view with context isolation, no Node, no DevTools, a nonce CSP and a preload with exactly two channels (`fill-picker:choose`, `fill-picker:highlight`). The page receives nothing from it, and it receives only usernames, titles and saved hosts, never an entry id or a secret. Besides exact-origin logins it offers, as Chrome does, logins saved for other addresses of the same site: same registrable domain per the Public Suffix List (so `a.co.ma` and `b.co.ma` are different sites), same port, never an https credential into an http page, and never for IP addresses, `localhost` or punycode. Each is labelled with the address it was saved for and fills only when the user picks it; nothing fills a same-site login automatically. Each Account Space remembers its last pick per site on this device in `safeStorage` ciphertext. Reset remembered picks clears only the active Account Space. It opens only in response to genuine user input, and a choice is a row index honoured once, from that view, while the fill context is unchanged. Banking and Development never show it.

## Account Spaces and local browsing data

Optional Windows session and idle locking close live views, clear transient
credentials, and pause the developer and Agent bindings. The old chrome
renderer is replaced. While locked, only an empty snapshot and Exit are
available through its IPC. The profile marker contains only the lock reason.
An observed Windows lock and unlock is required to resume, including after
restarting the app.

Saved credentials, Account Space metadata and grants, the AI provider key and the
download-service token are encrypted with Electron `safeStorage`. Each account
has an independent encrypted file so corruption is quarantined. **Browsing
history, bookmarks, open-tab URLs, routines and the privacy log are not encrypted**; they
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
- The Assistant shows the exact sanitized messages, provider destination and
  model before an explicit one-time send. The review is bound to the five-minute
  read window and the page navigation.
- Approval also binds the opaque Account Space, exact tab, Google-service class
  and source revision. Mailbox content is never cloud-model input.
- Every local read, approval, denial and vault access is logged without secret values.
- Cloud AI is disabled until the user configures a public HTTPS OpenAI-compatible provider. The API key is OS-encrypted and never returned to the renderer.
- Local AI uses a fixed Ollama loopback address from the main process. It checks
  that cloud features are disabled and the selected model is installed locally
  before transmitting approved text. Local approvals bind to the local
  destination and cannot be spent on cloud or bridge requests.
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

Tracker counters and ten-minute compatibility settings are memory-only, scoped
to Account Space and exact top-level origin. Banking always blocks known trackers.
Compatibility does not apply to protected pages, Agent Mode restrictions or
requests without a verified top-level frame.

Only the active, eligible Account Space can list, open or reveal its downloads.
Download folder selection uses a native directory picker and encrypted
per-account preferences. The full paths stay in main. Automatic placement
never overwrites a file at the destination. Operating-system links are
restricted to eligible regular Account Spaces, even with Banking in front.

Private Browser opens only documents, images, media and archives. Every other
download type — executables, scripts, installers such as `.msix`, disk images,
shortcuts — and every deceptive double extension is labelled and cannot be
opened from Private Browser unless it matches the checksum of the release
manifest. The main process rechecks the installer before opening it.
Authenticode publisher evidence is displayed separately and grants no
additional open permission.

## Developer tools

Chromium DevTools attach only to non-home pages in the Development workspace. They are refused in every other workspace and on detected banking or payment URLs, and are closed whenever the user switches tabs or workspaces or a tab commits a protected navigation. Page context menus expose exact element inspection only inside that boundary.

The native page menu is unavailable in Banking and on detected protected pages.
It rechecks the active page and frame before acting. Paste and copy use native
edit commands in the focused source frame. Image saving follows the originating
Account Space's download permission.

Developer diagnostics are process-memory-only, bounded per tab, and collect only console warnings/errors, failed-request method/status/type, sanitized source URLs, and aggregate document counts. They never collect page text, input values, cookies, local or session storage, headers, request or response bodies. URL credentials, queries and fragments are removed, high-entropy path segments and sensitive text patterns are redacted, and the user explicitly copies the resulting report before it can reach another tool.

The support report in Setup, Recovery, Updates, side apps and Developer Bridge
uses an allowlist of reason codes and next actions plus the app version. The
preview and clipboard use the same text, with no live error string or page data.

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

## Agent Mode

Agent Mode starts off and uses a dedicated Agent Workspace. Agent tabs are
sandboxed, preload-free views backed by independent persistent Chromium
partitions. Main resolves tab and space identifiers from a private registry.
Banking, regular Account Spaces, MyVault, browser import, Google connections,
sync, clipboard access and device permissions are outside that registry.

Local coding agents connect over stdio and a separate encrypted named pipe
or owner-only Unix socket. Agent identities and approval state are distinct
from VS Code and Control Center. Electron keeps signing keys and audit
records in OS-encrypted storage. The CLI uses DPAPI or Secret Service.

Main checks the current document and effective space policy on every page
action. Work allows interaction only on explicitly granted origins and sends
unlisted pages to a credential-free preview or blocks them. Open Web uses a
disposable partition and a local public-network guard. The MCP protocol
cannot grant space access, change policy, or renew sessions. Fixed page
diagnostics require a granted Work loopback origin. Human approval happens in trusted Agent
Workspace chrome and binds an action to the session, tab, address and DOM
revision. Protected addresses are refused. Stop closes sessions, views and
pending confirmations. A page action already completed by a remote server
cannot be undone by Stop.

Tool output marks page content untrusted. Sensitive controls are filtered or
masked, and request logs omit queries, headers and bodies. Link the
[Agent Mode threat model](docs/systems/agent-mode.md) when reviewing changes
to these permissions or to the Agent Workspace boundary.

### Owner-lent tabs

The trusted tab menu lets the owner choose a connected client for one active
tab. A loan ends after fifteen minutes at most and is scoped to its exact
origin. Switching browser tabs, crossing that origin, stopping the client,
opening Developer Tools, or disconnecting ends the loan. The broker assigns a
temporary ID and never accepts a regular browser tab ID through MCP.

Banking, protected sites, Google account and service pages, pages with
certificate errors, and views already attached to a debugger are refused.
The owner sees the active client's name and Stop in the tab strip. Every page
write requires a separate confirmation in the trusted Agent Workspace. Loans
block popups, downloads, login picker, automatic fill and new device
permissions. Downloads, emulation and scripting diagnostics require an Agent
Account Space. Returning a lent tab detaches the Agent debugger and keeps the
owner's tab open.

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

Managed updates use a main-process HTTPS stream without redirects, a private
staging directory, an installer size cap, and the Windows Internet zone marker.
Opening requires an explicit action in an unlocked regular Account Space,
a fresh matching release manifest, and a second hash of the staged file.

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
