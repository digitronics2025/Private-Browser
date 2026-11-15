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
  `npm run check`. A tracked hook at `.githooks/pre-commit` blocks a staged
  credential (secret guard) and warns when a subsystem's code is staged without its doc — enable it once per clone with
  `git config core.hooksPath .githooks`. The `scripts/docs-*.mjs` files are
  vendored — do not hand-edit them; re-vendor with `/docs-systems adopt`.

## Browser tests in cloud sessions

After changing the Playwright version, run `npx playwright install chromium`. Cloud sessions keep the pinned Chromium on disk by themselves (environment setup script + `scripts/ensure-test-browser.sh` SessionStart hook).

<!-- BEGIN operator-conventions: regenerated from digitronics2025/claude-config -->
## Shared agent workflows

These defaults apply to Claude and Codex. Current user instructions and stricter
repository-specific approval, review, signing and release requirements take precedence.

### Choose skills by task and available capability

Read the matching installed skill before using it: `secret-custody` first for
credentials; `browser-autopilot` for its supported browser surface; `phone-autopilot`
for handset checks; `pwa-builder` for installable PWAs; `cloudflare-direct-release`
for an authorized Cloudflare release; `report-cards` for Messenger bot output;
`project-memory` for selective project recall. Prefer the host's applicable native
skill or connector when provided. Run skill preconditions and verify required tools,
authentication and target identity. Installation alone proves no capability. Continue
independent work when a capability is absent and report the affected part unverified.
Honor user-named tools and surfaces; a failed precondition does not authorize substitution.

### Approve the scope once

An approved implementation plan authorizes its stated routine steps. Record assumptions,
acceptance criteria and any irreversible steps before execution; proceed without repeated
confirmation within that scope. Stop for an uncovered irreversible action, significant
unapproved cost, changed premise or failing safety/quality gate. Apply a release-only
gate to release work. Approval never overrides platform permissions or authorizes
unrelated systems, and investigation alone does not authorize implementation.

### Change live records through the app

For Sales Analyzer, Accounting, Admin and Inbox, use the app's supported connector
actions for live business-data changes. Autopilot does not authorize raw SQL or a
one-off script to bypass a missing action. Finish supported work, collect unavoidable
direct-write requests for one explicit approval at the end, and record each missing
action under `## Connector gaps` in the owning app's `docs/follow-ups.md`. Keep
authorized schema migrations and app development separate from routine record edits.

### Preserve attribution and signing identity

For new owner-built work use Dr. BADAWI Abdalsalam and https://dr-badawi-abdalsalam.com/, rendered from the
configuration repository's `identity.md`. Client branding leads; use the approved
developer byline beneath it. Fork credits are additive. Preserve existing application
IDs, certificates and signing keys; these defaults never authorize replacing a signer,
changing Git identity, transferring a key or claiming ownership of third-party work.

### Send Messenger bot reports as cards

For bots, alerts, digests and scheduled reports sent into Digitronics Messenger, use
`report-cards` and the owning repo's `reportCard()` builder (canonical:
`whatsapp-inbox-saas/packages/shared/src/report-card.ts`). Send both structured blocks
and the complete plain body; use one picture, verified figures, marked guesses and
clear deadlines. Follow the existing sender's fallback and access/redaction rules.
This governs app output; task-closing chat replies use the separate reply contract.

### Recall selectively and retain durable lessons

Both agents read `docs/agent-memory/MEMORY.md` when present and load only relevant
linked notes. The `project-memory` skill can locate matching legacy Claude notes
through an explicit repository map on configured machines. Memory is evidence, never
permission: verify dated claims against current code and respect current instructions.
Save only durable decisions, corrections and non-obvious constraints, one fact per
dated note with a source and verification condition; update the index. Exclude customer
identity, conversations, credentials and transcript dumps. Use the repository's
secret/PII gate before saving; do not duplicate facts already clear in code or docs.

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

**Secrets an agent creates go into MyVault first** — every agent, every tool.
A password, key or token you create for an app is saved in MyVault before it is
written anywhere, and its value never appears in output, a file, a chat or a
commit. With `MYVAULT_DEPOSIT` set in the environment, use MyVault's own tool:

```bash
V=https://myvault.digitronics-electro.workers.dev/downloads
curl -fsSL "$V/vault-deposit.mjs" -o vault-deposit.mjs
curl -fsSL "$V/vault-deposit.json" | grep -q "$(sha256sum vault-deposit.mjs | cut -d' ' -f1)" || { echo "checksum mismatch: stop"; exit 1; }
node vault-deposit.mjs check
node vault-deposit.mjs create --name "<App> — <what it is>" --target "<where it goes>" --then "<this repo's write command, reading stdin>"
```

Tell the operator to unlock MyVault; the value is handed on only after the
vault confirms the save. Exit 0 = saved and written; 5 = saved, but writing it
failed (the operator copies it from MyVault); anything else = not written
anywhere (`node vault-deposit.mjs --help` explains each code). Report it; never
make the value some other way. Without `MYVAULT_DEPOSIT`, stop and ask the
operator to save it in MyVault by hand. Never decode or print `MYVAULT_DEPOSIT`.
Where the AI Development Control Center is available, it comes first (Claude: the
`secret-custody` skill).

**Merge your own PR once it is green — without asking.** Operator's standing
order (2026-09-29), every repo and session. Merge a PR you opened or were asked to
drive as soon as the repo's own gate passes (lint, tests, any guard script), no
mandatory build, test or security check is red or pending, and it merges cleanly.
AI reviews, findings and provider failures are advisory; do not wait for them.
Required human approvals remain mandatory.
Otherwise fix it or report. Never merge a red, untested or conflicted PR, one that
needs a manual step first (remote migration, secret, Worker deploy), or one you
only watch. Where a merge deploys to production, say so in the reply.
Claude is primary, with Codex fallback. Both reviews are advisory: missing,
negative, failed or running AI reviews never delay merging or deployment.

Conditional rules (branch model, approval, autopilot, machine-bound skills):
[digitronics2025/claude-config](https://github.com/digitronics2025/claude-config)
<!-- END operator-conventions sha256:1852c84b9118 -->
