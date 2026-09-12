---
system: vault
sources:
  - electron/vault.ts
  - electron/clipboard-guard.ts
verified_at: f6f0c96
---

# Vault

> Last verified: 2026-09-10

## Agent Brief

**Scope.** [electron/vault.ts](../../electron/vault.ts) is `VaultStore` — saved
credentials and authenticator secrets, encrypted at rest with Electron
`safeStorage` — plus `generateTotp`, a self-contained RFC 6238 implementation.
The store owns the file, the encryption, the corruption flag, and the rule that
the renderer never sees a secret.

**What this doc does NOT cover.** The autofill injection and the clipboard
auto-clear are implemented in `electron/main.ts`, which
[browser-shell.md](browser-shell.md) owns for source-glob purposes; their
behaviour is described in prose under **Autofill and Clipboard** below because it
is meaningless apart from the vault. The IPC channel shapes belong to
[ipc-contract.md](ipc-contract.md).

**Neighbours.**

- **The browser shell** → [browser-shell.md](browser-shell.md). Owns
  `electron/main.ts`, which holds the only `VaultStore` instance, applies the
  field-length limits, and performs autofill and clipboard work.
- **Security predicates** → [security-boundary.md](security-boundary.md). A saved
  entry's URL is normalised by `normalizeNavigationInput` and checked with
  `isAllowedRemoteUrl` before it reaches the vault.
- **The UI** → [renderer-ui.md](renderer-ui.md). Renders `VaultItemMeta` only.

### Invariants

1. **`list()` returns metadata only — never `password`, never `totpSecret`.**
   It is the only vault shape the renderer ever receives, and `add()` returns
   through it too. Adding a secret field here would leak every stored password
   into the renderer process in one edit. → **VaultStore API**
2. **Secrets leave the store through exactly three id-addressed methods.**
   `getPassword`, `getTotp` and `getForAutofill`; each has one named caller in
   the main process and none is reachable from the renderer directly.
   → **VaultStore API**
3. **Every write is atomic: a `0o600` temp file, then a rename.** Never write the
   vault path directly — a half-written file is an unrecoverable vault.
   → **Encryption and On-Disk Format**
4. **A vault that cannot be decrypted is preserved, never deleted.**
   `resetCorrupt()` renames it aside with a timestamp, because an unreadable file
   is often an OS keychain problem, not a lost file.
   → **Availability and Corruption**
5. **Autofill runs only on an exact hostname match, and only when the user asks
   for it.** No subdomain matching, no suffix matching, no automatic fill on page
   load. → **Autofill and Clipboard**
6. **A copied secret is cleared after 30 seconds only if the clipboard still
   holds it.** The check exists so the auto-clear cannot destroy something the
   user copied in the meantime. Quitting inside that window flushes the clear
   early rather than skipping it. → **Autofill and Clipboard**

### Where to look

<!-- routing:start -->

