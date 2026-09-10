# Private Browser — repo instructions

Electron + React desktop browser (`electron/`, `src/`) plus a Cloudflare Worker
that serves private releases (`cloudflare/`). Windows-first; `npm run dist`
builds the NSIS installer.

## The gate

`npm run check` is the single gate — docs guard, both typechecks, both test
suites, the Vite/Electron build and a Worker dry-run deploy. CI runs exactly
this. Run it before claiming a change works.

Two vitest suites with separate configs: `tests/` (root config — covers
`electron/`, `cloudflare/src/` and the docs guard) and `cloudflare/tests/`.
`npm run test` runs both; bare `vitest` runs only the first.

## Trust boundary

[SECURITY.md](SECURITY.md) is a contract, not a description. Every loaded site
is hostile: no Node and no preload in remote views, one typed preload bridge for
the trusted chrome, per-workspace session partitions, `safeStorage` for the
vault and update config, AI extraction refused in Banking. Read it before
changing `electron/security.ts`, `electron/vault.ts`, `electron/preload.cts`, or
anything that widens what a remote page can reach.

## Per-System Documentation (READ FIRST)

Each major subsystem has a doc at `docs/systems/{system}.md` — the canonical,
code-verified map. Index: [docs/systems/README.md](docs/systems/README.md).

- **Before** subsystem work or questions: read that doc. Start with its Agent
  Brief; follow the routing table to the one section you need.
  `node scripts/docs-find.mjs "<query>"` finds a section without opening the file.
- **After** modifying a subsystem: **merge** the change into the section that
  already covers it and bump the single `Last verified:` date. Never append a
  dated block; never add a second stamp.
- Change stories go to `docs/history/`. Work deliberately not done goes to
  [docs/follow-ups.md](docs/follow-ups.md), in the same change.
- `node scripts/docs-guard.mjs` enforces the budgets and runs inside
  `npm run check`. A tracked hook at `.githooks/pre-commit` warns when a
  subsystem's code is staged without its doc — enable it once per clone with
  `git config core.hooksPath .githooks`. The `scripts/docs-*.mjs` files are
  vendored — do not hand-edit them; re-vendor with `/docs-systems adopt`.
