# Private Browser pre-release audit

Date: 2026-09-24 · Commit audited: `a577936` (`origin/main`, version 0.6.7 as
published) · Production probed:
`https://private-browser-downloads.digitronics-electro.workers.dev`

This is a point-in-time review of the whole repository and of the Cloudflare
release service it deploys to, done after the 0.6.x feature run (MyVault, Account
Spaces, Google services, the VS Code bridge, the login picker and Windows Hello
unlock) and before the next release. Every finding below was checked against the
exact source lines it cites; nothing was changed in the code or in production while
producing it. It is the second audit of this repository: finding numbers continue
from [the 2026-09-10 audit](prerelease-audit-2026-09-10.md), whose findings are
tracked in §7. It does not replace an independent review of the MyVault
cryptography or a penetration test.

**Baseline note.** The main checkout held another session's uncommitted Windows
Hello work when this audit started. That work was committed and pushed as
`55a55ca`…`a577936` while the audit was being set up, so the audit ran in a clean
worktree at `a577936` and never touched the main checkout.

## Verdict

**Not ready: a password saved during a sync is silently erased, and any page on an
internationalised domain runs without its per-tab guards.** The core is in good
shape: the MyVault envelope crypto is pinned by known-answer vectors, every one of
132 IPC channels passes the trusted-sender guard, remote pages get no preload, and
all 26 findings of the previous audit have a fix commit (three only partly hold, one
regressed; §7). What stands between this and a release is a small set of races and
ordering mistakes on the vault and tab lifecycle, plus a security document that
still describes a private release service after distribution was deliberately made
public.

### Must fix before release

| # | What | Why it blocks |
|---|---|---|
| F-27 | A login saved while the vault is pulling from the cloud is erased, and the vault then reports "synced" | Loses a user's credential with no message; the most likely moment is right after unlock, when a pull always runs |
| F-28 | A tab opened on an `xn--` domain throws halfway through view creation and runs with no popup, navigation or tab-tracking guards | Any page can trigger it with `window.open`; every Arabic-script Moroccan domain is `xn--` |
| F-29 | A sync that finishes after the user locked the vault puts it back to "unlocked" | The lock the user asked for is reported as undone |
| F-34 | The login picker fills on the first mousedown after it appears | A page can turn a double-click into a same-site credential fill the user never chose |
| F-36 | The update screen calls an unsigned installer "signed" | A security claim on screen that the release does not keep |

### Decisions needed before release

- **Decide, in writing, that distribution is public — and rewrite SECURITY.md
  "Release service" to say so.** Commit `bbdb394` deliberately added an indexable
  public download page and an unauthenticated manifest. The Worker now serves the
  installer to anyone, while SECURITY.md still says installer binaries are private,
  pages are `noindex`, and desktop checks use a client-only bearer token. The
  previous audit's premise ("reachable only by people who are meant to have it") is
  therefore no longer the product's premise. Nothing is wrong with the choice; what
  is wrong is a contract that says the opposite. It also turns F-42 from hygiene
  into a real risk.

## 1. What was checked, and how

The premise used for severity (restated from the previous audit, second clause
narrowed to match the public-distribution decision):

> Browsing data, credentials and page content stay on this machine unless the user
> explicitly approves a single cloud request; every loaded website is hostile and
> never reaches privileged code; and the installer a user downloads is exactly the
> one built from this repository.

| Layer | Method | Result |
|---|---|---|
| Whole gate | `npm run check` in a clean worktree at `a577936` | Pass (exit 0) |
| Types | `typecheck`, `worker:typecheck`, `scripts:typecheck` | Pass |
| Unit | root vitest | 46 files, 345 passed |
| Unit | Worker, bridge protocol, VS Code extension | 2 files/7, 1/6, 1/24 passed |
| Browser | `test:e2e` (Playwright, chromium) | 22 passed |
| Electron | `test:electron:ci` | 18 passed |
| Skips | grep for `.skip/.only/.fixme` | Two platform skips (`electron-bridge.spec.ts:7`, `myvault-electron.spec.ts:6`, non-Windows only; both ran here). No `.only`/`.fixme`. |
| Dependencies | `npm audit --omit=dev` | 0 vulnerabilities |
| Dependencies (dev) | `npm audit` | 0 vulnerabilities |
| Code review | Main pass read in full: `vault-crypto.ts`, `vault-store.ts`, `vault-broker.ts`, `windows-hello.ts`, `sync-controller.ts`, `vault-sync.ts`, `vault-migration.ts`, `secure-dialog*.ts`, `clipboard-guard.ts`, `security.ts`. Seven read-only slice passes. | §4 |
| Reproduction | Scratch scripts against the compiled `dist-electron` modules | F-27, F-29 reproduced |
| Production | Read-only: deployments, secret names, D1 counts and active row, HTTP probes, CI runs and variables | §2 |

Not done here: fuzzing, load testing, a penetration test, an independent review of
the MyVault cryptography, a live Windows Hello ceremony, a live Google OAuth round
trip, and any run of the VS Code extension inside VS Code.

## 2. Release state snapshot

| Item | State | How verified |
|---|---|---|
| `main` | `a577936`, 153 commits since the 2026-09-10 audit (`63e5ee8`), audited in a clean worktree | `git log`, `git worktree` |
| Production Worker | `private-browser-downloads` (resolved from `cloudflare/wrangler.jsonc:3`); last deployments 2026-09-24 21:00 (code) and 21:00:26 (secret change) | `wrangler deployments list` |
| What production serves | `stable-0.6.7-119`, commit `a577936` — the audited commit, published by CI run 36059779469 during the audit | `/api/v1/releases/public/latest` |
| Before that | `stable-0.6.6-116` at `5d331b5`, six commits behind (the Windows Hello feature) | D1, read-only |
| Health | `{"status":"ok","database":"ok","releaseReady":true}` | `curl /health` |
| API | `/update.json` without token → 404; wrong bearer → 404; `POST /api/releases` without key → 404; `http://…/health` answered 200 (not redirected) | `curl` |
| Public page | `/` 200, full CSP, `x-frame-options: DENY`, `referrer-policy: no-referrer`, `x-robots-tag: index, follow` | `curl -I` |
| Database | D1 `private-browser-releases`, 29 release rows, one active per channel | `wrangler d1 execute` (counts and metadata only) |
| Worker secrets | `ADMIN_API_KEY`, `DOWNLOAD_ACCESS_TOKEN`, `SIGNING_SECRET` — names only; no value was read | `wrangler secret list` |
| CI secrets/variables | 6 secrets incl. Cloudflare and release keys; no `WINDOWS_CODE_SIGNING_*` (installers unsigned); variable `PRIVATE_BROWSER_DOWNLOAD_URL`; `PRIVATE_BROWSER_BUNDLE_UPDATE_TOKEN` unset | `gh secret list`, `gh variable list` |
| Last CI runs | `main` green; both Dependabot group PRs fail at `npm ci` (lock file out of sync: `esbuild@0.28.2`) | `gh run view --log-failed` |
| Version identity | `package.json` says 0.6.0; CI rewrites it per release from the live service (`prepare-release-version.mjs`) | grep |

