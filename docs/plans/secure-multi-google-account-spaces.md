---
title: Secure multi-Google-account Account Spaces are production-ready
source: conversation 2026-09-12 and attached /goal request
created: 2026-09-12
status: in-progress
---

# Secure multi-Google-account Account Spaces are production-ready

## Context

> Implement secure, production-quality multi-Google-account integration in:
>
> Repository: https://github.com/digitronics2025/Private-Browser
>
> Operate end-to-end on autopilot. Inspect the repository and its instructions before changing anything. Decide routine technical details yourself. Preserve existing functionality and user data. Do not ask questions unless an unavoidable external credential or account decision blocks completion.
>
> Allow me to connect and use many Google accounts safely inside Private Browser.
>
> Do not replace the existing workspaces. Keep Digitronics, TenTen, Development, Personal, and Banking as security and purpose boundaries. Add a new dynamic “Account Space” layer inside each workspace. Each Google account must have its own cookies, storage, cache, tabs, bookmarks, history, permissions and Google API authorization. One Google account must never see or reuse another account’s cookies, tokens, history or private data.

The approved implementation plan additionally requires:

- Build Account Spaces as a dynamic container layer beneath the five existing workspaces, preserving Banking’s denials and Development’s controlled DevTools.
- Replace version-1 plaintext state with an atomic, idempotent migration to a minimal v2 manifest plus per-account browsing state. Preserve the original file, create a byte-for-byte backup, retain each legacy workspace partition exactly, and recover visibly rather than silently defaulting on unknown or corrupt data.
- Store one encrypted account record per opaque UUID using Electron `safeStorage`; quarantine individual corrupt records; keep OAuth short-lived secrets memory-only; never expose tokens or partition keys to the renderer.
- Use opaque persistent partitions for new accounts. Keep tabs in one account sharing a session while cookies, cache, storage, tabs, bookmarks, history, permissions, popups, favicons and downloads remain isolated from every other account.
- Perform Google desktop OAuth only in an allowlisted external Edge, Chrome, or Firefox executable using Authorization Code + PKCE S256, an exact loopback callback, state and nonce validation, ID-token validation, single-use state, cancellation and five-minute expiry. Never use an embedded view or a client secret.
- Request only identity scopes initially, then let users explicitly enable the documented Gmail, Drive, Calendar, Contacts and encrypted-backup modules. Re-consent to the complete selected scope set, compare actual scopes, and require exact single-use confirmations for mutations.
- Make Account Space and exact-origin permission decisions explicit, with once/session/always/deny choices. Banking denies before consulting grants; Meet media and display capture remain narrowly constrained.
- Keep Google website sessions, Google API connections, and encrypted Drive backup independent and honestly reported. Chrome Sync is unavailable and must not be advertised.
- Extend AI consent to account, tab, service and source revision. Google data is local by default; cloud AI remains sanitized and one-request approved; Banking remains denied.
- Replace the top-right shortcut with an accessible account switcher and full manager, while keeping the native page hidden under modal surfaces and restoring focus. Include add, switch, rename, recolour, reorder, lock, clear, disconnect, revoke/delete and service-launch controls.
- Provide authenticated AES-256-GCM backup envelopes and one-time verified recovery codes before enabling Drive app-data backup. Exclude secrets and sensitive browser content; use ETags and explicit conflict resolution; My Vault stays authoritative.
- Add schema-validated, sender-checked, global and per-channel rate-limited IPC with strict UUID, membership and payload validation and no generic Google-fetch surface.
- Add comprehensive unit, Electron integration, security and UI verification; update canonical system docs, README, SECURITY, CHANGELOG and Google setup guidance; run the repository gate and Windows packaging.
- Work in an isolated worktree on `feat/google-account-spaces`, review twice, commit conventionally, push, open a PR, wait for CI and CodeQL, merge green, and verify installer/checksum/SBOM/release publication. Do not claim live Google behavior without private configuration.

Verified repository facts before implementation:

