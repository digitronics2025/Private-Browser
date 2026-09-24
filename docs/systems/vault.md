---
system: vault
sources:
  - electron/vault.ts
  - electron/clipboard-guard.ts
  - electron/myvault/**
verified_at: e2c2bde6
---

# MyVault broker

> Last verified: 2026-09-24

## Agent Brief

**Scope.** The singleton `VaultBroker` owns MyVault envelope crypto, decrypted
state, metadata, TOTP, generators and mutations. `electron/vault.ts` now exports
only the legacy RFC 6238 helper; old Private Browser ciphertext is read solely by
the migration service and has no write API.

**Trust boundary.** React receives metadata and intent-only calls. Passwords,
device credentials, data keys, payloads and entry secrets stay in the Electron
main process or hardened one-shot dialogs. Lock releases decrypted references,
invalidates pending capabilities and closes dialogs without claiming guaranteed
memory wiping.

### Invariants

1. The exact encrypted MyVault envelope is the only writable vault file.
   Connection metadata, CAS version, dirty state, journal and device token are
   separate `safeStorage` ciphertext. Persistence fails closed when OS encryption
   is unavailable.
2. Every mutation re-encrypts and atomically persists before completion. Corrupt
   or future envelopes move to timestamped recovery names and block writes until
   explicit recovery.
3. Established locked vaults make no network requests. Unlocked sync is triggered
   by explicit action, unlock, reconnect or one 45-second dirty delay. CAS 409
   enters an explicit conflict and never auto-merges or overwrites; so does a
   pull that lands after a local change made while it was in flight. Mutations
   and accepted pulls run through one broker queue, and a sync that finishes
   after lock updates sync metadata only — it never re-opens the vault.
4. Pairing takes a ten-minute single-use enrollment code in secure UI. The
   returned `mvd_...` token never reaches React and is stored only by `safeStorage`.
5. Fill capabilities are single-use and bind WebContents, tab, navigation
   generation, workspace, Account Space, exact scheme/host/effective port, entry,
   operation and expiry. Context is revalidated around broker resolution and injection.
6. Isolated-world fill targets recognized username/password/OTP fields and never
   submits. Downgrade, certificate error, punycode, opaque or cross-origin frame,
   navigation, workspace, lock, timeout and replay all fail closed.
   In Digitronics, TenTen and Personal, an unlocked vault automatically fills
   matching normal HTTPS login forms after navigation. It retries briefly for
   client-rendered forms, never overwrites populated fields, refuses signup,
   reset and new-password forms, and picks the remembered login for the site
   (below) when it is an exact match, otherwise the most recently updated one.
   The same three workspaces (policy flag `fillPicker`) show a Chrome-style login
   list under a focused sign-in field. It opens only on genuine input (a left
   click, Tab, or ArrowDown in the page), never on page script. It lists (up to
   50, scrolling) the logins for this exact origin, then those saved for other
   addresses of the same site (`isSameSiteFillCandidate`: same registrable domain
   per the Public Suffix List, same port, no https-to-http), each labelled with
   its saved host. Only a pick from the list may fill a same-site login
   (`fillEntryInto(..., 'same-site')`); automatic fill and the side panel's Fill
   stay exact-origin. The list opens below the field, or above it when there is
   more room there, shrinks to the space on that side, and never covers the
   field. The last login picked on a site (manual Fill or picker) is remembered
   per registrable domain in `myvault/fill-preferences.enc` (`safeStorage` only;
   memory-only when OS encryption is unavailable; 500 sites). It leads the list
   and is preferred by automatic fill when it is an exact match. The list is a separate sandboxed
   `WebContentsView` with its own two-channel preload. The page never sees the
   usernames, and the overlay never sees an entry id: it returns a row index that
   main maps back, once, only from that view and with its nonce. The page keeps
   keyboard focus (arrows, Enter and Escape are read in `before-input-event`).
   Navigation, a tab, workspace or layout change, lock, window blur, a click
   elsewhere or 10 s idle all close it, and a choice made after the context moved
   on fills nothing. A pointer choice in the first 500 ms after the rows are
   drawn is ignored, in main and in the overlay (which keeps its one choice), so
   a page cannot turn a double-click into a pick.
7. Clipboard writes go broker-to-OS. Only a digest survives for unchanged-value
   clearing; lock and quit flush pending secret content.
8. Page inspection exposes shape only. Explicit Save/Update reads minimum login
   fields once, refuses payment/OTP capture and confirms full origin plus username
   in trusted UI.
9. Banking disables AI, extraction, DevTools, extensions, capture, automatic fill
   and password clipboard and reconfirms every manual fill. Development exposes
   neither vault metadata nor broker operations.
10. Windows Hello unlock is opt-in and never replaces the master password,
    which is re-checked before any Hello prompt. Details: **Windows Hello unlock**.
11. The internal passkey provider is disabled by default and release-gated.
    Registration appends one immutable encrypted record, authentication does not
    mutate, and every refusal preserves the original OS WebAuthn operation.

## Components

- `vault-broker.ts` — unlocked state, metadata, encryption and mutations.
- `vault-store.ts` — envelope, protected connection state and atomic recovery.
- `vault-sync.ts` / `sync-controller.ts` — redemption, CAS and dirty scheduling.
- `secure-dialog.ts` / `secure-preload.cts` — isolated one-shot secret UI.
- `fill-capability.ts` / `automatic-fill.ts` / `isolated-fill.ts` — exact-context
  manual and Chrome-style automatic browser operations; `orderFillCandidates` is
  the one ordering both automatic fill and the picker use, and
  `probeFocusedLoginField` reports which sign-in field has focus and where.
- `fill-picker.ts` / `fill-picker-model.ts` / `fill-picker-preload.cts` — the
  login picker overlay: view lifecycle, single-use sessions, placement under or
  above the field, and escaped static markup. A discarded overlay's late events
  close only that overlay, never its replacement.
- `fill-preferences.ts` — `FillPreferenceStore`, the per-site remembered pick.
- `site-match.ts` — `registrableSite` and `isSameSiteFillCandidate` (main-process
  only; `tldts` must not reach the renderer bundle).
- `vault-migration.ts` — verified backup, protected journal, stable duplicates,
  direct Chrome CSV import and explicit cleanup.
- `windows-hello.ts` — the Hello signer (`KeyCredentialManager` via PowerShell),
  status mapping and key naming; the broker's `enrollPlatformUnlock`,
  `unlockWithPlatform` and `removePlatformUnlock` own the wrap.
- `passkey-controller.ts` / `security/passkeys/*` — disabled gated provider core.

## Windows Hello unlock

Turning it on needs the vault unlocked and the master password again (the
`enroll-hello` secure dialog). Hello keeps an RSA key named
`PrivateBrowser-MyVault-<vaultId>` and signs a stored random challenge; the
deterministic signature is HKDF-stretched into a key that wraps the data key a
second time under its own AAD. The wrap lives in `myvault/platform-unlock.enc`
(`safeStorage`). A wrong or missing Hello key deletes the record, a cancel keeps
it, an unreadable record is discarded without blocking, and installing a
different vault identity drops it. The WinRT call runs in a short-lived
`powershell.exe` addressed by absolute path, with the challenge on stdin.
PowerShell 5.1 cannot pass a native WinRT `IBuffer` back into a WinRT call, so
bytes cross as managed buffers (`AsBuffer` in, `ToArray` out).

## Compatibility

`electron/myvault/COMPATIBILITY.md` pins source MyVault commit `ccb64ab` and the
fixture digest. Envelope v1, payload schema v2, Argon2id 64 MiB/3/1,
AES-256-GCM, 12-byte IVs and 128-bit tags require coordinated additive fixtures
before change.

## Account Space backup boundary

MyVault remains authoritative and is never included in Google Drive app-data
Account Space backup. Account backup uses separate recovery material and excludes
vault records, credentials, keys, tokens, passwords, passkeys, and TOTP secrets.

## Verification

Run `npm test`, `npm run test:e2e` and `npm run check`. The passkey provider stays
disabled until every packaged-Electron gate in `docs/security/passkeys.md` passes.