COULD NOT CHECK: `wrangler d1 migrations list` crashed locally (esbuild
`formatMessages`); would have settled that no migration is pending. Workers
Observability logs were not queried; would have settled whether F-51's token-in-path
is present in real logs.

## 3. What holds up

- **MyVault envelope crypto.** Argon2id with bounded parameters checked before use
  (`vault-crypto.ts:109-127`), AES-256-GCM with 12-byte random IVs and vault-bound
  AAD, separate AAD for the Windows Hello wrap (`:596-598`), forward-only payload
  migration that refuses newer schemas (`:252-311`). Pinned by byte-exact vectors in
  `tests/myvault-compatibility.test.ts:70-191` — replacing the crypto with identity
  cannot stay green.
- **Windows Hello.** Password checked before any prompt (`vault-broker.ts:180`),
  one Hello key per vault id (`windows-hello.ts:62-66`), absolute PowerShell path and
  challenge on stdin (`:135-160`), stale enrolment dropped on rejection
  (`vault-broker.ts:226-230`), and a vault replaced mid-prompt is refused (`:218`).
- **Push-side sync.** An edit made while a push is in flight is kept dirty
  (`vault-broker.ts:370`), with a gated-promise test (`vault-sync.test.ts:46-62`).
- **Disk store.** Atomic write with fsync (`vault-store.ts:48-59`); corrupt or
  unsupported envelopes are renamed aside and block writes until acknowledged
  (`:194-204`).
- **IPC boundary.** All 132 `ipcMain.handle` channels go through `handle()`:
  trusted main-frame sender, then rate and size, then schema (`main.ts:2774-2781`).
  Tab views: no preload, sandbox, context isolation, `webSecurity`
  (`main.ts:2255-2264`); `app.enableSandbox()`; the chrome window is pinned to its
  packaged file.
- **Secure dialogs and picker.** One-shot, nonce- and sender-bound, sandboxed,
  nonce CSP, no DevTools (`secure-dialog.ts:44-96`, `fill-picker.ts:28-62`). Fill
  re-checks generation, origin, tab, workspace and webContents immediately before
  injection with no await in between (`main.ts:1858-1870`).
- **Exact-origin fill.** `isAutofillTarget` (`security.ts:181-192`); same-site via
  `tldts` keeps `a.co.ma`/`b.co.ma` and `x.github.io`/`y.github.io` apart and refuses
  IPs, `localhost` and `xn--` (`site-match.ts:13-40`).
- **Google OAuth.** PKCE S256, state and nonce, single-use loopback on
  `127.0.0.1` with random path and exact Host/peer checks (`oauth-loopback.ts`),
  ID-token issuer/audience/expiry/nonce/`email_verified` (`google-oauth.ts:223-238`);
  refresh tokens only inside `safeStorage` records; write confirmations single-use
  and payload-bound in main (`google-confirmations.ts:31-41`).
- **Worker.** Admin and client auth before any work, constant-time over digests
  (`auth.ts:13-18`); signed links bound to purpose, release id and expiry, with a
  correctly re-signed expiry test (`worker.test.ts:354-366`); one Range only; R2
  size checked at publish and serve; negative publish-auth tests (`:392-427`) — F-03
  holds.
- **Update client.** `redirect: 'error'`, 100 KB cap, same-origin exact-path links,
  token never in `status()` (`update-service.ts:23-29, 95-155`).
- **Renderer.** No `dangerouslySetInnerHTML`, `innerHTML`, `fetch` or remote
  `img` anywhere in `src/`; every image is a main-built `data:` URL; shipped CSP has
  no dev exceptions (F-07, F-17 hold).
- **VS Code bridge protocol.** Length checked before allocation, signed transcript,
  fresh X25519 per connection, sequence-bound AAD with exact replay rejection
  (`bridge-protocol/src/index.ts:171-225`); commands run `shell: false` with a
  fingerprint over script text and config digest.

## 4. Findings

Severity, derived from the premise above: **High** = a credential or page content
reaches somewhere it must not, a user's credential is lost, or a hostile page escapes
its containment, or the app makes a security promise the code does not keep and the
user would act on it · **Medium** = a real defect or a security control that does
not work as shown, or a test gap on a destructive or boundary path · **Low** =
correctness, hardening, hygiene · **Info** = worth knowing, no action. "Verified"
says how the claim was established.

### High

