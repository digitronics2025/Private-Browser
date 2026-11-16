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

### MyVault credential workflow

**Secrets an agent creates go into MyVault first** — every AI, every repository.
Read `secret-custody` and the [agent guide](https://myvault.digitronics-electro.workers.dev/downloads/myvault-agent-guide.txt).
New values use the checksum-verified `vault-deposit` CLI (`MYVAULT_DEPOSIT`) or
the deposit connector; confirm the vault save before a destination write.
Queued/deposited is not collected/saved. Never decode the deposit configuration
or expose a value in chat, output, files or Git. Without a usable channel, the
owner saves privately.

For saved fields, prefer authorized MyVault GitHub/Cloudflare profile tools:
discover scope, preview, obtain required owner approval or a valid existing
policy, apply the unchanged preview, then verify names and activation.
`myvault.config.json` holds identifiers, not authority. Check actual tool access
and live scope; new repos/destinations need owner authorization. Delegated targets
are repository Actions secrets and existing Worker runtime text secrets; Pages,
build/environment/organization secrets and core-key rotation are unsupported.
Core keys use the separate signed owner workflow. Never bypass missing consent,
custody, scope or refusals; continue independent work and report the blocker.

### End every plan with the exact autopilot paragraphs

Every plan, including revised or shortened plans, MUST end with these two
paragraphs verbatim. Before presenting any plan, check its final two paragraphs
against this text. Do not shorten, paraphrase, indent, or add text after them.

<!-- prettier-ignore-start -->

Execute the entire plan end-to-end in full autopilot. Make independent decisions, always choosing the best long-term solutions for security, reliability, scalability, and maintainability.

Investigate, implement, fix, test, and verify everything autonomously. Do not pause for routine questions. Seek approval only for unavoidable blockers, irreversible high-risk actions, or significant costs. Continue until fully verified, then provide a concise completion report.

<!-- prettier-ignore-end -->

This ending describes authorized execution; it does not start implementation,
exit Plan mode, create a durable goal, change platform permissions, waive required
approvals, or override safety rules. Stay in Plan mode until the host permits
execution. Once implementation is authorized, proceed within the approved scope
without repeated routine confirmations. Required review and quality gates still apply.

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

## Simple language

Use simple words in answers, plans, updates, questions and reports. Assume no
coding knowledge. Lead with results. Use short sentences; explain jargon.
If unclear, rephrase. For user actions, number steps: one action, exact verified
button/text, expected result. Handle the rest. Keep commands exact.

## Reply contract — every task-closing reply

For every completed task, including investigations, small fixes, documentation
and settings changes, you MUST use the five-part form followed by the last two
labels below. Use these exact bold labels in this order:

1. **What I changed**
2. **What was going wrong**
3. **Before → After**
4. **What this gets you**
5. **Still open**
6. **Grandma summary**
7. **What you need to do**

Use simple language; aim for 180 words. State checks and limits. Say when nothing
changed. Unverified stays unverified. Put user actions only in the last section:
numbered steps with exact verified labels and expected results, or exactly
`Nothing — you're all set.` Report unfinished work under **Still open**.

Before sending, check all seven labels, their order, and the truth of completion
claims. "Short" means shorter sections, not missing labels. Explicit "skip recap"
omits the first six, but required user actions remain. Direct answers and plans
without completed work need no report; simple language still applies.

Prefer **maintainable > scalable > secure > production-ready > sustainable**.
Never report unverified work as done: checked, not verified, or could not check.
Update the doc owning a behaviour in the same commit. Never commit a secret.
Only this repo's tracked files and account-level skills reach a session off the
operator's PC — never point at `~/.claude/...` or `C:\Users\...` unmarked.

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
<!-- END operator-conventions sha256:eca25aa55952 -->
