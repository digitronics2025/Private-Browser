---
title: Private Browser verifies the latest cloud release in-app
source: conversation 2026-09-12
created: 2026-09-12
status: in-progress
---

# Private Browser verifies the latest cloud release in-app

## Context

> add the page to my app and make it verify the last version o not

The supplied screenshot shows the existing Private Browser Settings surface, including the current “Private downloads” connection card and the installed version in the About card.

The approved public-download plan requires a public Cloudflare landing page backed by the active D1 release, a freshly signed R2 installer URL, private backward-compatible desktop update routes, checksum metadata, automatic release publication, responsive and accessible UI, full tests, direct Wrangler publication, and live verification.

## Steps

- [ ] 1. Add a public read-only latest-release manifest without weakening existing private routes — done when: an unauthenticated GET or HEAD returns the active stable release with same-origin signed links while `/update.json` and `/api/v1/releases/latest` still reject unauthenticated callers — check: `npx vitest run --config cloudflare/vitest.config.ts`
- [ ] 2. Make the desktop update service check the public feed by default and retain encrypted private configuration as an override — done when: an unconfigured app can compare its installed version, configured clients still send the bearer token only to the private route, background checks run without credentials, and signed-manifest validation remains fail-closed — check: `npx vitest run tests/update-service.test.ts tests/ipc-contract.test.ts`
- [ ] 3. Add a dedicated in-app Updates page with automatic, manual, current, available, loading, and failure states — done when: Settings opens the page, the installed and latest versions are clearly compared, release details are visible, the verified download page is actionable, and the preview supports deterministic up-to-date and update-available states — check: `npx playwright test tests/e2e/updates.spec.ts`
- [ ] 4. Document and log the shipped update-verification system — done when: BUILD_LOG, CHANGELOG and the owning release/UI system docs describe the public check, UI behavior, security boundary and operational flow — check: `npm run docs:check`

## Tail

- [ ] T1. Adversarial review of the whole diff — done when: every finding is fixed or written to the Ledger with a reason — check: `git diff --check && git diff --stat`
- [ ] T2. Similar-issue sweep — done when: sibling update routes, preload/IPC surfaces, background checks, preview handlers, signed links and mobile styles were searched for the same pattern — check: `manual: record the searches and findings in the Ledger`
- [ ] T3. Full quality and security gates green — done when: dependency audit and the canonical repository check both exit 0 — check: `npm audit --audit-level=high && npm run check`
- [ ] T4. Docs synced per the repo's rules — done when: the system docs, BUILD_LOG, CHANGELOG and this implementation ledger reflect the final behavior — check: `npm run docs:check && git diff --stat docs/ BUILD_LOG.md CHANGELOG.md`
- [ ] T5. Committed path-scoped and pushed through the PR flow — done when: the feature PR is merged to main and the exact merged commit is available on origin — check: `git fetch origin && git branch --contains origin/main`
- [ ] T6. Direct Cloudflare and desktop release verified — done when: the exact merged commit is deployed with pinned Wrangler and `--keep-vars`, Worker health and public manifest are live, CI publishes the newer desktop version, and the installed-app update journey is verified — check: `manual: record Worker version, live route evidence, CI release version/hash and app result in BUILD_LOG.md`
- [ ] T7. Downstream claim recorded — done when: the build log names the live D1-to-public-feed-to-desktop comparison and its next-release verification deadline — check: `manual: record the claim and deadline in BUILD_LOG.md`

## Ledger

- 2026-09-12 19:55 — created from the user’s approved public-download plan and requested in-app version-verification follow-up.
- 2026-09-12 19:55 — the public manifest is additive rather than changing `/update.json`; this preserves installed-client authentication while allowing every copy to perform a read-only version comparison.
