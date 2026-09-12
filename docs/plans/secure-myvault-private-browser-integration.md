---
title: Secure MyVault–Private Browser integration is live and verified
source: conversation 2026-09-12
created: 2026-09-12
status: in-progress
---

# Secure MyVault–Private Browser Integration

## Context

Make MyVault the sole vault and turn Private Browser into a brokered MyVault client. Implement additive MyVault protocol changes first, then the browser client, migration, passkeys, and coordinated releases.

Audit baseline:

- Private Browser `0.3.1` at `8c8d2be`; MyVault `1.0.0-rc.1` at `ccb64ab`.
- Both repositories are clean and their complete `npm run check` gates pass: 101 Private Browser tests and 512 MyVault tests.
- Production MyVault health is green at `ccb64ab`; configured secret names are `SYNC_AUTH_TOKEN` and `SYNC_READONLY_TOKEN`.
- MyVault’s `AGENTS.md`, `CLAUDE.md`, and Wrangler comments incorrectly describe `SYNC_AUTH_TOKEN` as the only Worker secret and must be corrected.
- MyVault uses envelope v1, payload schema v2, Argon2id at 64 MiB/3 iterations/parallelism 1, AES-256-GCM, 12-byte IVs, 128-bit tags, and committed vectors that must remain unchanged.
- MyVault synchronization is authenticated HTTP with CAS versioning, ten encrypted revisions, no polling, and explicit conflicts. The Worker currently uses shared bearer secrets and has no device credentials.
- Private Browser’s current `safeStorage` vault is independent and login-only. Its autofill currently embeds credentials into page-world JavaScript and must be replaced.
- Open Private Browser PR #10 overlaps central Electron/UI files and presently fails its secret guard; open MyVault PR #42 is draft and conflicts with `main`. Leave both untouched, branch from current `main`, and rebase before each PR so any subsequently merged work is preserved.

### 1. Contract and credential foundation

- Create coordinated branches from refreshed default branches and record phase progress in each repository’s `BUILD_LOG.md`.
- In MyVault, add additive D1 tables for device credentials and single-use enrollments.
- Add backward-compatible create/list/revoke/redeem endpoints and accept scoped device credentials on `/api/v1/vault` while preserving legacy clients.
- Rate-limit enrollment and redemption, store only token hashes, use generic unauthorized responses, and limit last-used writes.
- Add MyVault device management UI without persisting or redisplaying raw tokens.
- Rotate `SYNC_READONLY_TOKEN` through non-logging input before browser connection; do not rotate `SYNC_AUTH_TOKEN` until all existing clients migrate.
- Correct stale documentation and pin copied protocol/crypto fixtures without a cross-repository private package.

### 2. Trusted Private Browser broker

- Implement one singleton trusted broker that owns MyVault envelope cryptography, schema handling, metadata projection, TOTP, generators, sync, and decrypted state.
- Store only the exact encrypted envelope plus OS-encrypted connection state; preserve corrupt files; support offline unlock/edit and explicit CAS conflicts without polling or locked synchronization.
- Use hardened broker-owned credential/secret dialogs. Ordinary React receives metadata and intent-only APIs, never master passwords, tokens, data keys, payloads, or secrets.
- Share lock/sync state across windows and invalidate pending operations on lock, navigation, tab/workspace switch, or timeout.

### 3. Browser experience, fill, save, and policies

- Add the address-bar MyVault icon, compact panel, full metadata screen, status, search, matches, TOTP, generators, CRUD intents, and warnings in the existing design.
- Replace page-world credential interpolation with single-use, exact-origin, navigation-bound isolated-world fill operations that never submit.
- Use direct broker clipboard operations with digest-based unchanged-value clearing.
- Detect form shape only until explicit Save/Update, capture minimum fields once, confirm in trusted UI, and never capture banking/card data or save automatically.
- Enforce Banking, Development, Digitronics, TenTen, and Personal policies centrally and prove AI/agents/DevTools cannot access Vault data.