- Workspaces are hard-coded and tabs are lazy `WebContentsView` instances.
- Sessions use one persistent partition per workspace, and previously opened views stay alive while switching.
- Browser state is schema v1 and unknown/corrupt data silently falls back to defaults.
- Only the active tab is restored at startup.
- The existing avatar controls are incomplete.
- Secrets use Electron `safeStorage`.
- Banking and Development have distinct security policies that must be retained.
- Chrome import, bookmark folders and bookmark-bar support do not exist in this checkout or its remote branches; this work exposes Account-Space-aware destination contracts without inventing those features.
- The baseline `npm run check` passes with one non-blocking documentation-staleness warning.

External boundary: no real OAuth credentials, tokens or private account data will be inspected, committed, logged or placed in screenshots. Without a configured desktop client ID, the production UI must clearly report that Google integration needs configuration while mocked and non-Google verification remains complete. Final live-Google verification may require the operator to configure Google Cloud externally.

## Steps

- [x] 1. Persist the implementation ledger and feature build log — done when: the complete approved scope, decisions, deviations, and system progress survive context compaction in tracked repository files — check: `node C:/Users/abuye/.agents/skills/implement-plan/scripts/plan-check.mjs docs/plans/secure-multi-google-account-spaces.md && Test-Path BUILD_LOG.md`
- [x] 2. Introduce Account Space domain types and validation — done when: opaque IDs, sanitized summaries, health/status/module/permission/recovery/result types, and Account-Space-aware browser records compile without exposing partition keys or secrets — check: `npm run typecheck`
- [x] 3. Implement encrypted per-account records and corruption recovery — done when: every account has an independently atomic safeStorage file, unreadable files are preserved/quarantined, and refresh tokens or identity metadata cannot enter plaintext state or renderer snapshots — check: `npm test -- --run tests/account-store.test.ts`
- [x] 4. Implement atomic idempotent v1-to-v2 migration and recovery mode — done when: real v1 fixtures preserve workspace/tab selection and legacy partitions, staged retries reuse UUIDs, originals and byte-identical backups remain, v2 publishes last, and unknown/corrupt state becomes read-only recovery instead of defaults — check: `npm test -- --run tests/state-migration.test.ts`
- [x] 5. Make runtime tabs and sessions Account-Space-aware — done when: only the active account is restored eagerly; same-account tabs share their partition; popups, navigation, favicons, downloads and moved/opened links retain the correct opaque account; cross-account data stays isolated — check: `npm test -- --run tests/account-isolation.test.ts`
- [x] 6. Implement lifecycle, lock, clear, disconnect, revoke and deletion semantics — done when: operations validate workspace membership, cancel account work, close views, clear memory, comprehensively erase only the selected session, verify erasure, and prevent deleting the sole account — check: `npm test -- --run tests/account-lifecycle.test.ts`
- [x] 7. Implement exact-origin Account Space permissions — done when: once/session/always/deny grants are keyed by account+origin+capability; Banking denies before grants; Meet media/display constraints and download prompts are enforced — check: `npm test -- --run tests/account-permissions.test.ts`
- [x] 8. Implement secure external-browser Google OAuth — done when: official Google auth tooling, allowlisted shell-free browser launch, fresh PKCE/state/nonce, exact loopback validation, verified ID claims, unique Google sub, timeout/cancellation/replay protection, encrypted refresh tokens and memory-only access tokens are covered by mocked tests — check: `npm test -- --run tests/google-oauth.test.ts`
- [x] 9. Implement narrow resilient Google service clients — done when: Gmail, Drive, Calendar and Contacts operations enforce the module scope matrix, bounded timed requests, cancellation, refresh coalescing, quota/revocation/offline states, safe-read backoff, and single-use mutation confirmations without persisting sensitive payloads — check: `npm test -- --run tests/google-services.test.ts`
- [ ] 10. Implement cryptographic backup primitives and Drive app-data boundary — done when: AES-256-GCM versioned envelopes, recovery-code verification, exclusions, tamper rejection, ETag conflict decisions and disabled-on-missing-key behavior pass tests, with Google receiving ciphertext only — check: `npm test -- --run tests/account-backup.test.ts`
- [ ] 11. Harden and extend typed IPC — done when: new lifecycle/OAuth/service/permission/progress channels use schema validation, trusted-main-frame sender checks, channel plus global rate limits, UUID/membership/body caps, cancellable operations, and no `any` callback or generic Google URL fetch — check: `npm test -- --run tests/ipc.test.ts tests/ipc-account-spaces.test.ts`
- [ ] 12. Extend AI consent and privacy logging — done when: AI capabilities bind account, tab, service and revision; Google data defaults local; cloud use keeps sanitized one-request approval; Banking and secret-content exclusions remain enforced — check: `npm test -- --run tests/ai-consent.test.ts tests/ai-account-spaces.test.ts`
- [ ] 13. Build the account switcher and manager experience — done when: the active account is obvious and keyboard accessible; users can switch/add/edit/reorder/manage/launch services; overlays hide native content and restore focus; connection states are honest; loading/empty/error/confirmation states work on desktop and mobile — check: `npm run typecheck && npm test -- --run tests/renderer-account-spaces.test.tsx`
- [ ] 14. Add development preview and Electron integration coverage — done when: a credential-free preview supports visible review and Electron automation proves partition, popup, storage and security behavior independently — check: `npm run test:electron`
- [ ] 15. Integrate comprehensive regression and CI/package gates — done when: Account Spaces, OAuth, permissions, service errors, backup and secret-absence tests join the single repository gate; Linux CI supports Electron tests and Windows produces the installer — check: `npm run check && npm run dist`
- [ ] 16. Merge Account Spaces documentation into canonical docs — done when: workspace/state, shell, IPC, renderer, security, AI, vault and release docs plus README/SECURITY/CHANGELOG explain architecture, limitations, setup, testing-mode expiry, recovery/rollback, disconnect/delete and Chrome Sync boundaries with one indexed canonical Account Spaces document — check: `npm run docs:check`
- [ ] 17. Verify the visible application through browser autopilot — done when: the development preview is visibly open in VS Code Integrated Browser and an independent automated browser run passes desktop/mobile switching, management, empty/error and confirmation journeys with no relevant console/network failures — check: `manual: record Integrated Browser visibility and automated-browser results separately`
- [ ] 18. Complete OAuth/account-isolation security review — done when: secret scans, OAuth callback/launch/storage review, account membership checks and same-pattern sweep find no unresolved vulnerability — check: `npm run secrets:check && npm audit --audit-level=high`
- [ ] 19. Deliver and verify the feature — done when: the branch is conventionally committed and pushed, PR and CI/CodeQL are green, main is merged, Windows installer/checksum/SBOM and Cloudflare release publication are verified, and any private Google configuration boundary is reported exactly — check: `manual: record branch, commit, PR, CI, release manifest and authenticated artifact evidence`

