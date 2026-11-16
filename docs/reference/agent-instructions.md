# Previous project instructions

Historical architecture and operating evidence, preserved at c6c2071bfb4c73f52c7cd55ab7c1b90001c04971.
Current process and authorization are exclusively in [the authored contract](../agent-contract.md).
Past approvals are not permission. Verify dated facts against current code.
Read relevant sections only; paths below have been rebased for this reference.

## Previous AGENTS.md project material

# Private-Browser — agent contract

## Deploys — READ FIRST
- The download-service Worker (`private-browser-downloads`, code in `cloudflare/`) is deployed by
  **Cloudflare Workers Builds** on every push to `main` (runs `npm test`, D1 migrations, then
  `wrangler deploy --keep-vars`). Check the build passed in the Cloudflare dashboard and that the
  download service answers.
- GitHub Actions is still ON here, but ONLY for tests, the Windows installer and publishing releases
  (R2 upload + D1 release metadata). Do not add Worker deploy steps back to Actions.
- If a change adds a D1 migration that release publishing needs, push the `cloudflare/` change first
  and wait for its Cloudflare build before pushing app changes.
- Manual fallback deploy: `deploy-cloudflare.yml` (workflow_dispatch). Rollback: `npx wrangler rollback`.
- Cloud sessions: never run `wrangler deploy`; push to `main` instead.
- Never print or commit secret values. Secrets live in Cloudflare / GitHub secrets.

Rules specific to this repo go above the managed block below.

## Browser tests in cloud sessions

After changing the Playwright version, run `npx playwright install chromium`. Cloud sessions keep the pinned Chromium on disk by themselves (environment setup script + `scripts/ensure-test-browser.sh` SessionStart hook).

## Previous CLAUDE.md project material

# Private Browser — repo instructions

## Deploys — READ FIRST
- The download-service Worker (`private-browser-downloads`, code in `cloudflare/`) is deployed by
  **Cloudflare Workers Builds** on every push to `main` (runs `npm test`, D1 migrations, then
  `wrangler deploy --keep-vars`). Check the build passed in the Cloudflare dashboard and that the
  download service answers.
- GitHub Actions is still ON here, but ONLY for tests, the Windows installer and publishing releases
  (R2 upload + D1 release metadata). Do not add Worker deploy steps back to Actions.
- If a change adds a D1 migration that release publishing needs, push the `cloudflare/` change first
  and wait for its Cloudflare build before pushing app changes.
- Manual fallback deploy: `deploy-cloudflare.yml` (workflow_dispatch). Rollback: `npx wrangler rollback`.
- Cloud sessions: never run `wrangler deploy`; push to `main` instead.
- Never print or commit secret values. Secrets live in Cloudflare / GitHub secrets.

Electron + React desktop browser (`electron/`, `src/`) plus a Cloudflare Worker
that serves private releases (`cloudflare/`). Windows-first; `npm run dist`
builds the NSIS installer.

## The gate

`npm run check` is the single gate — secret guard, docs guard, three
typechecks (app, Worker, release scripts), four vitest runs, VSIX package and
validation, the Vite/Electron build, Playwright e2e, the Electron suite and a
Worker dry-run deploy. Run it before claiming a change works. CI's `verify`
job (Linux) runs it, where the Electron suite and the Windows-only e2e specs
skip; the `windows-installer` job then runs those on Windows before building.

Vitest runs: `tests/` (root config — covers `electron/`, `cloudflare/src/`,
the release workflow and the docs guard), the bridge protocol, the VS Code
extension, and `cloudflare/tests/`. `npm run test` runs all four; bare
`vitest` runs only the first.

## Trust boundary

[SECURITY.md](../../SECURITY.md) is a contract, not a description. Every loaded site
is hostile: no Node and no preload in remote views, one typed preload bridge for
the trusted chrome, per-workspace session partitions, `safeStorage` for the
vault and update config, AI extraction refused in Banking. Read it before
changing `electron/security.ts`, `electron/vault.ts`, `electron/preload.cts`, or
anything that widens what a remote page can reach.

## Per-System Documentation (READ FIRST)

Each major subsystem has a doc at `docs/systems/{system}.md` — the canonical,
code-verified map. Index: [docs/systems/README.md](../systems/README.md).

- **Before** subsystem work or questions: read that doc. Start with its Agent
  Brief; follow the routing table to the one section you need.
  `node scripts/docs-find.mjs "<query>"` finds a section without opening the file.
- **After** modifying a subsystem: **merge** the change into the section that
  already covers it and bump the single `Last verified:` date. Never append a
  dated block; never add a second stamp.
- Change stories go to `docs/history/`. Work deliberately not done goes to
  [docs/follow-ups.md](../follow-ups.md), in the same change.
- `node scripts/docs-guard.mjs` enforces the budgets and runs inside
  `npm run check`. A tracked hook at `.githooks/pre-commit` blocks a staged
  credential (secret guard) and warns when a subsystem's code is staged without its doc — enable it once per clone with
  `git config core.hooksPath .githooks`. The `scripts/docs-*.mjs` files are
  vendored — do not hand-edit them; re-vendor with `/docs-systems adopt`.

## Browser tests in cloud sessions

After changing the Playwright version, run `npx playwright install chromium`. Cloud sessions keep the pinned Chromium on disk by themselves (environment setup script + `scripts/ensure-test-browser.sh` SessionStart hook).