### 4. Migration and imports

- Freeze the legacy Private Browser vault read-only, create and verify an encrypted backup, and journal an idempotent resumable migration.
- Import login/TOTP records with stable duplicate handling and secret-free validation; retain the old ciphertext and require explicit cleanup.
- Route Chrome CSV passwords directly into MyVault while leaving bookmarks, history, and settings in Private Browser.

### 5. Passkeys and release

- Port reviewed MyVault passkey records, ES256/CBOR/COSE, origin rules, ceremonies, and approval logic; do not load the Chrome extension unchanged.
- Keep passkeys globally/workspace/site disabled by default and use a CDP document-start shim with Electron-derived authority and unchanged OS fallback.
- Ship passkeys only when automated tests prove origin binding, lifecycle races, provider conflicts, cancellation, and fallback; otherwise leave disabled with the failed gate documented.
- Release MyVault `1.1.0-rc.1` first with additive migrations, then Private Browser `0.5.0` with installer/update artifacts and live verification.

### Security and acceptance assumptions

- The selected destination webpage may observe only the one credential deliberately filled into its own form; it receives no general Vault access.
- Master-password unlock ships first. Biometric/Windows Hello remains deferred unless a real device-local cryptographic key wrap can be proved without changing the cloud envelope.
- Initial provisioning may fetch ciphertext after the password enters the secure broker flow; established locked vaults perform no network synchronization.
- Completion requires MyVault to be the only writable vault, recoverable migration, all gates green, backward-compatible MyVault production live, and an installed Private Browser release verified.

## Steps

- [x] 1. Persist coordinated execution records and compatibility contract — done when: both repos record the work and Private Browser independently passes MyVault’s unchanged envelope/schema vectors — check: `node C:/Users/abuye/.agents/skills/implement-plan/scripts/plan-check.mjs docs/plans/secure-myvault-private-browser-integration.md && npx vitest run tests/myvault-compatibility.test.ts`
- [ ] 2. Add scoped device credential schema and Worker APIs — done when: additive local migrations apply and enrollment, redemption, authorization, scope, revocation, replay, and legacy-token integration tests pass — check: `cd C:/Users/abuye/My_vault && npm run lint && npx vitest run worker/vaultApi.test.ts worker/deviceCredentials.test.ts`
- [ ] 3. Add MyVault device-management UI and synchronize security/deployment documentation — done when: administrators can create/list/revoke devices without persisted raw tokens and stale secret claims are gone — check: `cd C:/Users/abuye/My_vault && npm run check`
- [ ] 4. Implement the encrypted local store and trusted VaultBroker boundary — done when: compatibility, wrong-password, tamper, corrupt-file, future-schema, offline, locking, atomic-write, and redaction tests pass — check: `npm test -- --run tests/myvault-compatibility.test.ts tests/vault-broker.test.ts tests/vault-security-boundary.test.ts`
- [ ] 5. Implement metadata-only IPC and hardened secure dialogs — done when: the normal renderer can issue only validated intents and tests prove no secret-bearing response crosses `window.privateBrowser` — check: `npm test -- --run tests/ipc-contract.test.ts tests/vault-security-boundary.test.ts`
- [ ] 6. Implement compact/full Vault UI and exact-origin fill/copy/generation flows — done when: metadata search, matches, TOTP, generators, isolated-world single-use fill, clipboard, warnings, and shared lock status work — check: `npm test -- --run tests/vault-broker.test.ts tests/security-boundary.test.ts tests/renderer-layout.test.ts`
- [ ] 7. Implement explicit save/update and workspace policies — done when: deliberate one-shot capture works and Banking/Development/AI/DevTools restrictions are enforced centrally — check: `npm test -- --run tests/vault-browser-integration.test.ts tests/security-boundary.test.ts`
- [ ] 8. Implement MyVault write synchronization and conflicts — done when: offline edits, reconnect, edit-during-sync, CAS conflicts, vault-ID mismatch, revoked/wrong/read-only credentials, and no-locked-network behavior pass — check: `npm test -- --run tests/vault-sync.test.ts tests/vault-broker.test.ts`
- [ ] 9. Implement resumable legacy-vault migration and Chrome password import — done when: encrypted backup, journal recovery, stable duplicates, validation, rollback retention, and MyVault-only password routing pass — check: `npm test -- --run tests/vault-migration.test.ts tests/chrome-import.test.ts`
- [ ] 10. Implement gated MyVault passkeys — done when: Electron tests prove first-script interception, Electron-derived origin/RP binding, iframe/opaque refusal, races/replay/cancellation/provider conflict, immutable registration, non-mutating sign-in, and OS fallback; otherwise the provider remains disabled with the failed gate recorded — check: `npm run test:electron -- --grep passkey`
- [ ] 11. Complete security and browser verification — done when: both full repository gates, MyVault UI/sync/passkey E2E, Electron Playwright security journeys, dependency/secret scans, production builds, and visible supported-browser checks pass — check: `npm run check && cd C:/Users/abuye/My_vault && npm run check && npm run test:e2e && npm run test:e2e:sync && npm run test:e2e:passkeys`
- [ ] 12. Release MyVault before Private Browser and verify production artifacts — done when: additive D1 migration and exact MyVault commit are live, legacy clients still work, the exact Private Browser commit has a verified Windows installer/update manifest, and live health/download checks prove both revisions — check: `manual: direct Wrangler deployment IDs, live health commit, installer smoke evidence, download/update metadata, and GitHub CI are recorded without secrets`

