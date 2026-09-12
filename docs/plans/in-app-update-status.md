---
title: Private Browser verifies the latest cloud release in-app
source: conversation 2026-09-12
created: 2026-09-12
status: done
---

# Private Browser verifies the latest cloud release in-app

## Context

> add the page to my app and make it verify the last version o not

The supplied screenshot shows the existing Private Browser Settings surface, including the current “Private downloads” connection card and the installed version in the About card.

The approved public-download plan requires a public Cloudflare landing page backed by the active D1 release, a freshly signed R2 installer URL, private backward-compatible desktop update routes, checksum metadata, automatic release publication, responsive and accessible UI, full tests, direct Wrangler publication, and live verification.

## Steps

- [x] 1. Add a public read-only latest-release manifest without weakening existing private routes — done when: an unauthenticated GET or HEAD returns the active stable release with same-origin signed links while `/update.json` and `/api/v1/releases/latest` still reject unauthenticated callers — check: `npx vitest run --config cloudflare/vitest.config.ts`
- [x] 2. Make the desktop update service check the public feed by default and retain encrypted private configuration as an override — done when: an unconfigured app can compare its installed version, configured clients still send the bearer token only to the private route, background checks run without credentials, and signed-manifest validation remains fail-closed — check: `npx vitest run tests/update-service.test.ts tests/ipc-contract.test.ts`
- [x] 3. Add a dedicated in-app Updates page with automatic, manual, current, available, loading, and failure states — done when: Settings opens the page, the installed and latest versions are clearly compared, release details are visible, the verified download page is actionable, and the preview supports deterministic up-to-date and update-available states — check: `npx playwright test tests/e2e/updates.spec.ts`
- [x] 4. Document and log the shipped update-verification system — done when: BUILD_LOG, CHANGELOG and the owning release/UI system docs describe the public check, UI behavior, security boundary and operational flow — check: `npm run docs:check`

## Tail

- [x] T1. Adversarial review of the whole diff — done when: every finding is fixed or written to the Ledger with a reason — check: `git diff --check && git diff --stat`
- [x] T2. Similar-issue sweep — done when: sibling update routes, preload/IPC surfaces, background checks, preview handlers, signed links and mobile styles were searched for the same pattern — check: `manual: record the searches and findings in the Ledger`
- [x] T3. Full quality and security gates green — done when: dependency audit and the canonical repository check both exit 0 — check: `npm audit --audit-level=high && npm run check`
- [x] T4. Docs synced per the repo's rules — done when: the system docs, BUILD_LOG, CHANGELOG and this implementation ledger reflect the final behavior — check: `npm run docs:check && git diff --stat docs/ BUILD_LOG.md CHANGELOG.md`
- [x] T5. Committed path-scoped and pushed through the PR flow — done when: the feature PR is merged to main and the exact merged commit is available on origin — check: `git fetch origin && git branch --contains origin/main`
- [x] T6. Direct Cloudflare and desktop release verified — done when: the exact merged commit is deployed with pinned Wrangler and `--keep-vars`, Worker health and public manifest are live, CI publishes the newer desktop version, and the installed-app update journey is verified — check: `manual: record Worker version, live route evidence, CI release version/hash and app result in BUILD_LOG.md`
- [x] T7. Downstream claim recorded — done when: the build log names the live D1-to-public-feed-to-desktop comparison and its next-release verification deadline — check: `manual: record the claim and deadline in BUILD_LOG.md`

## Ledger

- 2026-09-12 19:55 — created from the user’s approved public-download plan and requested in-app version-verification follow-up.
- 2026-09-12 19:55 — the public manifest is additive rather than changing `/update.json`; this preserves installed-client authentication while allowing every copy to perform a read-only version comparison.
- 2026-09-12 20:34 — step 1 — Worker tests passed with 23 cases, including public GET/HEAD, signed same-origin links, missing releases, method rejection, and unchanged private-route concealment.
- 2026-09-12 20:36 — step 2 — desktop update and IPC tests passed with credential-free public checks, bearer-authenticated private overrides, explicit no-release errors, and the existing strict signed-link validator.
- 2026-09-12 20:45 — step 3 — three Playwright flows passed for current, available, loading and retryable-error states; console, page-error and failed-request monitors were clean. Desktop and 375px screenshots were inspected, the mobile CTA exceeded 240px, and the available-state preview was opened visibly in VS Code Integrated Browser at the same URL.
- 2026-09-12 20:49 — step 4 — CHANGELOG, BUILD_LOG and the release/UI owner docs now describe the public default, optional private override, page states and checksum boundary; the docs-system guard passed with zero failures and zero warnings after compacting the existing release gotchas below budget.
- 2026-09-12 20:52 — T1 — reviewed all Worker, Electron, renderer, preview, test and documentation hunks; no credential, redirect, origin, stale-link, HTML-injection or destructive-download regression remained, and `git diff --check` passed.
- 2026-09-12 20:52 — T2 — searched all `updates:*`, `UpdateServiceStatus`, manifest, background-poll, preview and checksum consumers. The sweep found stale IPC/browser-shell/status documentation and a resolved checksum follow-up; all were corrected, while preload and guarded IPC signatures required no code change.
- 2026-09-12 20:55 — T3 — `npm audit --audit-level=high` found zero vulnerabilities; `npm run check` passed 220 desktop, 7 protocol, 6 extension, 23 Worker, 10 browser and 4 real Electron tests, plus secret/docs/type/build/package/VSIX and Worker dry-deploy gates.
- 2026-09-12 20:55 — T4 — all four source-owning system docs, BUILD_LOG, CHANGELOG, the resolved follow-up and this ledger are synchronized; the documentation guard passed with zero failures and warnings.
- 2026-09-12 20:56 — T5 — PR #29 merged to `main` as `0f2626a1a9054e0f474183a3d382cdbb16279f8c`; the exact revision is present on `origin/main` and the feature worktree is clean.
- 2026-09-12 20:57 — T6 deviation — the first direct deploy was rejected before upload because the tracked Wrangler template deliberately contains a zero D1 placeholder. The repository renderer resolved the account's existing D1 identifier into the ignored deployment config; no production traffic changed during the failed attempt.
- 2026-09-12 21:01 — T6 — pinned Wrangler 4.131.1 with `--keep-vars` activated Worker `58dcb765-ed74-4d53-982d-e3ef729890d7`, tagged `git-0f2626a`. Run `34712446005` then passed Linux verification, real Windows Electron isolation, hardened packaging, R2/D1 publication and authenticated full/range/resume verification.
- 2026-09-12 21:03 — T6 — D1's public feed reports Private Browser `0.5.8` build 89 for the exact merge. A separate public signed-route download resumed from one MiB to 115,640,788 bytes and matched SHA-256 `a820b01e8de7fb62caee70efd04cd8ff0a8c20cc57618c25f4698cc4b164436f`; HEAD and a 1,024-byte range also matched. The current-user installer exited 0, Windows reports product version `0.5.8.0`, and the installed process remained responsive. Renderer verification proved the `0.5.7` → `0.5.8` available state and the installed `0.5.8` current state.
- 2026-09-12 21:03 — T7 — downstream probe due 2026-09-13: read the active D1 version/build/commit/size/hash tuple through `/api/v1/releases/public/latest`, require the same tuple from the signed R2 bytes, and require the desktop comparison to resolve older versions as `available` and `0.5.8` as `current`.
