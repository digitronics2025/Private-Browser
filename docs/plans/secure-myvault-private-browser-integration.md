---
title: Secure MyVault–Private Browser integration is live and verified
source: conversation 2026-09-12
created: 2026-09-12
status: done
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
- [x] 2. Add scoped device credential schema and Worker APIs — done when: additive local migrations apply and enrollment, redemption, authorization, scope, revocation, replay, and legacy-token integration tests pass — check: `cd C:/Users/abuye/My_vault && npm run lint && npx vitest run worker/vaultApi.test.ts worker/deviceCredentials.test.ts`
- [x] 3. Add MyVault device-management UI and synchronize security/deployment documentation — done when: administrators can create/list/revoke devices without persisted raw tokens and stale secret claims are gone — check: `cd C:/Users/abuye/My_vault && npm run check`
- [x] 4. Implement the encrypted local store and trusted VaultBroker boundary — done when: compatibility, wrong-password, tamper, corrupt-file, future-schema, offline, locking, atomic-write, and redaction tests pass — check: `npx vitest run tests/myvault-compatibility.test.ts tests/vault-broker.test.ts tests/vault-security-boundary.test.ts`
- [x] 5. Implement metadata-only IPC and hardened secure dialogs — done when: the normal renderer can issue only validated intents and tests prove no secret-bearing response crosses `window.privateBrowser` — check: `npx vitest run tests/ipc-contract.test.ts tests/vault-security-boundary.test.ts`
- [x] 6. Implement compact/full Vault UI and exact-origin fill/copy/generation flows — done when: metadata search, matches, TOTP, generators, isolated-world single-use fill, clipboard, warnings, and shared lock status work — check: `npx vitest run tests/vault-broker.test.ts tests/vault-browser-integration.test.ts tests/vault-security-boundary.test.ts tests/renderer-layout.test.ts`
- [x] 7. Implement explicit save/update and workspace policies — done when: deliberate one-shot capture works and Banking/Development/AI/DevTools restrictions are enforced centrally — check: `npx vitest run tests/vault-browser-integration.test.ts tests/vault-security-boundary.test.ts tests/developer-tools.test.ts tests/security.test.ts`
- [x] 8. Implement MyVault write synchronization and conflicts — done when: offline edits, reconnect, edit-during-sync, CAS conflicts, vault-ID mismatch, revoked/wrong/read-only credentials, and no-locked-network behavior pass — check: `npx vitest run tests/vault-sync.test.ts tests/vault-broker.test.ts`
- [x] 9. Implement resumable legacy-vault migration and Chrome password import — done when: encrypted backup, journal recovery, stable duplicates, validation, rollback retention, and MyVault-only password routing pass — check: `npx vitest run tests/vault-migration.test.ts tests/chrome-import.test.ts`
- [x] 10. Implement gated MyVault passkeys — done when: Electron tests prove first-script interception, Electron-derived origin/RP binding, iframe/opaque refusal, races/replay/cancellation/provider conflict, immutable registration, non-mutating sign-in, and OS fallback; otherwise the provider remains disabled with the failed gate recorded — check: `npx vitest run tests/passkeys.test.ts && rg -n "release gate disabled|failingGate" BUILD_LOG.md docs/security/passkeys.md electron/myvault/passkey-controller.ts`
- [x] 11. Complete security and browser verification — done when: both full repository gates, MyVault UI/sync/passkey E2E, Electron Playwright security journeys, dependency/secret scans, production builds, and visible supported-browser checks pass — check: `npm run check && cd C:/Users/abuye/My_vault && npm run check && npm run test:e2e && npm run test:e2e:sync && npm run test:e2e:passkey-cloud`
- [x] 12. Release MyVault before Private Browser and verify production artifacts — done when: additive D1 migration and exact MyVault commit are live, legacy clients still work, the exact Private Browser commit has a verified Windows installer/update manifest, and live health/download checks prove both revisions — check: `manual: direct Wrangler deployment IDs, live health commit, installer smoke evidence, download/update metadata, and GitHub CI are recorded without secrets`

## Tail

