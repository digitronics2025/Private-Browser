# System Documentation Index

A code-verified map of every major subsystem in this repo. Each file documents one
subsystem's data model, public interface, consumers, helpers, behaviours and
gotchas — in enough detail that an agent or a new engineer can answer questions
or make changes without re-reading every related source file.

## How to use this

**Reading.** Before answering questions about or modifying any subsystem, read
its file below. Large docs open with an **Agent Brief** — read that, follow its
routing table to the one section you need, and stop. To find a section without
opening the file:

```sh
node scripts/docs-find.mjs "<query>"              # search the system docs
node scripts/docs-find.mjs "<query>" --history    # include archived change notes
node scripts/docs-find.mjs --full <doc>#<section> # print one section
```

**Writing.** After modifying a subsystem, **merge** the change into the section
that already covers it, and bump the single `Last verified:` date at the top.

- **Never append a new dated `### 2026-08-21 — Feature X` block.** That is the
  habit that grows a doc past the point anyone can afford to read it. The guard
  fails on it.
- **Never add a second `Last verified:` stamp.** One per doc, at the top.
- The story of *why* a change happened belongs in [../history/](../history/).
  These docs describe how the system works **now**.
- Work you deliberately did **not** do belongs in
  [../follow-ups.md](../follow-ups.md) — add it in the same change, or it is a
  follow-up nobody will read.

**Budgets** are enforced by `scripts/docs-guard.mjs`, reading each doc's own YAML
frontmatter. A doc over ~40 KB (~10k tokens) is too expensive to read whole, so
it must carry an Agent Brief and should be merged down or split into a map +
children. `byte_allowance` is a ratchet: lower it after each win, never raise it.

```sh
node scripts/docs-guard.mjs                 # full check
node scripts/docs-guard.mjs stale           # what has drifted from the code
node scripts/docs-guard.mjs ratchet --write # tighten allowances that gained slack
```

## Index

**The desktop app — main process**

- [browser-shell.md](browser-shell.md) — windows, tabs and `WebContentsView`
  lifecycle, navigation, layout, shortcuts, downloads, tracker blocking, the
  privacy log, and how every IPC channel is wired up.
- [ipc-contract.md](ipc-contract.md) — the complete channel surface between the
  two halves of the app, and every shared payload type.
- [workspaces-and-state.md](workspaces-and-state.md) — the five policy workspaces,
  their Account Spaces, and versioned on-disk state that survives a restart.
- [google-account-spaces.md](google-account-spaces.md) — dynamic per-account
  containers, encrypted records, migration/recovery, Google OAuth and APIs,
  exact-origin permissions, session isolation and encrypted Drive backup.
- [chrome-import.md](chrome-import.md) — local Chrome profile discovery,
  Account-Space-aware bookmark/history migration, and secure password-CSV parsing.

**The desktop app — security-critical**

- [security-boundary.md](security-boundary.md) — the pure predicates that decide
  what a page may do: URL allow-listing, secret redaction, banking-page
  detection, and the SSRF guards on outbound endpoints.
- [vault.md](vault.md) — OS-encrypted credentials, TOTP codes, same-domain
  autofill and clipboard clearing.
- [ai-consent.md](ai-consent.md) — local page extraction, redaction, the
  single-use approval token, and the cloud provider it is spent on.
- [vscode-bridge.md](vscode-bridge.md) — authenticated local pairing, workspace
  and command grants, project adapters, isolated tests, reports, and guarded AI edits.

**The desktop app — renderer**

- [renderer-ui.md](renderer-ui.md) — the React chrome: workspace rail, tab bar,
  dashboard and the six sidebar panels, plus the layout handshake with the main
  process.

**Shipping**

- [release-and-updates.md](release-and-updates.md) — the whole path from a commit
  to an installed update: the Cloudflare Worker, its data and signed download
  links, the two workflows, and the desktop client that polls it.

## Audits

- [../security/prerelease-audit-2026-09-10.md](../security/prerelease-audit-2026-09-10.md)
  — pre-release audit of `63e5ee8` (v0.3.1): 26 numbered, line-cited findings with
  a must-fix table and an order of work. Read it before the next release.

## Creating a new doc

Follow the template the skill ships (`/docs-systems bootstrap`, or copy an
existing doc's shape). Every doc needs frontmatter — `system`, `sources`,
`verified_at` — or the guard, the staleness check and the pre-commit hook are all
blind to it.

### Naming

- Filenames: `kebab-case.md`.
- One file per coherent subsystem; closely related siblings can share one.
- `sources:` is a **strict partition** — every path in the repo is claimed by at
  most one doc. It is a notification routing table, not a bibliography: it
  answers "if this path changes, which single doc most likely needs editing?"
  Listing the same file in two docs makes the pre-commit hook warn twice for
  every change, and a hook that always fires is a hook that gets ignored.