## Tail

- [ ] T1. Adversarial review of both whole diffs — done when: every finding is fixed or written to the Ledger with a reason — check: `git diff origin/main...HEAD && git -C C:/Users/abuye/My_vault diff origin/main...HEAD`
- [ ] T2. Similar-issue and secret-exposure sweep — done when: sibling IPC, extraction, logging, sync, migration, and passkey paths were searched and all matches reviewed — check: `manual: record searches and findings in the Ledger`
- [ ] T3. Full checks and packaging green — done when: both repository checks, required E2E suites, audits, and Windows packaging exit zero — check: `npm run check && cd C:/Users/abuye/My_vault && npm run check`
- [ ] T4. Docs, histories, changelogs, and version metadata synced — done when: subsystem docs describe current behavior and docs guards have no relevant drift — check: `npm run docs:check && cd C:/Users/abuye/My_vault && npm run docs:check`
- [ ] T5. Changes committed path-scoped and pushed — done when: both feature branches are clean, published, reviewed by CI, and merged/rebased without losing unrelated work — check: `git status --short && git -C C:/Users/abuye/My_vault status --short`
- [ ] T6. Direct production and installed-app verification complete — done when: live Worker health/revision, D1 device auth, download service, update metadata, and installed Electron journeys are verified — check: `manual: release receipt and browser/installer evidence recorded in the Ledger`
- [ ] T7. A dated claim is registered — done when: downstream probes cover MyVault device auth and Private Browser artifact/update health with deadlines — check: `manual: prove-it claim IDs and deadlines recorded`

## Ledger

- 2026-09-12 11:05 — created from the approved conversation plan; Private Browser refreshed from `68e8356`, MyVault from `ccb64ab`; unrelated PRs #10 and #42 left untouched.
- 2026-09-12 11:09 — step 1 — the repository hook renamed the Private Browser branch to `feat/private-browser-bridge`; accepted the scoped name and kept the coordinated MyVault branch unchanged.
- 2026-09-12 11:11 — step 1 — used MyVault's complete portable type file but replaced its UI-only `IconName` import with an opaque string because visual registries are outside the envelope contract; all five unchanged vectors passed, including production Argon2id cost.
