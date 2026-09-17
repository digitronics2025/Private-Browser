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

<!-- BEGIN operator-conventions: regenerated from digitronics2025/claude-config -->
## Reply contract — every task-closing reply

End every task-closing reply with these three, in order, nothing after:

1. **Plain recap**, 3 sentences, no paths/hashes/jargon ("saved" not "commit",
   "sent live" not "deploy"); shipped work may use the five-part form
   (changed / was wrong / before→after / gain / next), ~180 words.
2. **Grandma summary**, 2-4 plain sentences, no tool, file or product names —
   what it means for the shop. Unverified stays unverified.
3. **What you need to do** — numbered steps naming the exact button and what
   they should see, or exactly `Nothing — you're all set.` Never empty, never
   "just". Anything the user must do goes ONLY here.

"skip recap" silences 1 and 2; 3 stays. Not for technical answers, code, plans or
commit messages.

Prefer **maintainable > scalable > secure > production-ready > sustainable**.
Never report unverified work as done: checked, not verified, or could not check.
Update the doc owning a behaviour in the same commit. Never commit a secret.
Only this repo's tracked files and account-level skills reach a session off the
operator's PC — never point at `~/.claude/...` or `C:\Users\...` unmarked.

Conditional rules (branch model, approval, autopilot, machine-bound skills):
[digitronics2025/claude-config](https://github.com/digitronics2025/claude-config)
<!-- END operator-conventions sha256:a49a9e0add0d -->
