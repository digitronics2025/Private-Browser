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
  - electron/google-connection-health.ts
  - electron/google-oauth.ts
  - electron/google-scopes.ts
  - electron/google-services.ts
  - electron/google-token-broker.ts
  - electron/google-website-status.ts
  - electron/ipc-contracts.ts
  - electron/oauth-loopback.ts
  - electron/runtime-state-store.ts
verified_at: 028b9d2d
---

# Google Account Spaces

> Last verified: 2026-09-26

## Agent Brief

Account Spaces are the dynamic container layer inside the fixed Digitronics,
TenTen, Development, Personal and Banking workspaces. A workspace remains the
policy boundary; an Account Space owns one browser partition, tabs, bookmarks,
history, exact-origin permission grants and an optional Google API grant.

Start here for any account, Google OAuth, Google service, permission, migration,
recovery or encrypted-backup change. The integration never exposes a partition
key, refresh token or Google subject to the renderer.

Account Manager displays the selected account's last successful Google
request and the next step for reconnect, missing permission, offline or
quota responses. An explicit Google operation updates these states. The
card reads local status and performs no Google request. The last successful
time is saved with the encrypted account record and removed on disconnect.

## Security invariants

1. Each Account Space has a random opaque UUID. New partitions are
   `persist:private-browser-account-<uuid>`; migrated defaults retain the exact
   legacy `persist:private-browser-<workspace>` partition.
2. An Account Space belongs to exactly one workspace. Every operation validates
   both the UUID and membership before reading state, opening a tab or selecting
   a session.
3. A workspace always has at least one Account Space, and an Account Space always
   has at least one tab. Tab IDs are globally unique before runtime views are
   materialized. The sole account cannot be deleted.
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
opaque Account Space references, active account references, tracker preference,
interface preferences (`ui`: theme, bookmarks-bar mode, side panel and New Tab
background) and the privacy log. Each account has a separate plaintext browsing
file for tabs, bookmarks, history, once customised, up to 12 HTTP(S) New Tab
shortcuts and, once visited, up to 300 remembered icons of bookmarked hosts
(`bookmarkIcons`, inert image `data:` URLs). Deleting an Account Space removes its
shortcuts and icons with its other state.
Details: [workspaces-and-state.md](workspaces-and-state.md). Encrypted `<uuid>.account.enc` records hold label,
colour, workspace ownership, partition key, Google identity, refresh token,
grants, modules, permissions and backup settings.

Exact-origin popup preferences (`Ask`, `Allow`, or `Block`) are stored in that
same encrypted Account Space record. They are independent across Account Spaces;
missing preferences migrate to `Ask`. Banking policy denies popups before any
saved preference is consulted. See [SECURITY.md](../../SECURITY.md) for blank
popup opening and subsequent navigation safeguards.

Version-1 migration is transaction-like:

1. Hash the original `browser-state.json` and write a timestamped byte-for-byte
   backup plus a migration journal.
2. Derive stable opaque IDs from the source fingerprint so interrupted retries
   reuse the same accounts.
3. Stage encrypted records and per-account browsing files.
4. Publish `browser-state-v2.json` last. Never overwrite the v1 source with v2.

Unknown or malformed v2 state opens read-only recovery. The original and a
timestamped backup remain untouched. Available actions are retry, open backup
location, restore v1 and explicitly confirmed fresh start. Restore v1 first
preserves every per-account file, because re-migration reuses the same ids. An
individual corrupt account receives the same treatment without disabling other
accounts: it stays in the manifest and its files are never written until the
recovery is resolved, and a fresh start takes its workspace from whichever of
its record or browsing file is still readable.

## Session and lifecycle behavior

Tabs in one Account Space resolve through the same persistent Electron session.
Popups become tabs in the originating account. Bookmarks, history, favicons,
downloads and open/move-link operations carry the account UUID. Only the active
account is restored eagerly at startup.

Lock is an operational privacy control, not another Windows authentication
boundary: it closes views and Google connections, clears memory-only tokens and
sensitive caches, cancels operations, and blocks use until reopened. Locking
the active account first switches the workspace to an unlocked sibling (the
lock is refused if none exists), and no page view is ever built for a locked
account. A token refresh in flight when the account is locked or disconnected
is discarded.

Deletion closes every view, cancels work, revokes the Google grant when one
exists (and refuses to delete if revocation fails), removes all session storage
with Electron, verifies cookies and cache are gone, then removes the plaintext
browsing file, permissions and encrypted metadata. At startup, a legacy
per-workspace partition that no account owns any more is cleared, unless any
account is in recovery. It never enumerates or clears another partition. Disconnecting Google
API access does not clear website cookies; clearing website data does not revoke
Google API access.