- [x] T1. Adversarial review of both whole diffs — done when: every finding is fixed or written to the Ledger with a reason — check: `git diff origin/main...HEAD && git -C C:/Users/abuye/My_vault diff origin/main...HEAD`
- [x] T2. Similar-issue and secret-exposure sweep — done when: sibling IPC, extraction, logging, sync, migration, and passkey paths were searched and all matches reviewed — check: `manual: record searches and findings in the Ledger`
- [x] T3. Full checks and packaging green — done when: both repository checks, required E2E suites, audits, and Windows packaging exit zero — check: `npm run check && cd C:/Users/abuye/My_vault && npm run check`
- [x] T4. Docs, histories, changelogs, and version metadata synced — done when: subsystem docs describe current behavior and docs guards have no relevant drift — check: `npm run docs:check && cd C:/Users/abuye/My_vault && npm run docs:check`
- [x] T5. Changes committed path-scoped and pushed — done when: both feature branches are clean, published, reviewed by CI, and merged/rebased without losing unrelated work — check: `git status --short && git -C C:/Users/abuye/My_vault status --short`
- [x] T6. Direct production and installed-app verification complete — done when: live Worker health/revision, D1 device auth, download service, update metadata, and installed Electron journeys are verified — check: `manual: release receipt and browser/installer evidence recorded in the Ledger`
- [x] T7. Dated claim registration was audited — done when: the repository is checked for an existing claims register, scheduler, and alert delivery path; no unread register is bootstrapped when none exists — check: `manual: prove-it audit result recorded in the Ledger`

## Ledger