## Tail

- [ ] T1. Adversarial review of the whole diff — done when: every hunk is reviewed twice and every finding is fixed or written to the Ledger with a reason — check: `git diff origin/main...HEAD --check && git diff --stat origin/main...HEAD`
- [ ] T2. Similar-issue sweep — done when: sibling state stores, session construction, popup/download/favicon paths, IPC callbacks, secret/log surfaces and docs are searched for the same isolation patterns — check: `manual: record searched patterns and results in the Ledger`
- [ ] T3. Full repository gate and packaging green — done when: the canonical gate and Windows installer build both exit 0 — check: `npm run check && npm run dist`
- [ ] T4. Docs synced per repository rules — done when: canonical system docs, history, follow-ups, README, SECURITY, CHANGELOG and Account Spaces index all match code with a single verified date per system doc — check: `npm run docs:check && git diff --stat origin/main...HEAD -- docs/ README.md SECURITY.md CHANGELOG.md`
- [ ] T5. Committed path-scoped and pushed — done when: feature files are committed with the autopilot trailer, worktree is clean, and `origin/feat/google-account-spaces` matches HEAD — check: `git status --short && git rev-parse HEAD && git rev-parse origin/feat/google-account-spaces`
- [ ] T6. PR, CI, merge and production publication confirmed — done when: the PR and required checks are green, merge is on main, Windows artifacts and Cloudflare release manifest are verified, or a named external provider limitation is recorded — check: `manual: record PR/check/merge/release URLs and observed statuses in the Ledger`
- [ ] T7. A downstream claim is registered — done when: the claims register proves the published release manifest references the merged revision and its installer/checksum/SBOM, with a deadline, or the repo explicitly has no claims mechanism and the Ledger records the equivalent live probe — check: `manual: record the claim/probe and deadline in the Ledger`

