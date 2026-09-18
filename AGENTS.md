# Private-Browser — agent contract

Rules specific to this repo go above the managed block below.

<!-- BEGIN operator-conventions: regenerated from digitronics2025/claude-config -->
## Efficient execution — local and cloud

Use the smallest verification tier that proves the request:

- **T0 — read-only:** questions, investigation, and plans. Do not mutate files,
  Git, external systems, or deployments unless the request requires it.
- **T0D — documentation-only:** review the changed material and run only a
  focused link or formatting check when one exists. Do not run product tests,
  open a browser, or deploy.
- **T1 — isolated low-risk change:** run focused tests plus lint and type-check
  for the affected package or files. For UI work, verify the changed route at
  its primary viewport.
- **T2 — cross-cutting change:** shared code, public behavior, multiple routes,
  integrations, caching, or background work. Run relevant unit and integration
  suites, affected browser journeys, and CI before release.
- **T3 — critical change:** authentication, authorization, billing, money,
  personal data, migrations, security controls, infrastructure, release
  machinery, or destructive behavior. Run the full applicable gate, CI,
  deployment verification, and live proof of the changed behavior.

Escalate one tier when scope is uncertain, a focused check exposes wider impact,
or verification fails. Do not begin routine production work at T3 by default.

Run each check once. Local work owns focused checks, CI owns the complete suite,
and release verification owns provider status, health, and live behavior. Do not
repeat a successful check unless relevant inputs changed. When CI is unavailable,
run the complete applicable suite locally once for T2/T3 before release.

Default to the smallest complete change. Do not redesign unrelated pages, sweep
sibling systems, add infrastructure, or perform broad cleanup without evidence
that the same requirement affects them. Preserve unrelated working-tree changes.

Use browser automation only for changed or investigated browser behavior. T1 UI
work needs the affected route and primary viewport; T2 needs the affected desktop
and mobile journey; reserve a complete accessibility, console, and network pass
for T3 or an explicit audit. Backend-only, documentation, database, and
configuration work does not need a browser unless runtime evidence requires it.

Read subsystem documentation when it materially shortens discovery. Update it
only when documented behavior, architecture, interfaces, operations, or important
gotchas change. Read `BUILD_LOG.md` only when explicitly continuing its multi-stage
build; ordinary questions and maintenance do not trigger automatic continuation.

Commit, push, migrate, and release according to the repository-specific policy
above this block. For authorized runtime work, release once at the end after the
applicable gate passes. Documentation and developer-only changes do not trigger a
production release unless they change the deployed artifact. Build and release the
exact committed revision, then verify the changed behavior. Never claim cloud or
local verification that the current environment could not perform.

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
<!-- END operator-conventions sha256:a1a6250801da -->