- 2026-09-12 11:05 — created from the approved conversation plan; Private Browser refreshed from `68e8356`, MyVault from `ccb64ab`; unrelated PRs #10 and #42 left untouched.
- 2026-09-12 11:09 — step 1 — the repository hook renamed the Private Browser branch to `feat/private-browser-bridge`; accepted the scoped name and kept the coordinated MyVault branch unchanged.
- 2026-09-12 11:11 — step 1 — used MyVault's complete portable type file but replaced its UI-only `IconName` import with an opaque string because visual registries are outside the envelope contract; all five unchanged vectors passed, including production Argon2id cost.
- 2026-09-12 11:15 — step 2 — added forward-only migration `0003_sync_devices.sql` following MyVault's existing migration convention rather than inventing rollback files; local D1 migration and 45 Worker integration tests passed.
- 2026-09-12 11:29 — step 3 — added in-memory-only enrollment display plus device list/revoke controls, corrected the two-secret rollout contract, bumped MyVault and both extension manifests to `1.1.0-rc.1`, and passed the complete 521-test build gate.
- 2026-09-12 11:35 — step 4 — kept the broker in Electron's trusted main process so OS `safeStorage`, atomic persistence, and downstream WebContents execution share one narrow boundary; the ordinary renderer receives projections only. Lock drops payload/key references and advances a generation rather than claiming guaranteed memory wiping. Twenty-one broker/crypto/boundary tests passed.
- 2026-09-12 11:40 — step 5 — removed secret-bearing add/reset/delete payloads from the ordinary preload, routed unlock/edit/delete through modal one-shot preloads, and bounded every secure submission by kind, sender WebContents, nonce, size, scheme, timeout, and single use. Targeted IPC/boundary tests, TypeScript, and the secret guard passed.
- 2026-09-12 11:44 — step 6 — added address-bar MyVault access, compact/full metadata views, search, sync/lock state, TOTP countdown, broker-only password/passphrase/PIN generation, and internal one-shot fill capabilities. Fill is bound to the exact effective origin, tab, WebContents, navigation generation, workspace, entry, operation, and deadline; it refuses certificate-error and punycode pages and executes only recognized inputs in isolated world 1007 without submission.
- 2026-09-12 11:49 — step 7 — page inspection exposes form shape only; explicit Save reads only recognized login fields once, rejects card/CVV/OTP fields, confirms full origin and account in trusted UI, and updates by exact origin plus username. Central policy disables Banking AI/capture/DevTools/extensions/password clipboard and requires per-fill origin approval; Development cannot reach vault metadata or operations. Forty-one focused tests passed.
- 2026-09-12 11:53 — step 8 — one-time enrollment and remote fetch occur only after the master password is entered in trusted UI. Established locked vaults make no requests; unlocked sync runs on explicit action, reconnect, unlock, or one 45-second dirty delay. CAS 409 enters a metadata-review conflict with explicit cloud/local choice, in-flight edits remain dirty, and wrong/revoked/read-only credentials share one unauthorized type. Twelve sync/broker tests passed.
- 2026-09-12 11:58 — step 9 — the old vault is no longer writable. Migration hash-verifies a timestamped ciphertext copy before decrypting, journals each stable source mapping under OS encryption, resumes idempotently, requires trusted confirmation for changed duplicates, validates only non-secret fields/counts, and retains rollback ciphertext until a separate confirmed cleanup. Chrome CSV rows go main-process-to-broker; the plaintext source is never auto-deleted. Migration/import tests passed.
- 2026-09-12 12:01 — step 10 — ported MyVault's immutable record semantics and portable ES256/CBOR/COSE ceremony primitives plus a fail-closed exact-host origin subset and internal CDP document-start shim that always preserves OS fallback. The provider remains globally disabled because this repo lacks the required packaged-Electron Playwright proof that CDP injection precedes the first inline script; the exact gate and prerequisites are documented in `docs/security/passkeys.md`. Twelve passkey/broker tests passed.
- 2026-09-12 12:23 — step 11 — both complete repository checks are green (Private Browser 155 tests after rebasing landed Chrome import; MyVault 521), npm high-severity audits are clean, and the secret/docs guards pass. MyVault browser E2E finished 241 passed/19 intentional skips, the real-D1 sync journey passed, and passkey-cloud passed after one environment Chromium process exit during an evidence screenshot and a clean full rerun. Private Browser's Electron Playwright journey proves the normal renderer has no password field, pairing opens a distinct one-shot window with DevTools closed, and Development exposes no MyVault button.
- 2026-09-12 12:28 — rebase — rebased over landed `origin/main` commit `782ea78`, preserved local Chrome profile/bookmark/history behavior, removed its now-obsolete legacy `VaultStore.addMany` password path, and routed both Chrome-password entry points to the MyVault broker. Full post-rebase typecheck and Electron compile pass.
- 2026-09-12 12:32 — packaging gate — the first NSIS artifact built but the installed executable failed before UI startup with `Error loading V8 startup snapshot file`; this exposed a pre-existing incompatible `loadBrowserProcessSpecificV8Snapshot` fuse. Disabled only that fuse, retained the remaining hardening fuses, and required a clean rebuild plus installed-process smoke before release.
- 2026-09-12 12:24 — security audit — reviewed SQL construction, device scope/auth/replay, generic unauthorized behavior, CSP/headers, renderer/preload exposure, isolated-world calls, logs, AI extraction and committed-secret patterns. No critical/high findings remained; shortened the device-management HTTP deadline from 12 seconds to the protocol-wide 10-second bound. Page diagnostics reads counts/title only, and AI `innerText` does not include input values or any separate vault/secure-window DOM.
- 2026-09-12 13:30 — release ordering — MyVault PR #45 merged first. Production is live at `f197444` as `1.1.0-rc.1`; Worker deployment `33d2ab52-08d2-436b-b2ea-8f5f87dfdd8d` routes 100% to version `117f0067-7703-440a-a4ad-857fe361179f`. `/healthz` returns 200 with both sync credentials configured and commit `f197444`; remote D1 contains `sync_devices` and `sync_device_enrollments`; unauthenticated vault access returns the generic 401; extensions manifest hashes are live. CI run `34691743203` passed the full check, PWA/browser, real-D1 sync, passkey-cloud, and direct deployment. `SYNC_READONLY_TOKEN` was rotated through non-logging stdin; `SYNC_AUTH_TOKEN` was intentionally retained for legacy compatibility.
- 2026-09-12 13:31 — integration merge — rebased repeatedly over independently landed Chrome import, VS Code bridge, Cloudflare gate, and stable-version changes, preserving each before Private Browser PR #16 merged as `e306e59`. Exact-head PR checks `34693537746` and `34693537763` passed full verification, CodeQL, Windows named-pipe transport, Electron MyVault security E2E, hardened installer build, and isolated VSIX installation.
- 2026-09-12 13:44 — Private Browser release — remote D1 had no pending migration; direct Wrangler deploy from `e306e59` produced version `6ed67310-af48-45ce-8c07-a61d0301a69b`, then exact-commit main CI deploy `34693877646` completed and secret installation produced active version `f77e0b0f-0877-4ed0-96f7-487be2ad2ee1`. Live `/health` is 200 with database `ok` and `releaseReady: true`; unauthenticated update lookup is the generic 404.
- 2026-09-12 13:44 — artifact receipt — main run `34693877661` passed the 168 unit/integration checks, four Playwright journeys, real Windows Electron boundary, Windows installer, VSIX smoke, publication, and authenticated full/range/resume download verification. D1 build 50 points to `releases/0.5.0/50/Private-Browser-0.5.0-Setup.exe` at commit `e306e59`, size `115151254`, SHA-256 `3ecac7b2bc6659cdaf05ee3462925bf1d0a2c96cf0f62141d056f33ef0d7da27`; the GitHub artifact and downloaded R2 object match exactly. CycloneDX 1.5 SBOM parsed with 649 components. A clean per-user install stayed running through launch smoke. Authenticode is `NotSigned` because no signing certificate is configured; this is the plan's single permitted external action.
- 2026-09-12 13:44 — operational evidence — the `prove-it` audit found no existing claims register, scheduler, or alert sender in either repository, so it correctly did not create an unread register. Immediate production probes and CI receipts above are authoritative; establishing the first operational notification channel remains separate infrastructure scope. The VS Code Integrated Browser/controllable Browser surface was unavailable in this environment; supported Playwright CLI and the actual packaged Electron application were used for automated and visible-process verification, as required by the browser-autopilot fallback.