**F-27 · A login saved while a sync pull is in flight is erased, and the vault
reports "synced".** [sync-controller.ts:42-55](../../electron/myvault/sync-controller.ts#L42-L55),
[vault-broker.ts:353-366](../../electron/myvault/vault-broker.ts#L353-L366),
[vault-broker.ts:398-409](../../electron/myvault/vault-broker.ts#L398-L409)
`perform()` snapshots the connection (`dirty: false`) and awaits `fetchVault`. Unlock
starts exactly this pull every time (`main.ts:1665`, `:1697`). If the user saves a
login meanwhile — the editor, a page capture (`main.ts:1788`, `:2050`) or an import —
`persistMutation` writes it and sets `dirty: true`. When the fetch returns a newer
version, `acceptRemote` overwrites the envelope, the payload and the connection with
`dirty: false`: the login is gone from disk and memory and the status says `synced`.
The mirror ordering also loses data: a `persistMutation` that captured the old
envelope before its encryption await writes over a just-accepted remote and later
pushes it, erasing the other device's change. Contradicts vault.md invariant 3
("never auto-merges or overwrites"). Reproduced: a scratch script against the built
modules ended with titles `['Remote']`, `dirty: false`, `sync: synced` after saving
"Local" mid-pull. Fix: serialise every broker mutation and `acceptRemote` through
one queue, and in `acceptRemote` refuse (enter conflict) when the local envelope is
no longer the one the pull started from. Verified: code + run.

**F-28 · A tab whose first address is an `xn--` domain is created without any of its
per-view guards.** [main.ts:2265-2270](../../electron/main.ts#L2265-L2270),
[fill-capability.ts:26](../../electron/myvault/fill-capability.ts#L26)
`ensureView` stores the view and adds it to the window, then evaluates
`normalizedWebOrigin(tab.url)` as an argument to `canInstallPasskeyProvider`.
`normalizedWebOrigin` throws for any hostname containing `xn--`, so the function
exits before `setWindowOpenHandler`, `will-navigate`, `will-redirect`,
`will-attach-webview`, `did-start-navigation`, `did-navigate` and the input handlers
(lines 2270-2356) are attached. The next `showActiveTab` returns the stored view and
loads the URL in it. That tab then has Electron's default popup behaviour (real
windows outside the tab model, including in Banking, where popups are meant to be
blocked), no navigation filter, no generation bump for fill contexts, and a `tab.url`
that never updates. Any page can trigger it with one `window.open` to a punycode
host, and every Arabic-script `.ma` domain is punycode. The passkey gate is off, so
the call exists only to be skipped. Fix: evaluate the gate before the origin, never
throw inside `ensureView`, and attach the guards before anything that can throw;
add an Electron test that opens a tab straight to an `xn--` URL. Verified: code.

### Medium

**F-29 · A sync that completes after the user locks puts the vault back to
"unlocked".** [vault-broker.ts:368-378](../../electron/myvault/vault-broker.ts#L368-L378),
[vault-broker.ts:353-366](../../electron/myvault/vault-broker.ts#L353-L366),
[vault-broker.ts:404](../../electron/myvault/vault-broker.ts#L404)
`markPushSucceeded` and `acceptRemote` set `lifecycle = 'unlocked'` unconditionally.
Lock while a push is in flight and the status reverts to `unlocked`; the main-process
subscriber then schedules automatic fill (`main.ts:258`), and the panel shows an
unlocked vault whose every operation fails. `acceptRemote` and `persistMutation`
also re-populate the decrypted payload after a lock. The `generation` counter exists
but guards nothing. Reproduced (push path): `after lock: locked` → `after sync
lifecycle: unlocked`. Fix: capture `generation` at the start of each sync and
mutation and drop the result if it changed. Verified: code + run.

**F-30 · Locking the active Account Space does not stop it being used.**
[main.ts:637-651](../../electron/main.ts#L637-L651),
[main.ts:554-562](../../electron/main.ts#L554-L562),
[main.ts:2554-2566](../../electron/main.ts#L2554-L2566)
The profile menu only locks the active account ("Closes its pages and connections").
`setAccountSpaceLocked` closes its views but leaves `activeAccountSpaceByWorkspace`
pointing at it; the menu closing calls `setOverlayOpen(false)` → `showActiveTab`, and
neither it nor `ensureView` checks `locked`, so the page is rebuilt in the locked
partition with its cookies. Contradicts google-account-spaces.md ("blocks use until
reopened"). Fix: switch to an unlocked sibling before locking, and refuse views for
locked accounts in `ensureView`. Verified: code.

**F-31 · A background tab can take the foreground — including out of Banking — with
`window.open`, as often as it likes.** [main.ts:2270-2277](../../electron/main.ts#L2270-L2277),
[main.ts:469-499](../../electron/main.ts#L469-L499)
Every popup becomes `newTab(...)`, which hides all views and switches the active
workspace and Account Space to the popup's. A hidden Personal tab can pull the user
off their bank onto its own page on a timer, and a loop creates unbounded tabs.
`tests/electron/account-spaces.spec.ts:188` shows a popup is honoured without a user
gesture. Fix: only activate a popup whose opener is the visible active tab; otherwise
add it in the background, and rate-limit per view. Verified: code.

**F-32 · Several file types Windows runs are "ordinary" to the download guard.**
[security.ts:84-92](../../electron/security.ts#L84-L92),
[main.ts:2063-2072](../../electron/main.ts#L2063-L2072),
[main.ts:2524](../../electron/main.ts#L2524)
`.msix`, `.appinstaller`, `.vhd`/`.vhdx`, `.url`, `.application`, `.appref-ms`,
`.wsh`, `.msc`, `.diagcab` (among others) are not listed, so "Open" passes them to
`shell.openPath`, while `.iso`/`.img` are listed. Risk is computed from the suggested
filename, not the saved path that is opened. SECURITY.md says such downloads "cannot
be opened from Private Browser unless they match the checksum". Fix: open only an
allowlist of inert types; compute risk from `getSavePath()`. Verified: code.

**F-33 · The Chrome password import aborts at the first Android login and can never
import the rows after it.** [vault-migration.ts:44-48](../../electron/myvault/vault-migration.ts#L44-L48),
[vault-migration.ts:152-171](../../electron/myvault/vault-migration.ts#L152-L171)
Chrome exports app logins as `android://…` rows. `origin()` throws, nothing catches
it, the rows before are saved and the rest are not, and a retry stops at the same row.
A UTF-8 BOM is not stripped (the `name` column is missed), there is no size, row or
field bound, and each row re-encrypts and fsyncs the whole vault. The bounded parser
in `chrome-importer.ts:208-249` is used only by tests. Fix: route the import through
the bounded parser, count unsupported origins as skipped, strip the BOM, and add an
`android://` row to the test. Verified: code.

**F-34 · The login picker fills on the first mousedown after it appears.**
[fill-picker-model.ts:129](../../electron/myvault/fill-picker-model.ts#L129),
[fill-picker.ts:47-79](../../electron/myvault/fill-picker.ts#L47-L79)
A row's `mousedown` calls `choose` immediately, with no guard on how long the list
has been visible. A page on `sibling.example.com` can ask for a double-click, move
focus to a login field it positioned so row 0 lands under the cursor, and let the
second press pick a login saved for `accounts.example.com`
(`fillEntryInto(..., 'same-site')`). The same-site tier is acceptable only because
the user deliberately picks a labelled row. Fix: in main, ignore a `choose` that
arrives less than ~500 ms after the overlay was shown (Chrome's pattern). Verified:
code (render latency not measured).

**F-35 · A page-driven URL change overwrites what the user is typing in the address
bar.** [App.tsx:117-119](../../src/App.tsx#L117-L119)
The effect re-syncs `address` whenever `activeTab.url` changes; `history.pushState`
(`did-navigate-in-page`, `main.ts:2318`) changes it. The user's typed destination is
replaced by a URL the page chose, and Enter navigates there. Fix: skip the re-sync
while the field is focused and edited, except on tab change. Verified: code.

**F-36 · The update screen promises a signed installer; releases are unsigned.**
[SettingsPanel.tsx:208](../../src/panels/SettingsPanel.tsx#L208)
"A newer signed Windows installer is ready" — no `WINDOWS_CODE_SIGNING_*` secret is
configured (§2) and SECURITY.md says the release is unsigned. Fix: say
"checksum-verified", or show "signed" only when the manifest says so. Verified: code
+ production.

**F-37 · An Account Space with an unreadable record drops out of the manifest at the
first save and is never offered recovery again.**
[runtime-state-store.ts:29-36](../../electron/runtime-state-store.ts#L29-L36),
[runtime-state-store.ts:141-166](../../electron/runtime-state-store.ts#L141-L166),
[account-space-state.ts:201-225](../../electron/account-space-state.ts#L201-L225)
Corrupt accounts are reported in `accountRecoveries` but the store is not read-only,
and `persist()` writes `accountSpaceIds` from the loaded accounts only. If that
account was a workspace's only member, `normalizeRuntimeState` throws on every
update instead. If only its `<id>.json` is corrupt, fresh start cannot run
(`prepareFreshStart` re-parses the preserved file). SECURITY.md promises read-only
recovery and a confirmed fresh start. Fix: carry recovering ids into the manifest and
exclude their files from writes; take the owner workspace from the manifest.
Verified: code.

**F-38 · "Restore version 1" overwrites the live per-account files without a backup
and drops every Account Space added since.**
[account-space-state.ts:92-99](../../electron/account-space-state.ts#L92-L99),
[account-space-state.ts:296-301](../../electron/account-space-state.ts#L296-L301)
Only the manifest is preserved; re-migration reuses the same stable ids and
`publishStagedAccountState` renames over each account's current `<id>.json`. Fix:
preserve the account-state directory in `prepareRestoreV1`, and refuse to publish
over a differing file. Verified: code.

**F-39 · Deleting an Account Space leaves its plaintext browsing file on disk.**
[runtime-state-store.ts:105-125](../../electron/runtime-state-store.ts#L105-L125)
`removeAccount` deletes the encrypted record but nothing unlinks
`account-browsing/<id>.json` (history, open-tab URLs, bookmarks, shortcuts). The docs
say deletion removes account browsing state. Fix: unlink it after the manifest is
persisted; assert it in `account-lifecycle.test.ts`. Verified: code.

**F-40 · Reconnecting an Account Space can silently switch it to a different Google
identity.** [google-oauth.ts:99-108](../../electron/google-oauth.ts#L99-L108),
[account-store.ts:205-224](../../electron/account-store.ts#L205-L224),
[main.ts:670-671](../../electron/main.ts#L670-L671)
`saveGoogleGrant` never compares the new `sub` with the account's existing one, and
the refresh-token fallback uses the token read before the five-minute wait, so a
record can say user Y while holding X's token. The one-sub-per-app check uses an
account list captured before that wait. Fix: reject a different `sub` unless the
user disconnected first; only fall back to the stored token when the `sub` matches;
evaluate the account list inside `saveGoogleGrant`. Verified: code.

**F-41 · The publish job can still be cancelled mid-release, and a docs-only push
after a cancelled run skips the app release (F-21 regressed, F-04 family).**
[ci.yml:11-13](../../.github/workflows/ci.yml#L11-L13),
[ci.yml:141-149](../../.github/workflows/ci.yml#L141-L149),
[ci.yml:177-192](../../.github/workflows/ci.yml#L177-L192)
The workflow-level group has `cancel-in-progress: true`; a job-level group does not
shield a job from its whole run being cancelled, so the R2-upload/D1-register gap F-21
described is back. Separately, the docs-only check diffs against
`github.event.before`: if an app push's run is cancelled and the next push is
docs-only, that app code is never published. Fix: no cancelling workflow-level group;
decide "docs-only" against the active release's `commitSha`. Verified: code (GitHub's
cancellation semantics from its documentation, not re-run).

**F-42 · An installer built with the embedded download token is published on the
public page.** [ci.yml:80-88](../../.github/workflows/ci.yml#L80-L88),
[ci.yml:141-237](../../.github/workflows/ci.yml#L141-L237)
The opt-in `PRIVATE_BROWSER_BUNDLE_UPDATE_TOKEN` builds a "private single-user" .exe
containing the shared token; the publish job uploads and activates that same file,
and the public page (Decision above) hands it to anyone. The variable is unset today,
so this is latent. Fix: fail the publish job when the variable is `true`. Verified:
code + production (variable unset).

**F-43 · On Windows, no npm, pnpm, yarn, Gradle or Wrangler command from the VS Code
bridge can start.** [adapters.ts:19-24](../../vscode-extension/src/adapters.ts#L19-L24),
[project-service.ts:162](../../vscode-extension/src/project-service.ts#L162)
Commands are `npm.cmd`/`gradlew.bat`/`wrangler.cmd` spawned with `shell: false`,
which Node refuses since CVE-2024-27980: `spawn('npm.cmd', …, { shell: false })`
throws `EINVAL` synchronously on this machine (Node 22.16). Start server, Restart,
Quick Test and Test Everything fail after the approval modal. Fix: run the package
manager's JS entry through `process.execPath`, or `cmd.exe /d /s /c` with strict
quoting; add a Windows test that starts a script. Verified: code + run.

**F-44 · The Electron tests of "never fill in Development/Banking", "never overwrite"
and "same-site never fills automatically" pass before any fill could run.**
[automatic-fill.spec.ts:19-28](../../tests/electron/automatic-fill.spec.ts#L19-L28),
[automatic-fill.spec.ts:124-138](../../tests/electron/automatic-fill.spec.ts#L124-L138),
[fill-picker.spec.ts:227-240](../../tests/electron/fill-picker.spec.ts#L227-L240),
[fill-picker.spec.ts:299-301](../../tests/electron/fill-picker.spec.ts#L299-L301)
`readForm` returns empty fields while the form does not exist (the `/login` fixture
inserts it after 500 ms), so `expect.poll(...).toMatchObject({username:'',password:''})`
succeeds on its first sample; the sibling check reads at 1.5 s while the last
automatic-fill retry fires at 2.5 s (`main.ts:135`). The new-password form is served
only at `/sign-up`, which the URL rule rejects first, so the new-password detection
in `isolated-fill.ts:51-52, 91` is untested. Fix: wait for the form, then past the
last retry (or a completion signal) before asserting absence; serve the
new-password form at a neutral path. Verified: code.

**F-45 · An encrypted Drive backup cannot be restored into any Account Space but the
one that wrote it.** [account-backup.ts:104-117](../../electron/account-backup.ts#L104-L117),
[main.ts:848-851](../../electron/main.ts#L848-L851)
Items carry the source `accountSpaceId`, and restore refuses any mismatch. On a new
device or after a reinstall the ids are fresh UUIDs, so the recovery-code path fails
exactly when it is needed. Fix: bind to the Google `sub`, re-stamp items on restore.
Verified: code (no live Drive round trip).

**F-46 · The newest vault paths have tests that cannot catch their likeliest
regressions.** [windows-hello-unlock.test.ts:15-21](../../tests/windows-hello-unlock.test.ts#L15-L21),
[windows-hello-unlock.test.ts:59-74](../../tests/windows-hello-unlock.test.ts#L59-L74),
[vault-broker.test.ts:93-104](../../tests/vault-broker.test.ts#L93-L104)
Hello tests use an identity `safeStorage`, so writing the Hello record unencrypted
stays green; no test saves after a Hello unlock and re-opens with the password; the
IPC handlers and `runHelloScript` are untested. The recovery test ends on an
unasserted `acknowledgeRecovery()`, and `recovery-required` refusal of unlock,
Hello unlock and install is never driven. The sync race of F-27 has no test. Fix: XOR
adapter plus a "no `wrappedKey` in the file" assertion; enrol → lock → Hello unlock →
save → lock → password unlock; a broker-level recovery test. Verified: code.

### Low

| # | Finding | Where |
|---|---|---|
| F-47 | `freeze-content` decides "protected" from the store URL, which `navigate` writes before the load commits, so a protected page's pixels can be captured to the chrome renderer while it is being navigated away from. | [main.ts:1053-1065](../../electron/main.ts#L1053-L1065), [:458-465](../../electron/main.ts#L458-L465) |
| F-48 | Back/Forward/Reload/Find on a New Tab page act on the previous page's hidden view; `commitNavigation` then marks the tab as a page but never shows the view. | [main.ts:958-966](../../electron/main.ts#L958-L966), [:2683-2698](../../electron/main.ts#L2683-L2698) |
| F-49 | `validateIpcArguments` passes every channel it does not list (about 90); dead cases name channels that do not exist. ipc-contract.md says every Account Space channel is validated. | [ipc-contracts.ts:167-168](../../electron/ipc-contracts.ts#L167-L168) |
| F-50 | The live end-to-end hash check runs after the new release is already active, with no rollback; the Worker checks size only. | [ci.yml:226-237](../../.github/workflows/ci.yml#L226-L237) |
| F-51 | A thrown error on `/download/<token>` logs the full path, i.e. the download token, with 100 % log sampling. | [cloudflare/src/index.ts:291](../../cloudflare/src/index.ts#L291) |
| F-52 | F-26 partial: the version-downgrade guard is skipped when the posted id equals the active id; the D1 triggers check build only, and the doc calls the trigger "the guarantee". Admin key required. | [cloudflare/src/index.ts:237-243](../../cloudflare/src/index.ts#L237-L243) |
| F-53 | The installer-tamper test uses contents of different length, so it fails on the size check; the hash comparison is untested. | [download-verify.test.ts:35-40](../../tests/download-verify.test.ts#L35-L40) |
| F-54 | Other assertions that prove less than they claim: identity-encryption bootstrap test; live "expired" probe not re-signed; downgrade test without error code; `indexOf` of −1 passes; CI retries (2 e2e, 1 Electron) with no `failOnFlakyTests`; two specs still swallow `ERR_ABORTED`; Electron "partition isolation" builds its own sessions instead of using the app's. | [update-bootstrap.test.ts:36](../../tests/update-bootstrap.test.ts#L36), [verify-live-release.mjs:315-317](../../cloudflare/scripts/verify-live-release.mjs#L315-L317), [ipc-control-center.test.ts:66](../../tests/ipc-control-center.test.ts#L66), [playwright.config.ts:8](../../playwright.config.ts#L8), [account-spaces.spec.ts:53-57, 94-181](../../tests/electron/account-spaces.spec.ts#L53-L57) |
| F-55 | F-11 partial: the publish job runs `npm ci` and then `npx wrangler` with the Cloudflare token; the published SHA-256 is computed on the publish runner, not carried from the build job; `CSC_*` reach every build dependency; actions are pinned by tag. | [ci.yml:163-164, 223](../../.github/workflows/ci.yml#L163-L164), [publish-release.mjs:14-24](../../cloudflare/scripts/publish-release.mjs#L14-L24) |
| F-56 | On an unconfigured fork or the very first release, "Select the next release version" throws, contrary to the doc's "no-op gracefully". | [ci.yml:65-73](../../.github/workflows/ci.yml#L65-L73), [prepare-release-version.mjs:32-48](../../cloudflare/scripts/prepare-release-version.mjs#L32-L48) |
| F-57 | The publish body is read with no size limit (after admin auth). | [cloudflare/src/index.ts:227](../../cloudflare/src/index.ts#L227) |
| F-58 | A cancelled or failed Google reconnect shows "disconnected" while the refresh token stays usable; an in-flight token refresh rewrites the status after a disconnect or lock. | [main.ts:672-678](../../electron/main.ts#L672-L678), [google-token-broker.ts:78-99](../../electron/google-token-broker.ts#L78-L99) |
| F-59 | Restoring one Account Space's backup overwrites the browser-wide tracker-blocking flag, Banking included. | [main.ts:860](../../electron/main.ts#L860) |
| F-60 | `mail.google.com.` (trailing dot) is not classified as Gmail, so the "mailbox never goes to cloud AI" guard compares an un-normalised host. | [ai-account-spaces.ts:6-14](../../electron/ai-account-spaces.ts#L6-L14) |
| F-61 | The plaintext privacy log records the free-text Account Space label. | [main.ts:720](../../electron/main.ts#L720), [:1187](../../electron/main.ts#L1187) |
| F-62 | A confirmed fresh start of a corrupt default account leaves its legacy partition (with cookies) orphaned on disk. | [account-space-state.ts:108-114](../../electron/account-space-state.ts#L108-L114) |
| F-63 | Backup restore validates items only for ownership; a malformed item crashes the merge. | [account-backup.ts:227-242](../../electron/account-backup.ts#L227-L242) |
| F-64 | The permission dialog arms "Always here" immediately and is not keyed to the prompt, so a pending click can land on it and focus is not reset for a replacing prompt. | [Overlays.tsx:8-11](../../src/panels/Overlays.tsx#L8-L11) |
| F-65 | "Clipboard clears in 30 seconds" does not cover Windows clipboard history or cloud clipboard; no exclusion formats are written. | [clipboard-guard.ts:27](../../electron/clipboard-guard.ts#L27), [VaultPanel.tsx:24](../../src/panels/VaultPanel.tsx#L24) |
| F-66 | F-25 half closed: collapsing the AI-provider or update-token form hides the input but keeps the typed secret in state. | [AssistantPanel.tsx:78](../../src/panels/AssistantPanel.tsx#L78), [SettingsPanel.tsx:137-141](../../src/panels/SettingsPanel.tsx#L137-L141) |
| F-67 | In Banking the unlocked vault says "Passwords stay outside this interface and browser pages" next to a working Fill. | [VaultPanel.tsx:43](../../src/panels/VaultPanel.tsx#L43) |
| F-68 | Closing the side panel mid-resize never releases its overlay, leaving the page hidden behind a frozen image. | [SidePanel.tsx:35-63](../../src/shell/SidePanel.tsx#L35-L63) |
| F-69 | Several vault, download, AI and developer actions have no rejection handler, so a refusal shows nothing. | [VaultPanel.tsx:33-64](../../src/panels/VaultPanel.tsx#L33-L64), [DownloadsPanel.tsx:7](../../src/panels/DownloadsPanel.tsx#L7) |
| F-70 | Dialogs that gate security decisions have no focus trap; the permission dialog and full vault view have no Escape. | [Overlays.tsx:11-24](../../src/panels/Overlays.tsx#L11-L24), [App.tsx:525](../../src/App.tsx#L525) |
| F-71 | Favicons are read whole before the size cap is applied (page-controlled URL). | [main.ts:2636-2641](../../electron/main.ts#L2636-L2641) |
| F-72 | VS Code bridge reliability: a response after the 30 s timeout, an over-size reply (e.g. `reports.list` with a dozen reports) or two open VS Code windows each tear the session down; an unthrottled `task.progress` trips the 120/min limit. | [vscode-bridge.ts:93-169](../../electron/vscode-bridge.ts#L93-L169), [bridge-client.ts:104-175](../../vscode-extension/src/bridge-client.ts#L104-L175) |
| F-73 | Secret-file refusal runs on the typed path, not the canonical one, and misses `.npmrc`, `.netrc`, `.git-credentials`, `id_ecdsa`, `credentials.json`. | [vscode-extension/src/security.ts:5, 23-43](../../vscode-extension/src/security.ts#L5) |
| F-74 | `ai.apply-edits` hashes the file on disk before review and replaces the whole buffer after it (edits made during review are lost); nothing calls it, yet the walkthrough describes it. | [project-service.ts:373-391](../../vscode-extension/src/project-service.ts#L373-L391) |
| F-75 | `ai.handoff` skips Workspace Trust and the folder grant, which SECURITY.md calls mandatory. | [project-service.ts:348-365](../../vscode-extension/src/project-service.ts#L348-L365) |
| F-76 | "Always allow" for a Playwright run fingerprints `{runner, kind, root}` only, not its arguments. | [project-service.ts:261-262](../../vscode-extension/src/project-service.ts#L261-L262) |
| F-77 | `secret-guard` skips files whose path git quotes (non-ASCII names, reproduced), exempts two whole files contrary to SECURITY.md's "never file-wide", and its hook mode is untested; its "refuses" tests pass on a crash. | [secret-guard.mjs:23, 147-189](../../scripts/secret-guard.mjs#L23), [secret-guard.test.ts:21-45](../../tests/secret-guard.test.ts#L21-L45) |
| F-78 | The sync client maps only 401 to "unauthorized"; a read-only 403 becomes a generic error, and the test named for it sends 401 only. | [vault-sync.ts:28-47](../../electron/myvault/vault-sync.ts#L28-L47) |
| F-79 | Passkey assertions (gated off) sign in raw `r‖s`, not DER, always set UV, and the "verifiable assertion" test checks length > 0. | [passkeys/authenticator.ts:59-65](../../electron/myvault/security/passkeys/authenticator.ts#L59-L65), [passkeys.test.ts:7-16](../../tests/passkeys.test.ts#L7-L16) |
| F-80 | Same-site matching has no exclusion for multi-tenant registrable domains (Chromium excludes `google.com`). | [site-match.ts:13-40](../../electron/myvault/site-match.ts#L13-L40) |
| F-81 | Chrome bookmark import caps the count but not the depth; each leaf copies its full path. | [chrome-importer.ts:88-116](../../electron/chrome-importer.ts#L88-L116) |
| F-82 | The MyVault sync client follows redirects and reads responses unbounded, unlike every other outbound client here. | [vault-sync.ts:51-61](../../electron/myvault/vault-sync.ts#L51-L61) |
| F-83 | Pairing is gated to "unconfigured" only in the renderer; `installEncryptedVault` writes the envelope before validating the connection (redeem checks only an `mvd_` prefix), leaving a replaced envelope with no connection. | [main.ts:1715-1722](../../electron/main.ts#L1715-L1722), [vault-broker.ts:132-145](../../electron/myvault/vault-broker.ts#L132-L145), [vault-sync.ts:31](../../electron/myvault/vault-sync.ts#L31) |
| F-84 | `acknowledgeVaultRecovery` is the only vault intent without `assertVaultSurface()`. | [main.ts:1808-1812](../../electron/main.ts#L1808-L1812) |
| F-85 | Both Dependabot group PRs fail CI at `npm ci` (lock file out of sync), so dependency updates pile up unmerged. | CI runs 36058910239, 36058736472 |

### Info

- **I-01 · External links open in the active workspace, Banking included.**
  Documented in browser-shell.md; a policy choice, not a defect.
- **I-02 · `changeMasterPassword` exists but nothing calls it.** There is no
  master-password change flow in the app, so nothing to test yet.
- **I-03 · Plain `http://` requests to the Worker are answered.** `/health` over
  HTTP returns 200; nothing sensitive is served there and the client refuses
  non-HTTPS endpoints.
- **I-04 · The previous audit's F-02 is moot.** With public distribution the
  download token no longer gates the installer; it gates only the private feed and
  `/download/<token>`.

## 5. Documentation drift

| Document | Says | Reality |
|---|---|---|
| [SECURITY.md](../../SECURITY.md) "Vault" | "Credentials and TOTP secrets are encrypted using Electron `safeStorage`" | MyVault is an Argon2id + AES-256-GCM envelope under the master password (`vault-store.ts:117-121`); `safeStorage` holds only connection, Hello and preference files |
| [SECURITY.md](../../SECURITY.md) "Vault" | https page "is always acceptable" for an http-saved credential | Automatic fill and side-panel Fill are scheme-exact (`vault-broker.ts:255-258`); only the picker allows it |
| [SECURITY.md](../../SECURITY.md) "Release service" | Installer binaries are private; page URLs signed; `noindex`; desktop checks use a client-only bearer token | Public indexable page and unauthenticated manifest (`index.ts:116-138, 169`); default client uses the public feed (`update-service.ts:87-97`) |
| [SECURITY.md](../../SECURITY.md) "Known external requirement" | "The generated Windows installer is reproducible" | The version comes from live service state (`prepare-release-version.mjs:56-66`) |
| [SECURITY.md](../../SECURITY.md) "AI data controls" | "URL paths … are never shared; only the page origin" | Developer previews send origin and path (`main.ts:1422`) |
| [SECURITY.md](../../SECURITY.md) "Permissions" | Paragraph opens "Those two permissions…" | Nothing before it names two permissions |
| [SECURITY.md](../../SECURITY.md) "Credentials in the repository" | Exemption is "per line … never a directory or file-wide silence" | Two files are exempt whole (`secret-guard.mjs:23`) |
| [vault.md](../systems/vault.md) invariant 3 | CAS conflict "never auto-merges or overwrites" | A pull overwrites a local edit (F-27) |
| [vault.md](../systems/vault.md) invariant 7 | "Only a digest survives for unchanged-value clearing" | The guard keeps the raw value for 30 s (`clipboard-guard.ts:28`) |
| [vault.md](../systems/vault.md) invariant 6 | Preferred login is "for that origin during the session" | Persisted per registrable domain in `fill-preferences.enc` (same doc, later paragraph) |
| [ipc-contract.md](../systems/ipc-contract.md) | `vault:add`, `vault:remove`, `vault:reset-corrupt`; "40 channels"; "every Account Space channel passes a declarative validator" | None of those three exist; 132 channels; unlisted channels pass (F-49) |
| [browser-shell.md](../systems/browser-shell.md) | Partition per workspace; camera/mic/geolocation/notifications "denied without prompting"; history capped at 500; `closeTab` is the only path that destroys a view | Per Account Space; prompted through `AccountPermissionManager`; 2500 (`main.ts:2694`); `closeAccountViews` also does |
| [google-account-spaces.md](../systems/google-account-spaces.md) | Deletion "removes account browsing state"; "attempts Google revocation" | File stays (F-39); deletion is refused when revocation fails |
| [workspaces-and-state.md](../systems/workspaces-and-state.md) | "Only opaque IDs cross the … renderer boundary" | Summaries carry email, display name and avatar (`account-store.ts:245-247`) |
| [renderer-ui.md](../systems/renderer-ui.md) | Only `preview-api` exists and is DEV-gated; secret fields "cleared in `finally`" (as the whole F-25 fix) | `preview-bridge.ts` ships ungated (safe today: localhost + query only); collapse keeps the secret (F-66) |
| [chrome-import.md](../systems/chrome-import.md) | The import "validates origins and bounds" | The live path has no bounds; the bounded parser is test-only (F-33) |
| [passkeys.md](passkeys.md) | Tests cover cancellation/fallback and opt-in rules; enabling needs only opt-ins | Tests check the gate and shim text; every workspace policy returns `passkeys: false` |
| [release-and-updates.md](../systems/release-and-updates.md) | F-21 fixed; triggers are "the guarantee" against downgrades; unconfigured builds "no-op gracefully"; bootstrap left in place on failure | F-41; F-52; F-56; always removed in `finally` (`main.ts:2823-2830`) |
| [ai-consent.md](../systems/ai-consent.md) | Token deleted before the question is validated | The question is validated first (`main.ts:1589-1591`) |
| [vscode-bridge.md](../systems/vscode-bridge.md) | "The browser receives summaries and artifact metadata only"; owner-only files | `reports.list` returns full reports; `mode: 0o600` is a no-op on Windows (the profile ACL is the real protection) |
| [CLAUDE.md](../../CLAUDE.md) | `check` = docs guard, two typechecks, two vitest suites, build, Worker dry-run; the hook only warns | Also secrets, a third typecheck, four vitest runs, VSIX, e2e and Electron; the hook blocks on the secret guard |
| `electron/myvault/security/vectors.json` `$comment` | Consumed by `src/security/vectors.test.ts`, generated by `scripts/make-crypto-vectors.mjs` | Neither exists; the consumer is `tests/myvault-compatibility.test.ts` |

## 6. Recommended order of work

1. **Vault data integrity and lock** — F-27, F-29, then F-46 (each with a test that
   fails before the fix: the pull-race and lock-race reproductions become unit
   tests).
2. **Page containment** — F-28, F-31, F-34, F-35, F-32 (an Electron test that opens
   an `xn--` tab; a picker choose within 500 ms is ignored).
3. **The public-distribution decision** — rewrite SECURITY.md "Release service",
   then F-42 and F-36 (they only make sense once the contract is right).
4. **Account Space data** — F-30, F-37, F-38, F-39, F-40, F-45.
5. **Release pipeline** — F-41, F-50, F-55, F-52, F-56.
6. **Tests that cannot fail** — F-44, F-53, F-54, F-77.
7. **Developer bridge** — F-43, then F-72 to F-76.
8. **Low findings and documentation drift** (§5) — in the same commits as the code
   they describe.

## 7. Delta since 2026-09-10

| # | Was | Now | Where |
|---|---|---|---|
| F-01 | Clipboard clear abandoned on early quit | fixed | `b740746` (`clipboard-guard.ts`, flushed on quit and lock) |
| F-02 | Shared token inside every installer | fixed (opt-in, off by default); moot under public distribution (I-04); see F-42 | `377f3c1` |
| F-03 | No negative publish-auth test | fixed | `b740746`, `worker.test.ts:392-427` |
| F-04 | Version-only update vs publish-on-every-push | fixed; the cancelled-run gap is F-41 | `b740746` |
| F-05 | Autofill ignored scheme | fixed | `377f3c1`, `security.ts:181-192` |
| F-06 | AI card understated payload | fixed | `377f3c1` |
| F-07 | Favicons fetched by the chrome | fixed | `377f3c1` |
| F-08 | Protected-page detection fail-open | fixed (best effort, documented as such) | `377f3c1` |
| F-09 | Worker fakes discarded inputs | fixed in the unit fakes; survives in the live probe (F-54) | `42404b5` |
| F-10 | Deploy without tests | fixed | `42404b5` |
| F-11 | Secrets in scope of `npm ci` | partly fixed (F-55) | `42404b5` |
| F-12 | Admin key to unvalidated host | fixed | `42404b5` |
| F-13 | Installer not verified client-side | fixed; test weak (F-53) | `42404b5` |
| F-14 | TOTP seed visible | fixed | `377f3c1` |
| F-15 | Bootstrap left on disk without encryption | fixed | `42404b5` |
| F-16 | Refusals looked like success | fixed; silent refusals remain (F-69) | `377f3c1` |
| F-17 | Dev CSP shipped | fixed | `42404b5` |
| F-18 | Hard-coded "Active" badge | fixed | `42404b5` |
| F-19 | Loopback spellings missed | fixed | `42404b5` |
| F-20 | Plaintext history | fixed (documented as not encrypted) | `c9a3eeb` |
| F-21 | Cancel between R2 and D1 | **regressed / ineffective** (F-41) | `c9a3eeb` |
| F-22 | Scripts untyped | fixed | `c9a3eeb` |
| F-23 | Weak assertions | fixed | `42404b5` |
| F-24 | AI approval not revocable | fixed | `c9a3eeb` |
| F-25 | Secrets survive failed submit | partly fixed (F-66) | `c9a3eeb` |
| F-26 | Downgrade guards build-only | partly fixed (F-52) | `b740746` |

New findings start at F-27 and run to F-85.

## Method note

The premise-critical modules — the MyVault crypto, store, broker, sync, migration,
Windows Hello signer, secure dialogs, clipboard guard and `security.ts` — were read
in full by the main pass. Seven `read-only-reviewer` passes ran in parallel over:
the main-process shell and IPC; Account Spaces and Google; fill, picker, passkeys and
imports; the VS Code bridge, Control Center link and AI provider; the release path;
the renderer; and test honesty. Their raw candidates were saved to a scratch file as
each returned, and every cited line was re-read before it was accepted here. Two
defects were reproduced by running scratch scripts against the compiled modules
(F-27, F-29), two by direct runs (F-43's `EINVAL`, F-77's quoted path).

**Seven candidates were dropped** because the code did not support them or they
could not be grounded: the Control Center relay (depends on what another repository
binds), an out-of-order frame handling race in the bridge client (not reproducible
from the code alone), the unlock-versus-install race in `unlock()` (no reachable
caller interleaves them), the Settings badge masked by a corrupt update config (the
two conditions were not shown to co-occur), the AI `sourceRevision` being
renderer-supplied (the renderer is trusted by design), a dead access-token cache, and
a missing direction label in the bridge AAD (message kinds already prevent
reflection). **Two were reclassified** rather than reported as defects: public
download access (deliberate, now a Decision and drift) and external links opening in
Banking (documented, I-01). Several were merged across slices (the CSV import was
found by the main pass and by the fill slice; the fill-timing tests by two slices).

Questions from outside the lens list that found things: "does a helper that throws
run *after* the object it guards was half-built?" (F-28), and "does a sync result
check that the state it was computed from is still current?" (F-27, F-29).

Production was only ever read. The audit did not modify code, tests, secrets, the
database, or the main checkout; it ran in a separate worktree.