| You are changing… | Section |
| --- | --- |
| the file, its encryption, or how a write lands | [Encryption and On-Disk Format](#encryption-and-on-disk-format) |
| a store method, or any field the renderer can see | [VaultStore API](#vaultstore-api) |
| authenticator codes and their countdown | [TOTP Generation](#totp-generation) |
| startup with no keychain, or an unreadable file | [Availability and Corruption](#availability-and-corruption) |
| filling a login form, or clearing a copied secret | [Autofill and Clipboard](#autofill-and-clipboard) |
| behaviour that looks like validation but is not | [Gotchas](#gotchas) |

<!-- routing:end -->

### Before you write

- Anything added to `VaultItemMeta` is a renderer-visible field. Check
  `list()` before adding one.
- Keep `generateTotp` pure and injectable — the test pins a known vector by
  passing an explicit epoch. Do not make it read the clock internally only.
- Do not "fix" corruption by deleting the file. Rename, as `resetCorrupt` does.
- The store is constructed once, at startup, and `load()` runs in the
  constructor. It must never throw: a bad file has to degrade to an empty,
  flagged vault, not a failed launch.
- Changing the autofill selectors changes which forms fill. Test against a real
  login page before assuming a broader selector is an improvement.

## Overview

The vault is a single encrypted file holding a flat array of entries, kept in
memory for the lifetime of the process. It exists so the browser can fill a login
form and produce an authenticator code without a second application and without a
cloud account. Its design assumption is that the operating system keychain is the
only key store: there is no master password, so if `safeStorage` cannot encrypt,
the vault refuses to operate rather than falling back to something weaker.

## Encryption and On-Disk Format

The file lives at `userData/vault.enc` (`electron/main.ts:704`). One entry is
`{ id, label, url, username, password, totpSecret?, updatedAt }` — `id` is a
`randomUUID`, `updatedAt` an ISO timestamp.

**Writing** (`save()`, [vault.ts:126](../../electron/vault.ts)):

1. `mkdirSync(dirname(filePath), { recursive: true })`.
2. `safeStorage.encryptString(JSON.stringify(this.items))` → a `Buffer`.
3. The buffer is written as **base64 text** to `${filePath}.tmp` with
   `{ mode: 0o600 }`.
4. `renameSync` moves the temp file over the real one.

Base64-on-disk keeps the file plain UTF-8 text, which survives naive tooling that
would mangle raw bytes. The temp-then-rename pair is the atomicity guarantee:
rename within one directory either happens or does not, so an interrupted write
leaves the previous vault intact rather than a truncated one. The `0o600` mode is
applied by `writeFileSync` when it creates the temp file, and the rename carries
that mode to the final path.

**Reading** (`load()`, [vault.ts:112](../../electron/vault.ts)) reverses it: read
as UTF-8, `Buffer.from(text, 'base64')`, `safeStorage.decryptString`, `JSON.parse`,
and require the result to be an array.

## VaultStore API

Constructed once at startup with the file path; `load()` runs in the constructor.

- **`isAvailable(): boolean`** — `safeStorage.isEncryptionAvailable() && !corrupt`.
- **`reason()`** — `'vault-corrupt'` (checked first), `'os-encryption-unavailable'`,
  or `undefined`. The renderer shows this instead of an empty list.
- **`list(): VaultItemMeta[]`** — maps each entry to
  `{ id, label, url, username, hasTotp: Boolean(totpSecret), updatedAt }`. The
  password and the TOTP secret are dropped by destructuring, and `hasTotp` is
  reduced to a boolean. Order is newest-first because `add` uses `unshift`; there
  is no sort.
- **`add(input): VaultItemMeta`** — throws `OS encryption is not available` when
  `isAvailable()` is false. If `input.totpSecret` is present it calls
  `generateTotp(input.totpSecret)` and discards the result, the intent being to
  reject a malformed secret by letting the generator throw (see **Gotchas** — in
  practice it does not throw). Assigns `id` and `updatedAt`, `unshift`s, saves,
  and returns `this.list()[0]` — so even the create path returns metadata only.
- **`remove(id): boolean`** — filters the array, saves **only** if the length
  changed, returns whether it changed.
- **`getPassword(id): string`**, **`getTotp(id)`**, **`getForAutofill(id)`** — the
  three ways a secret leaves the store. All go through `requireItem`, which throws
  `Vault entry not found` for an unknown id. `getTotp` throws
  `No authenticator secret saved` when the entry has none, and otherwise returns
  `{ code, secondsRemaining }`. `getForAutofill` returns exactly
  `{ username, password, url }`.
- **`resetCorrupt(): boolean`** — see **Availability and Corruption**.

Field limits are enforced one level up, in `addVaultItem`
(`electron/main.ts:357-365`): label, url, username and password are all required;
label ≤200, url ≤2000, username ≤500, password ≤5000, `totpSecret` ≤500. The URL
is put through `normalizeNavigationInput` and then `isAllowedRemoteUrl` before it
is stored, which is what makes the hostname comparison in autofill meaningful.

## TOTP Generation

`generateTotp(secret: string, epochSeconds = Math.floor(Date.now() / 1000)): string`
([vault.ts:26](../../electron/vault.ts)) is RFC 6238 with the standard defaults:

1. `decodeBase32(secret)` — alphabet `A-Z2-7`. The input is uppercased, every
   character outside the alphabet is **stripped**, each remaining character
   contributes 5 bits, and the bit string is packed into bytes in 8-bit groups;
   a trailing partial group is discarded.
2. `counter = Math.floor(epochSeconds / 30)` — a 30-second step.
3. The counter is written big-endian into an 8-byte buffer
   (`writeBigUInt64BE`).
4. `HMAC-SHA1` over that buffer, keyed with the decoded secret.
5. Dynamic truncation: `offset = digest[19] & 0x0f`, then
   `digest.readUInt32BE(offset) & 0x7fffffff`.
6. `% 1_000_000`, left-padded to **6 digits**.

`VaultStore.getTotp` reads the clock once, passes that epoch into `generateTotp`,
and derives `secondsRemaining = 30 - (now % 30)` from the same reading, so the
code and its countdown can never disagree. The renderer uses the countdown to
show how long the code is good for.

[tests/security.test.ts](../../tests/security.test.ts) pins a known vector:
`generateTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59)` is `'287082'`. Keep it —
it is the only thing standing between a refactor and codes that never match.

## Availability and Corruption

`load()` distinguishes three outcomes and never throws:

- **Encryption unavailable** — returns `[]` and leaves `corrupt` false. The vault
  is empty but healthy; `reason()` reports `'os-encryption-unavailable'`.
- **No file yet** — returns `[]`. A first run.
- **Anything else throws** — an unreadable file, a failed decrypt, malformed
  JSON, or a decoded value that is not an array — sets `corrupt = true` and
  returns `[]`.

So a broken vault presents as an empty list plus a flag, and the app still
starts. `isAvailable()` then returns false, which makes `add()` refuse, and the UI
shows the reason rather than an empty vault the user might repopulate by hand.

`resetCorrupt()` ([vault.ts:81](../../electron/vault.ts)) is the escape hatch. It
returns false when nothing is wrong. Otherwise it **renames** the file to
`${filePath}.corrupt-${Date.now()}` — it does not delete it — clears the in-memory
items and clears the flag. The rename is deliberate: the usual cause is an OS
keychain that changed underneath the app, and that is often repairable, so the
ciphertext is kept. Nothing is written back until the next `save()`.

## Autofill and Clipboard

These live in `electron/main.ts`, which [browser-shell.md](browser-shell.md) owns
for source-glob purposes. They are documented here because they are the only
consumers of the three secret-returning methods.

**`copyPassword(id)`** (`main.ts:379`) copies `vault.getPassword(id)` through
`copySensitiveValue` and logs a privacy event.

**`copyTotp(id)`** (`main.ts:384`) copies the generated code and returns
`{ secondsRemaining }` so the UI can run the countdown. The code is generated
locally; nothing leaves the device.

**`copySensitiveValue(value)`** delegates to `ClipboardGuard`
([electron/clipboard-guard.ts](../../electron/clipboard-guard.ts)), which writes
the value, then schedules a 30-second timer that reads the clipboard back and
calls `clipboard.clear()` **only when it still holds the same value** — so an
auto-clear can never destroy something the user copied afterwards. A second copy
replaces the first rather than stacking timers.

The timer is still `unref()`ed, so a pending clear never keeps the process alive.
The gap that used to leave is closed by `app.on('before-quit')`, which calls
`controller.flushClipboard()` → `ClipboardGuard.flush()`: quitting inside the
window clears the secret immediately instead of abandoning it.

`ClipboardGuard` accepts both a synchronous and a promise-returning clipboard.
Electron's `clipboard.readText()`/`writeText()` were synchronous in older majors
and are promise-returning from the W3C-modelled API in Electron 44 — which the
repo is on. Accepting both means the guard does not silently stop clearing the
next time that shape changes. A `readText()` that rejects leaves the clipboard
untouched rather than throwing inside the timer.

**`autofill(id)`** (`main.ts:391`) is manual, per entry, per page:

1. It requires an active `webContents` and a tab that is not the home page,
   otherwise `Open the saved website first`.
2. `vault.getForAutofill(id)` yields `{ username, password, url }`.
3. **`new URL(credential.url).hostname` must equal `new URL(tab.url).hostname`**
   — exact string equality, no subdomain or suffix matching — otherwise
   `This credential belongs to another website`. This is the check that stops a
   lookalike page from harvesting a saved credential.
4. The pair is serialised with `JSON.stringify` and embedded in a small IIFE run
   through `contents.executeJavaScript(..., true)` in the page's own world. The
   script writes each field through the native
   `HTMLInputElement.prototype.value` setter obtained from
   `Object.getOwnPropertyDescriptor`, then dispatches bubbling `input` and
   `change` events — that is what makes React and similar frameworks register the
   value instead of ignoring a direct assignment.
5. Selectors: `input[type="password"]` for the password, and
   `input[autocomplete="username"], input[type="email"], input[name*="user" i], input[name*="email" i]`
   for the username. No password field means it throws
   `No password field found`.
6. On success it logs a privacy event carrying the hostname only.

A site can still observe what is typed into its own form — see
[SECURITY.md](../../SECURITY.md) — which is why the hostname check and the manual
trigger are the whole of the protection here.

## Related Systems

### Account Space backup boundary

My Vault remains authoritative and is never copied into Google Drive app data.
Account Space backup has a separate random recovery key and `safeStorage`
wrapper; it excludes passwords, TOTP/passkeys and every vault record. See
[google-account-spaces.md](google-account-spaces.md#encrypted-drive-backup).

- [security-boundary.md](security-boundary.md) — URL normalisation applied to a
  saved entry, and the base32 pattern in `redactSensitiveText` that keeps a TOTP
  secret out of AI previews.
- [ai-consent.md](ai-consent.md) — the other `safeStorage` user; same atomic write
  pattern, same corrupt-file handling.
- [ipc-contract.md](ipc-contract.md) — the `vault:*` channels.

## Gotchas

- **`add()`'s TOTP validation does not actually reject a bad secret.**
  `decodeBase32` strips characters outside `A-Z2-7` instead of rejecting them, so
  its `Invalid authenticator secret` throw is unreachable, and HMAC over an empty
  key succeeds. `generateTotp('!!!!')` returns a six-digit code rather than
  throwing. A mistyped secret is therefore stored happily and produces codes that
  never match. Verified against Node at this SHA.
- **Quitting within 30 seconds no longer leaves a copied secret on the
  clipboard.** The auto-clear timer is still `unref()`ed so it does not hold the
  process open, but `before-quit` flushes it. What remains uncovered is a hard
  kill — a crash or Task Manager — which runs no handler and so leaves the value
  in place until something overwrites it. Windows Clipboard History, if the user
  has it enabled, keeps its own copy that this clear does not reach.
- **`0o600` is applied on creation of the temp file.** A stale `.tmp` left by an
  earlier crash keeps whatever permissions it already had, and on Windows the
  POSIX mode is largely advisory — which is why
  [SECURITY.md](../../SECURITY.md) says "where the operating system supports
  them".
- **`.corrupt-<timestamp>` files accumulate.** Nothing prunes them and each is a
  full encrypted copy of the vault. They keep the original mode through the
  rename.
- **There is no update method.** Editing an entry means remove plus add, which
  issues a new `id` and moves the entry to the top of the list.
- **Reads are not gated on `isAvailable()`.** `getPassword` and friends work off
  the in-memory array; when the vault is corrupt that array is empty, so they
  fail with `Vault entry not found` rather than a clearer message.
