---
system: google-account-spaces
sources:
  - electron/account-backup.ts
  - electron/account-permissions.ts
  - electron/account-session.ts
  - electron/account-space-state.ts
  - electron/account-space-validation.ts
  - electron/account-store.ts
  - electron/external-browser.ts
  - electron/google-backup-transport.ts
  - electron/google-config.ts
  - electron/google-confirmations.ts
  - electron/google-oauth.ts
  - electron/google-scopes.ts
  - electron/google-services.ts
  - electron/google-token-broker.ts
  - electron/google-website-status.ts
  - electron/ipc-contracts.ts
  - electron/oauth-loopback.ts
  - electron/runtime-state-store.ts
verified_at: f6f0c96
---

# Google Account Spaces

> Last verified: 2026-09-12

## Agent Brief

Account Spaces are the dynamic container layer inside the fixed Digitronics,
TenTen, Development, Personal and Banking workspaces. A workspace remains the
policy boundary; an Account Space owns one browser partition, tabs, bookmarks,
history, exact-origin permission grants and an optional Google API grant.

Start here for any account, Google OAuth, Google service, permission, migration,
recovery or encrypted-backup change. The integration never exposes a partition
key, refresh token or Google subject to the renderer.

## Security invariants

1. Each Account Space has a random opaque UUID. New partitions are
   `persist:private-browser-account-<uuid>`; migrated defaults retain the exact
   legacy `persist:private-browser-<workspace>` partition.
2. An Account Space belongs to exactly one workspace. Every operation validates
   both the UUID and membership before reading state, opening a tab or selecting
   a session.
3. A workspace always has at least one Account Space, and an Account Space always
   has at least one tab. The sole account cannot be deleted.
4. Banking policy is evaluated before stored grants. Banking denies AI,
   DevTools, popups, downloads and all site permissions. Development alone keeps
   controlled DevTools.
5. Encrypted account files are independent. One unreadable file is quarantined
   and cannot make healthy accounts unreadable.
6. Refresh tokens are encrypted at rest. Access tokens, ID tokens, authorization
   codes, PKCE material, callback state, mail bodies, search strings, contacts,
   event descriptions and file contents are memory-only.
7. Website-session status and Google API authorization are independent. Cookie
   presence is reported only as `session-data-present`, never as authenticated.

## Persistence and migration

The plaintext `browser-state-v2.json` manifest contains only active workspace,
opaque Account Space references, active account references, tracker preference
and the privacy log. Each account has a separate plaintext browsing file for
tabs, bookmarks and history. Encrypted `<uuid>.account.enc` records hold label,
colour, workspace ownership, partition key, Google identity, refresh token,
grants, modules, permissions and backup settings.

Version-1 migration is transaction-like:

1. Hash the original `browser-state.json` and write a timestamped byte-for-byte
   backup plus a migration journal.
2. Derive stable opaque IDs from the source fingerprint so interrupted retries
   reuse the same accounts.
3. Stage encrypted records and per-account browsing files.
4. Publish `browser-state-v2.json` last. Never overwrite the v1 source with v2.

Unknown or malformed v2 state opens read-only recovery. The original and a
timestamped backup remain untouched. Available actions are retry, open backup
location, restore v1 and explicitly confirmed fresh start. An individual corrupt
account receives the same treatment without disabling other accounts.

## Session and lifecycle behavior

Tabs in one Account Space resolve through the same persistent Electron session.
Popups become tabs in the originating account. Bookmarks, history, favicons,
downloads and open/move-link operations carry the account UUID. Only the active
account is restored eagerly at startup.

Lock is an operational privacy control, not another Windows authentication
boundary: it closes views and Google connections, clears memory-only tokens and
sensitive caches, cancels operations, and blocks use until reopened.

Deletion closes every view, cancels work, attempts Google revocation when a
grant exists, removes all session storage with Electron, verifies cookies and
cache are gone, then removes account browsing state, permissions and encrypted
metadata. It never enumerates or clears another partition. Disconnecting Google
API access does not clear website cookies; clearing website data does not revoke
Google API access.

## Desktop OAuth

Configuration accepts a Google Desktop OAuth client ID through
`PRIVATE_BROWSER_GOOGLE_CLIENT_ID` or the encrypted Settings field. There is no
client-secret field. Authorization launches a discovered Edge, Chrome or Firefox
executable with an argument array, `shell: false`, and a Google authorization
URL; it never calls the Windows default URL handler.

Each attempt creates fresh PKCE S256 verifier/challenge, state, nonce, callback
path and random `127.0.0.1` port. The receiver accepts only the exact GET path,
host header, port, loopback peer and state, closes before token exchange, is
single-use, supports cancellation and expires after five minutes. Token calls
time out after ten seconds. `google-auth-library` verifies the ID-token signature;
the app additionally requires the Google issuer, exact audience, future expiry,
nonce, verified email and non-empty stable `sub`. A `sub` may be connected only
once application-wide.