Account access overview shows the selected space's website session, enabled
Google modules and backup status. Local disconnect removes its stored Google
tools connection. Google revocation retries after network failure. Clearing
website data resets that space's website status to Not visited.
[Manage linked apps in Google Account](https://support.google.com/accounts/answer/13533235)

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
once application-wide, checked against the spaces that exist when the grant is
saved. A reconnect must return the same `sub` the space already holds; a
different Google account is refused (`GOOGLE_POLICY_DENIED`). A failed or
cancelled reconnect leaves an existing grant's status as it was.

Avatar URLs must be HTTPS on `googleusercontent.com` or a subdomain. Downloads
reject redirects, stop at 512 KiB, and accept only PNG, JPEG or WebP magic bytes.

The Account Space manager separates website sign-in in the selected partition
from Google tools authorization in an external browser. A space added for Google
tools stays pending until identity authorization succeeds. Cancellation retains
the named space so its owner can resume or delete it. Pending setup is stored in
the encrypted account record. The connecting status is temporary.

Google installed-app OAuth starts with identity scopes. Each tool describes its
own access and requests a change only when selected. It requests the complete
approved scope set, checks the token response and atomically replaces the grant.
Turning off a tool narrows local access. To remove server-side permissions, revoke
the grant in Google and connect again.

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

The Account Space manager offers an on-demand overview in the active, unlocked
Google space. It shows only enabled read modules. Gmail displays recent inbox
headers, Drive displays allowed files, and Calendar displays upcoming primary
calendar events. Each section loads up to 10 items per page and 50 per visit.
Results and paging state stay in memory. Original links open in the same space.
This view uses the existing grants and does not request expanded access.
See [Review Google actions](../google-action-review.md) for replies, shares,
meeting invitations and encrypted retry receipts.

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

Before uploading, compare this computer's counts with the latest encrypted
backup and the counts a merge would produce. The confirmation applies to the
reviewed local data and remote file revision. If either changes, start a new
review. The newest encrypted backup keeps up to two earlier generations within
the existing 8 MiB limit. Choose an earlier generation in Restore to review its
items before adding them. Only ciphertext goes to Drive.

New backups default to a local 14-day reminder. Choose 7, 14 or 30 days, or turn
it off in the Account Space manager. A due reminder appears on New Tab in the
owning, unlocked space. Saving a backup advances the reminder date.

Backup uses Node `crypto` AES-256-GCM with a random 256-bit recovery key and a
versioned authenticated envelope. The recovery code is shown once and must be
re-entered before its key is wrapped with `safeStorage`. Google receives only
ciphertext in `appDataFolder`.

Bookmarks, settings and future bookmark-folder-compatible records are included;
open tabs are optional and history is separately opt-in. Cookies, tokens, codes,
passwords, passkeys/TOTP, downloads, mail bodies, attachments, AI privacy logs
and My Vault are excluded. ETags detect conflicts and require explicit merge or
overwrite. A bad authentication tag or missing recovery key stops restore.

On a replacement PC, connect the same Google account and enable the encrypted
backup tool in the same workspace. **Verify and preview backup** checks the
recovery code and shows the backup date, destination, additions, duplicates and
capacity limits without writing browser data. **Add reviewed items** merges the
exact preview once and keeps existing data in place. Restored tabs stay paused.
Changes to the destination or Google identity invalidate the preview.
Restore (`restorableItems`) re-stamps items with the target space's id — a new
device has new local ids — requires the same workspace, passes everything through
the on-disk state validator, and never applies the browser-wide tracker setting.

## UI and tests

The toolbar profile avatar (Account Space colour ring, warning badge only when
action is required) opens a menu listing workspaces and only the accounts in the
active workspace, with keyboard cycling. The manager provides local/Google add,
rename, recolour, reorder, module reconnect, service launch, lock, clear,
disconnect and delete. Tab, tab-move, mute and bookmark-editing IPC act only on
the active Account Space; `ipc-contracts.ts` validates their shapes (it also
validates the `side-app:*` channels, which belong to no Account Space — see
[side-apps.md](side-apps.md)). The native
page view is hidden below account, permission, recovery and other content-covering
overlays after the main process acknowledges the hide. An eligible still image
may cover the page behind a menu; Banking and protected pages use a neutral
surface. Focus returns on close.

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

Chrome import, bookmark folders and the bookmark bar are implemented and scoped
to the explicitly selected Account Space. Chrome Sync is not implemented or
advertised, and imports intentionally exclude live sessions and Google tokens.

**Import from Chrome** suggests a destination by matching a local profile name
to an unlocked Account Space in the current workspace. A destination remains
explicit. Bookmarks and history go to that space. Search engine, Home page,
and startup settings are separate opt-ins for the workspace. The local
receipt records an opaque profile key and destination ID so the same detected
profile does not import twice. A complete undo within the current session
reopens that profile for import. Changed bookmarks and settings stay in place.

For migration rollback, close the app, keep every timestamped recovery file,
choose **Restore v1** in the recovery screen, and restart. Never rename an
encrypted account file across accounts or manually transplant a partition key.
For an individual corrupt account, use its scoped fresh-start option only after
preserving the offered backup; healthy accounts remain authoritative.
