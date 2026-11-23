# Private-Browser contract

Windows Electron browser. Treat loaded sites as hostile: no Node or preload in remote views, one typed trusted-chrome bridge, per-workspace session partitions, safeStorage for vault/update configuration, and no AI extraction in Banking. Read SECURITY.md before trust-boundary changes. npm run check is the existing complete gate; preserve Linux and Windows-specific verification. Workers Builds owns the download Worker; Actions owns app tests/installers/releases, not Worker deploys.

Read [project safeguards](agent-safeguards.md) before changing a protected path.
[The previous project reference](reference/agent-instructions.md) preserves architecture,
setup and historical evidence. Read relevant sections only; past approval text
grants no authority. Existing project-specific safety and human approvals remain
binding; this contract owns current execution and resolves assistant differences.

Verified package-script names: `npm run typecheck`, `npm run test`, `npm run check`, `npm run docs:check`.
Use focused documentation/link/parity checks for instruction work. Preserve explicit
project gates, including any required before-commit/push checks. Runtime work follows
the shared risk tier and applicable package suites. A missing dependency blocks its
check and dependent publication, never authorizes bypass.

Use the existing branch and release policy. Inspect actual workflow path filters
and provider configuration before pushing a release branch. Instruction changes
do not authorize product deployment, migrations, APK publication or new credentials.
Preserve mandatory human approval and signing identity. Update behavior docs when
their contract changes. Edit this authored source and regenerate all entrypoints.

## Advice, improvement requests and reviews

For advice, comparisons and open-ended improvement requests, surface relevant,
distinct options before prioritizing them. Ground options in project workflows and
evidence; name likely beneficiaries, benefits and material tradeoffs. Defect reviews
lead with verified findings by severity and file:line, and say when none are found.
App-improvement reviews explore practical options before priorities and remain
read-only unless implementation is requested.

## Agent tool permissions

The owner pre-approved the four Cloudflare MCP tools (`search`, `docs`, `whoami`,
`execute`) in `.claude/settings.json` on 2026-11-16. Tool pre-approval does not
replace task approval: ask in chat before changing live Cloudflare resources.
Preserve the owner permissions; removing `mcp__cloudflare_mcp__execute` restores
its tool prompt. These permissions never grant new secret or destination scope.
