---
system: vault
sources:
  - electron/vault.ts
  - electron/clipboard-guard.ts
  - electron/myvault/**
verified_at: 7063e89
---

# MyVault broker

> Last verified: 2026-09-12

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
   enters an explicit conflict and never auto-merges or overwrites.
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
   reset and new-password forms, and picks the most recently updated login unless
   a manual Fill established a preferred login for that origin during the session.
7. Clipboard writes go broker-to-OS. Only a digest survives for unchanged-value
   clearing; lock and quit flush pending secret content.
8. Page inspection exposes shape only. Explicit Save/Update reads minimum login
   fields once, refuses payment/OTP capture and confirms full origin plus username
   in trusted UI.
9. Banking disables AI, extraction, DevTools, extensions, capture, automatic fill
   and password clipboard and reconfirms every manual fill. Development exposes
   neither vault metadata nor broker operations.
10. The internal passkey provider is disabled by default and release-gated.
    Registration appends one immutable encrypted record, authentication does not
    mutate, and every refusal preserves the original OS WebAuthn operation.

## Components

- `vault-broker.ts` — unlocked state, metadata, encryption and mutations.
- `vault-store.ts` — envelope, protected connection state and atomic recovery.
- `vault-sync.ts` / `sync-controller.ts` — redemption, CAS and dirty scheduling.
- `secure-dialog.ts` / `secure-preload.cts` — isolated one-shot secret UI.
- `fill-capability.ts` / `automatic-fill.ts` / `isolated-fill.ts` — exact-context
  manual and Chrome-style automatic browser operations.
- `vault-migration.ts` — verified backup, protected journal, stable duplicates,
  direct Chrome CSV import and explicit cleanup.
- `passkey-controller.ts` / `security/passkeys/*` — disabled gated provider core.

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