Avatar URLs must be HTTPS on `googleusercontent.com` or a subdomain. Downloads
reject redirects, stop at 512 KiB, and accept only PNG, JPEG or WebP magic bytes.

Google installed-app OAuth does not use incremental authorization here. Every
module change requests the complete selected scope set, compares the scopes in
the token response, and atomically replaces the grant. Disabling a module is
local; reducing Google's server-side grant means revoke and reconnect.

## Module scope matrix

| Module | Scope | Boundary |
| --- | --- | --- |
| Identity | `openid email profile` | Initial grant only |
| Gmail metadata | `gmail.metadata` | Unread count and recent headers |
| Gmail search/read | `gmail.readonly` | Separate expanded access |
| Gmail send | `gmail.send` | Exact single-use confirmation |
| Drive files | `drive.file` | App-authorized files only |
| Drive metadata | `drive.metadata.readonly` | Separate whole-Drive metadata |
| Drive read-all | `drive.readonly` | Separate expanded access |
| Calendar read | `calendar.events.readonly` | Read/search events |
| Calendar write | `calendar.events.owned` | Confirmed owned-event mutations |
| Contacts | `contacts.readonly` | Memory-only recipient selection |
| Encrypted backup | `drive.appdata` | Ciphertext in app data only |

Narrow clients hard-code Google endpoints. There is no generic renderer-driven
Google fetch. Reads use bounded streaming responses, ten-second timeouts,
cancellation, `Retry-After`, and jittered exponential retry. Token refresh is
coalesced per account. Writes use single-use capabilities bound to account,
service, normalized payload and optional AI source revision.

## Permissions

Decisions key on Account Space UUID, exact HTTPS origin and capability. `once`
and `session` grants stay in memory; `always` grants live in that account's
encrypted record. Notifications are limited to exact Gmail, Calendar and Meet
origins. Camera and microphone are Meet-only. Display capture requires the
visible active Meet tab, a prompt and explicit source selection every time.
Clipboard and File System API requests are prompted; ordinary HTML file inputs
remain operating-system user-gesture pickers. Downloads use the same decision
model outside Banking.

## Encrypted Drive backup

Backup uses Node `crypto` AES-256-GCM with a random 256-bit recovery key and a
versioned authenticated envelope. The recovery code is shown once and must be
re-entered before its key is wrapped with `safeStorage`. Google receives only
ciphertext in `appDataFolder`.

Bookmarks, settings and future bookmark-folder-compatible records are included;
open tabs are optional and history is separately opt-in. Cookies, tokens, codes,
passwords, passkeys/TOTP, downloads, mail bodies, attachments, AI privacy logs
and My Vault are excluded. ETags detect conflicts and require explicit merge or
overwrite. A bad authentication tag or missing recovery key stops restore.

## UI and tests

The top-right switcher exposes only accounts in the active workspace and supports
keyboard cycling. The manager provides local/Google add, rename, recolour,
reorder, module reconnect, service launch, lock, clear, disconnect and delete.
The address chip and tab accent show the active account. The native page view is
hidden below account, permission and recovery overlays; focus returns on close.

`npm run dev:preview` installs a credential-free renderer mock. Browser E2E checks
desktop/mobile switching and management. Playwright Electron creates a fresh app
profile and proves two actual persistent partitions do not share cookies, while
also asserting Banking/Development policy. Unit tests cover migration,
corruption, permissions, PKCE/callback claims, scope enforcement, retries,
confirmations, cryptography and IPC validation.

## Operator setup and verification

In Google Cloud:

1. Create or select a project and configure the OAuth consent screen.
2. Enable only the APIs required by selected modules: Gmail, Drive, Calendar and
   People.
3. Create an OAuth client with application type **Desktop app**. Do not create or
   embed a client secret.
4. While the consent screen is in Testing, add test users. Google test-mode
   refresh tokens may expire after seven days; a resulting reconnect-required
   state is not local data loss.
5. Enter the public client ID in Account Spaces settings or set
   `PRIVATE_BROWSER_GOOGLE_CLIENT_ID` in the private launch environment.
6. Run `npm run check`, `npm run test:electron`, then connect a non-sensitive test
   account and verify identity-only consent before enabling another module.

No live-Google success claim is valid without completing step 6 privately.

## Limitations and rollback

Chrome Sync, Chrome import, bookmark folders and a bookmark bar do not exist in
this checkout. Account-aware destination types are ready for those separate
features, but Account Spaces does not advertise or recreate them.

For migration rollback, close the app, keep every timestamped recovery file,
choose **Restore v1** in the recovery screen, and restart. Never rename an
encrypted account file across accounts or manually transplant a partition key.
For an individual corrupt account, use its scoped fresh-start option only after
preserving the offered backup; healthy accounts remain authoritative.