## Ledger

- 2026-09-12 10:00 +01:00 — created from the approved conversation plan and attached `/goal` request.
- 2026-09-12 10:01 +01:00 — pre-flight — local main was clean but one commit behind origin/main; created the isolated feature worktree from fetched `origin/main` so the user’s main checkout remains untouched.
- 2026-09-12 10:02 +01:00 — scope decision — Chrome import, bookmark folders and bookmark-bar code are absent from this checkout and its remote branches; implement typed Account-Space-aware destination contracts and document compatibility, without recreating parallel absent features.
- 2026-09-12 10:03 +01:00 — external boundary — real Google credentials are not available or required for implementation; code and mocked verification will be complete, while live-Google claims remain conditional on private operator configuration.
- 2026-09-12 10:04 +01:00 — step 1 — created the feature-oriented build log and recorded the first active domain/persistence sub-step.
- 2026-09-12 11:11 +01:00 — step 2 — added opaque Account Space, Google module/health, permission, recovery, v2 browsing-state and sanitized summary contracts plus strict reusable validators; frontend and Electron typechecks and five targeted validation tests passed.
- 2026-09-12 11:11 +01:00 — environment — the isolated worktree initially lacked `node_modules`; ran lockfile-exact `npm ci` (0 vulnerabilities) and repeated the failed checks successfully.
- 2026-09-12 11:14 +01:00 — step 3 — implemented independently encrypted atomic records with strict record, partition, scope, permission and avatar validation; one corrupt file is byte-preserved and write-quarantined without affecting peers; Electron/frontend typechecks and five store tests passed.
- 2026-09-12 11:17 +01:00 — step 4 — implemented journaled, fingerprint-stable v1 migration with byte-identical backup, staged per-account publishing and v2 manifest-last commit; unknown/corrupt manifests enter browser recovery while one corrupt account is isolated; four migration tests and both type targets passed.
- 2026-09-12 11:30 +01:00 — step 5 — BrowserController now reads v2 runtime state, lazily creates only the active view, resolves partitions only from encrypted Account Space records, preserves the originating account for popups/bookmarks/history/downloads/favicons, and validates account switching; thirteen persistence/isolation tests and both type targets passed.
- 2026-09-12 11:36 +01:00 — step 6 — added local account creation, metadata updates, complete-set reorder, account-bound link opening, operational lock/unlock, API disconnect, account-only browsing-data clear, and exact-confirmation deletion; deletion closes views, cancels live work, clears unfiltered Chromium data, verifies cookies/cache twice, removes only selected state and blocks removal of a workspace’s sole account; nine lifecycle/isolation tests and both type targets passed.
- 2026-09-12 11:42 +01:00 — step 7 — introduced account+exact-origin+capability permission keys, one-use prompt IDs, memory-only once/session grants, encrypted always grants, Banking-first denial, narrow Gmail/Calendar/Meet notification policy, Meet-only media, disabled Maps location, prompted downloads, and an active-visible-main-frame display source picker every time; six permission tests and both type targets passed.
- 2026-09-12 11:51 +01:00 — step 8 — added official `google-auth-library` 11.0.2, encrypted/env Desktop client-ID configuration without client secrets, explicit discovered Edge/Chrome/Firefox launch with argument arrays and `shell:false`, PKCE S256, random state/nonce/path/port, 127.0.0.1 exact callback validation and close-before-exchange, Google signature/issuer/audience/expiry/nonce/email/sub checks, complete-scope comparison, unique-sub enforcement, cancellation/timeout/replay guards, encrypted refresh tokens, memory-only access tokens and revocation-pending behavior; nine OAuth tests and both type targets passed.
- 2026-09-12 11:57 +01:00 — step 9 — implemented coalesced memory-only token refresh, module/scope enforcement, bounded streaming response parsing, cancellation and ten-second timeouts, Retry-After plus jittered exponential retry for safe reads, and fixed Gmail metadata/search/send, Drive list/create/upload/share, Calendar read/write/Meet, and Contacts operations; Gmail/Calendar/Drive mutations use payload/account/service/source-revision-bound single-use confirmations; seven service tests and both type targets passed.
