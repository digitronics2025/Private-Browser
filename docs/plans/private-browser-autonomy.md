# PLAN — Private Browser: safe autonomy upgrade

Status: ready for execution after the approval gates below.
Risk tier: **T3 — critical** (permission and security model change, logged-in sessions, file access).
Owner use: personal, non-commercial, single user.

---

## 1. Goal

Let the AI agent (Claude Code, via the Private Browser MCP server) do more browser work on its own,
with fewer refusals and prompts, **without** raising the risk to the owner's logged-in accounts,
files or settings.

Target outcome in one line: *the agent can act freely on the open web in a logged-out space, act on
the owner's own apps in a logged-in space, run long sessions without timeouts, and never raise its
own permissions.*

## 2. Current behaviour (evidence from a live test on 2026-11-21)

Observed through the Private Browser MCP tools, with no settings changed:

| Item | Observed value |
|---|---|
| Client | `Claude Code` |
| Profile | `develop` |
| Allowed origins | `[]` (empty) |
| Outside-allowed mode | `"outside": "observe"` |
| Limits | `actionsPerMinute: 90`, `tabs: 4`, `idleMs: 600000` (10 min), session expiry ≈ 48 min after the test |
| Spaces | one: `Agent Account Space` |
| Read tools on example.com | worked: `tab_open`, `snapshot`, `get_text`, `screenshot` (masked JPEG), `console_messages`, `network_requests`, `tab_close`, `tabs_list` |
| `click` on example.com | refused: `This client can only read pages at this origin.` |
| `emulate` (375×812 mobile) on example.com | refused with the same message, although it changes nothing on the page |
| `snapshot` | returns no page title and no heading role for that page |

MCP tool surface seen: `accessibility_audit, browser_status, check, click, console_messages,
dev_servers, downloads_list, drag, emulate, evaluate (read-only, development origins only), get_text,
go_back, go_forward, handle_dialog, hover, navigate, network_requests, performance_snapshot,
press_key, record_start, record_stop, reload, screenshot, scroll, select_option, snapshot, tab_close,
tab_open, tab_select, tabs_list, type, upload_file, wait_for`.

## 3. Agreed decisions (from the conversation)

1. **Two-space trust model** instead of adding sites one by one:
   - **Open Web space**: never holds logins; agent may act on **all** `http(s)` origins.
   - **Work space**: owner signs in once by hand; agent may act only on an explicit allow list
     (owner's own apps and `localhost`).
2. **Higher limits** (owner-configurable, with hard caps): session 8–12 h or owner-renewed, idle
   30–60 min, 8–10 tabs, ~120 actions/min.
3. **Files**: uploads only from one owner-chosen folder; downloads stay in a per-space sandbox.
4. **Non-mutating "view" actions** (scroll, hover, emulate, wait) allowed on read-only origins.
5. **Claude Code allow list** for `mcp__private-browser__*` so routine browser calls do not prompt.
6. **Scheduled runs** (optional, last) for recurring read-mostly checks.
7. Keep on: screenshot masking, console/network redaction, downloads sandbox, rate limit, action log.

## 4. Non-negotiable invariants

These must hold after every phase. A test must prove each one (see §10).

- **I1 — No self-escalation.** No MCP tool can create, edit or widen a space, origin list, limit,
  file root or trust level. Policy changes happen only in the owner's local settings UI or config
  file, never through the MCP channel.
- **I2 — Space isolation.** Cookies, storage, cache, service workers, downloads and history never
  cross between spaces.
- **I3 — Logged-out Open Web.** The Open Web space has no saved credentials and cannot import
  cookies. If a login is detected there (password field submitted by the owner, or an auth cookie
  set on a Work-space origin), the UI warns the owner and offers to clear the space.
- **I4 — Decision per action, at action time.** The origin check runs against the **current**
  frame's origin when the action executes (after redirects, in iframes, in popups), not the origin
  the tab was opened with.
- **I5 — Fail closed.** Unknown tool, unknown origin form, policy load error or expired session →
  refuse with a clear message.
- **I6 — Privacy kept.** Masking and redaction stay on and are not configurable from MCP.
- **I7 — Owner presence for renewal.** Session renewal past the configured maximum needs an
  action in the owner UI.

## 5. Scope

**In scope**
- Per-space policy model and decision engine.
- Action classes (read / view / interact / files / diagnostic).
- Configurable limits with hard caps; owner-renewed sessions.
- Upload root folder and per-space download quotas.
- Settings UI for spaces, origins, limits and the action log (**design gate first**).
- `browser_status` reporting the new policy so the agent can plan.
- Claude Code allow-list entry (through the owner's config-repository process).
- Optional scheduled read-mostly runs.

**Out of scope**
- Entering passwords, payments, trades, CAPTCHAs, security-setting changes. These stay with the
  owner by the agent's own platform rules; no browser setting changes that.
- Any new cloud service, sync or remote storage.
- Turning off masking, redaction or the rate limit.

## 6. Assumptions to verify in Phase 0

Each must be confirmed or corrected **before** design work. If one is false, adjust the plan in the
phase notes and continue; stop only if it blocks the goal (see §11).

| # | Assumption | How to verify |
|---|---|---|
| A1 | The owner has the Private Browser source code and can change it (it is not a closed third-party app). | Find the repository on disk; read its README/licence. If it is third-party, run only the configuration-only track (§8, Phase 0 decision). |
| A2 | The browser runs locally (desktop app or extension + local MCP bridge); no Cloudflare or other cloud component. | Read architecture docs, package manifests, `wrangler.*` files, network calls. |
| A3 | Policy lives in a local config/store that the MCP server reads, separate from the MCP request path. | Trace where `allowedOrigins`, `outside`, `limits`, `spaces` come from. |
| A4 | `outside` currently supports only `observe` (maybe more values). | Read the enum/type definition. |
| A5 | Spaces already isolate browser storage (separate profiles/partitions). | Read the space creation code; run the isolation test (T-ISO). |
| A6 | `emulate` is grouped with click/type in the permission check. | Find the permission map; confirm why it was refused. |
| A7 | The owner's `%USERPROFILE%\.claude` is the managed configuration repository described in its `AGENTS.md` (templates, render script, manifest, guard CI). | Read `AGENTS.md`, `docs/agent-contract.md`, `.claude/settings.json` there. |
| A8 | An action log exists. | Search for audit/log modules. |

## 7. Architecture

### 7.1 Policy model (per space)

```ts
type ActionClass = "read" | "view" | "interact" | "files" | "diagnostic";

interface SpacePolicy {
  id: string;                 // uuid, existing space id kept
  name: string;               // "Open Web", "Work"
  credentials: "forbidden" | "owner-managed";
  origins:
    | { mode: "allowlist"; list: CanonicalOrigin[] }
    | { mode: "all-web" };     // http/https only; never file:, chrome:, data:, blob: top-level
  outside: "observe" | "view"; // what is allowed on origins outside `origins`
  classes: Record<ActionClass, boolean>;
  uploadRoot?: string;         // absolute, canonical; required for "files"
  downloadQuotaMb: number;
}

interface ClientLimits {        // hard caps enforced in code, defaults shown
  actionsPerMinute: number;     // default 120, cap 240
  tabs: number;                 // default 8,   cap 12
  idleMs: number;               // default 30 min, cap 60 min
  sessionMs: number;            // default 8 h, cap 12 h; renewal needs owner UI (I7)
}
```

Defaults shipped:
- **Open Web**: `credentials: forbidden`, `origins: all-web`, classes read/view/interact on,
  files on (downloads only unless `uploadRoot` set), diagnostic off.
- **Work**: `credentials: owner-managed`, `origins: allowlist` (empty until owner adds),
  `outside: view`, classes read/view/interact on, files off until `uploadRoot` set, diagnostic
  only on loopback origins.
- Existing `Agent Account Space` is migrated to **Work** semantics with its current (empty) list,
  so nothing widens until the owner acts.

### 7.2 Action classes (map every tool)

| Class | Tools |
|---|---|
| read | `browser_status, tabs_list, snapshot, get_text, screenshot, console_messages, network_requests, performance_snapshot, accessibility_audit, downloads_list, dev_servers` |
| view | `scroll, hover, emulate, wait_for, tab_select, record_start, record_stop` |
| interact | `navigate, tab_open, tab_close, go_back, go_forward, reload, click, type, check, select_option, drag, press_key, handle_dialog` |
| files | `upload_file` (+ any download trigger) |
| diagnostic | `evaluate` (read-only expressions, loopback/dev origins only) |

Notes:
- `tab_open`/`navigate` to an origin outside policy is allowed **as navigation** only if the space
  is `all-web` or the target is allowed; otherwise open in observe mode (current behaviour).
- `reload` and `emulate` are view-safe but `reload` re-sends requests; keep it in interact.
- New tools added later must be classified; unclassified tools are refused (I5).

### 7.3 Decision engine

One pure function, no I/O, fully unit-tested:

```ts
decide(policy: SpacePolicy, tool: string, frameOrigin: string, now: number, session: SessionState)
  -> { allow: true } | { allow: false; code: RefusalCode; message: string }
```

- Origin canonicalisation: lowercase scheme+host, IDNA/punycode, default ports removed, no path,
  no userinfo. Exact match only; subdomains need their own entry, or an explicit
  `*.example.com` entry which matches subdomains but **not** the apex and not `evilexample.com`.
- Refusal messages keep today's wording style and add a code, e.g.
  `ORIGIN_READ_ONLY: This client can only read pages at this origin.` so the agent can explain.
- `browser_status` gains: per-space `origins.mode`, `outside`, enabled `classes`, `uploadRoot`
  present (yes/no, never the path if the owner marks it private), session expiry and renewal state.

### 7.4 Files

- Upload: resolve `realpath` of the requested file; it must stay inside `uploadRoot` after symlink
  and junction resolution; reject `..`, UNC paths, alternate data streams (`file.txt:stream`),
  device names (`CON`, `NUL`). Size cap (default 25 MB). Read-only access.
- Download: per-space sandbox folder, quota (default 500 MB), oldest-first cleanup, filenames
  sanitised, no auto-open, no execution.

### 7.5 Action log

- Local append-only log per space: time, tool, class, origin (no query string), decision, refusal
  code. No page text, no typed values, no screenshots.
- Rotation: 10 MB × 5 files. Viewer in the settings UI.

### 7.6 Claude Code allow list

- Add `mcp__private-browser__*` (or the explicit tool list if wildcards are not supported by the
  installed Claude Code version — verify) to the **allow** permissions.
- Location and process follow the owner's config repository contract (A7): isolated branch or
  worktree, edit the correct source (template or `.claude/settings.json` as that repo defines),
  run its render/check gates, PR, CI. That contract says distribution must not broaden permissions
  silently → **Gate G2** (§9).

### 7.7 Scheduled runs (optional, Phase 7)

- Use Claude Code's local scheduled tasks; each job runs in the **Open Web** space unless it needs a
  Work app.
- Jobs are read/view only by default. Any job that would click/submit on a Work app lists the exact
  steps in its definition and is approved once by the owner when created.
- Output: a local summary file plus an in-app notification. Sending to Messenger or any external
  channel needs explicit owner authorisation per channel (owner policy: external messages need
  explicit authorisation; Messenger output uses the `report-cards` skill).

## 8. Implementation phases

Each phase ends with its checks green before the next starts. Commit per phase with clear messages,
following the project's own branch rules found in Phase 0.

### Phase 0 — Discover and baseline (read-only)
1. Locate the Private Browser repository on disk (likely under the owner's home folder; ask the
   owner for the path if not found within a short search — this is a blocker for code phases only).
2. Read `README.md`, `AGENTS.md`, `CLAUDE.md`, `docs/agent-contract.md`, `docs/agent-memory/MEMORY.md`
   (only relevant notes), architecture docs, licence.
3. Map: MCP server entry, tool registry, permission check, policy storage, space/profile creation,
   rate limiter, session expiry, masking/redaction, downloads sandbox, settings UI, tests, CI.
4. Verify assumptions A1–A8; write results into a `## Phase 0 findings` section appended to this plan.
5. Run the existing test suite once; record pass/fail as baseline.
6. Re-run the 7-step manual test from §2 and save the outputs as baseline evidence.
7. **Decision:** if A1 is false (no source access), switch to the **configuration-only track**:
   apply §3 items 1–3 and 5–7 only through the product's existing settings, skip Phases 2–5 code
   work, and record unsupported items under `Remaining issues`.

### Phase 1 — Design and threat model
1. Write `docs/permissions-model.md`: policy model (§7.1), action classes (§7.2), decision rules,
   invariants (§4), migration of existing space.
2. Threat model table: prompt injection from pages, open redirect to non-allowed origin, iframe on
   allowed page embedding a hostile origin, popup/`window.open`, `javascript:`/`data:` URLs,
   look-alike domains (IDN homographs), DNS rebinding to loopback, cookie leakage between spaces,
   path traversal in uploads, zip/download bombs, rate-limit bypass via many tabs, session renewal
   abuse, MCP calls that try to edit policy.
3. **UI mockups** (high fidelity, desktop 1440×900 and mobile 375×812) of: Spaces list, Space
   editor (trust level, origins, classes, upload folder, quota), Limits screen, Session renewal
   prompt, Action log viewer, Login-in-Open-Web warning. Inspect the existing settings UI first and
   match its style, components, fonts and colours. Include empty, error and dark-mode states and
   keyboard/screen-reader notes.
4. **STOP at Gate G1** (§9). No UI code before explicit approval.

### Phase 2 — Policy engine (no UI)
1. Implement `SpacePolicy`, `ClientLimits` types and a versioned schema with migration from the
   current format (keep the existing space id; empty allow list; nothing widened).
2. Implement `decide()` and origin canonicalisation; replace the existing check at the single
   chokepoint where every MCP tool call passes. If more than one chokepoint exists, consolidate.
3. Classify every tool (§7.2); unclassified → refuse.
4. Evaluate at action time against the current frame origin (I4).
5. Make policy read-only from the MCP process (I1): load from owner store; no write path reachable
   from tool handlers. Add a test that greps/inspects the tool registry for policy-writing calls.
6. Extend `browser_status` output (§7.3).

### Phase 3 — Limits and sessions
1. Configurable limits with hard caps in code.
2. Session renewal flow: on expiry, refuse with `SESSION_EXPIRED`; renewal only from the owner UI.
3. Rate limiter counts per client across all tabs (no bypass by opening tabs).

### Phase 4 — Files
1. Upload root enforcement (§7.4) with Windows-specific checks.
2. Download quota, cleanup, sanitising.

### Phase 5 — Settings UI (only after Gate G1 approval)
1. Build exactly the approved design.
2. Spaces editor, origins editor with live canonicalised preview and warnings for broad patterns,
   limits, upload folder picker, action log viewer, Open-Web login warning.
3. Accessibility: labels, focus order, contrast ≥ 4.5:1, keyboard operable, reduced motion.

### Phase 6 — Claude Code allow list
1. Prepare the change in the owner's config repository per its contract (A7).
2. **STOP at Gate G2** for the permission broadening, then merge per that repo's rules.

### Phase 7 — Scheduled runs (optional)
1. Provide two example jobs, disabled by default: "daily public price check" (Open Web,
   read/view only) and "morning site health check" of the owner's apps (Work, read only).
2. Each enabled job needs owner approval at creation (Gate G3).

### Phase 8 — Full verification and release
Run §10 in full. Release per the project's own rules found in Phase 0. If no release machinery
exists, produce a local build and install steps for the owner.

## 9. Approval gates (the only planned stops)

| Gate | When | What the owner approves |
|---|---|---|
| G1 | End of Phase 1 | Mockups (desktop + mobile), permissions model, threat model |
| G2 | Phase 6 | Adding the Private Browser tools to the Claude Code allow list |
| G3 | Phase 7, per job | Each scheduled job's steps, space and output channel |
| G4 | Anytime | Any irreversible step not listed here, any paid service, or anything that widens the Work space beyond origins the owner typed |

The owner adds Work-space origins and signs in to Work apps by hand. The agent never types passwords.

## 10. Tests and verification

### Unit (decision engine) — target ≥ 95 % branch coverage of `decide()` and canonicaliser
- Exact origin match; port differences; `http` vs `https`; trailing dot host; uppercase host.
- IDN: `xn--` and Unicode forms match each other; homograph look-alikes do not match.
- Wildcard `*.example.com` matches `a.example.com`, not `example.com`, not `evilexample.com`.
- Non-web schemes (`file:`, `chrome:`, `data:`, `blob:`, `javascript:`) refused for interact.
- Each tool → expected class; unknown tool refused.
- Expired session refused; limits capped even if config asks for more.

### Integration (real browser, local test pages served on loopback)
- **T-ISO** Space isolation: cookie set in Work is absent in Open Web and vice versa.
- **T-REDIR** Allowed page redirects to a non-allowed origin → click after redirect refused (Work).
- **T-IFRAME** Click inside a cross-origin iframe on an allowed page → decided by the iframe origin.
- **T-POPUP** `window.open` to non-allowed origin → popup is observe-only.
- **T-REBIND** Host resolving to 127.0.0.1 is not treated as `localhost` unless listed.
- **T-UPLOAD** Traversal, symlink/junction escape, ADS, device names, oversize → refused.
- **T-DL** Quota enforced; cleanup works; no auto-open.
- **T-RATE** Many tabs cannot exceed the per-client rate.
- **T-NOESC** Every MCP tool called with policy-changing payloads → no policy change (I1).
- **T-LOG** Action log has no typed values, query strings or page text.

### End-to-end (rerun the original 7-step test in both spaces)
- Open Web: click "Learn more" on example.com → allowed; mobile emulate → narrow layout visible.
- Work with empty list: same steps → click refused, emulate **allowed** (view class).
- Work with an allowed loopback test app: full form fill, mobile view, recorded Playwright test.

### UI checks (Phase 5)
- Desktop 1440×900 and mobile 375×812, light and dark, keyboard-only pass, automated a11y audit
  with zero serious/critical issues. Visual evidence (screenshots) reported separately from
  automated results.

### Regression
- Full existing suite green; masking/redaction tests unchanged and green.

## 11. Failure recovery

| Situation | Action |
|---|---|
| Repo not found | Search common folders once; then ask owner for the path (blocks code phases only; config-only track can proceed). |
| Assumption false (A2–A6, A8) | Adapt the design in Phase 0 findings; continue. |
| Existing tests fail at baseline | Record them; do not fix unrelated failures unless they block; never weaken tests. |
| Policy migration error | Fail closed (I5) with the old policy file kept as `*.bak`; migration is idempotent and re-runnable. |
| A security test fails | Fix before moving on; no phase may end with a failing invariant test. |
| Browser engine API missing a needed hook (e.g. frame origin at click time) | Fall back to the stricter rule (refuse) and record it under Remaining issues. |
| Rollback | Revert the phase's commits; policy schema keeps a down-migration to the previous format. |

## 12. Cost and resource safeguards

Assumed fully local (A2). **No new Cloudflare Workers, D1, R2, KV or paid APIs are introduced.**
If Phase 0 finds an existing cloud component:
- Do not add per-action writes to D1/KV; the action log stays local.
- No screenshot or download upload to R2.
- Any new remote call needs Gate G4.

Local resource limits:
- Tab cap and per-client rate limit (§7.1).
- Screenshot retention: none on disk beyond the MCP response unless the owner enables it; if
  enabled, 200 MB cap with oldest-first cleanup.
- Download quota per space; log rotation (§7.5).
- Idle tabs closed after `idleMs`; memory per space reported in `browser_status` if available.
- Scheduled jobs: at most one concurrent run, minimum interval 1 h, auto-disable after 3 failures.

## 13. Files to inspect or modify (paths verified in Phase 0 — names below are placeholders)

Inspect first:
- `README.md`, `AGENTS.md`, `CLAUDE.md`, `docs/agent-contract.md`, architecture docs.
- MCP server entry and tool registry.
- Permission/origin check module; policy/config loader and schema.
- Space/profile creation; session and rate limiter; downloads sandbox; masking/redaction.
- Settings UI components and styles.
- Test folders and CI config.
- Owner config repo: `%USERPROFILE%\.claude\AGENTS.md`, `docs/agent-contract.md`,
  `.claude/settings.json`, `templates/*`, `manifest/instruction-registry.json`.

Expected to add or change:
- `docs/permissions-model.md` (new), threat model section.
- Policy types/schema + migration; `decide()` module + tests.
- Tool classification map; `browser_status` output.
- Limits/session module; files module; action log module.
- Settings UI screens (after G1).
- Claude Code allow-list entry (after G2).
- Optional scheduled job definitions (after G3).

## 14. Success criteria (measurable)

1. Open Web space: click, type and mobile emulate succeed on any public `https` site in the E2E test.
2. Work space: actions on listed origins succeed; on unlisted origins, read and view succeed and
   interact is refused with a coded message.
3. All invariant tests (I1–I7) pass; zero policy changes possible through MCP.
4. A 4-hour unattended read/view task completes without a session or idle timeout.
5. Zero permission prompts in Claude Code for Private Browser tools after G2.
6. Settings UI matches the approved mockups; a11y audit shows zero serious/critical issues.
7. Existing test suite and masking/redaction tests remain green.
8. No new cloud resources or recurring costs.

## 15. Completion report

Finish with the owner's required implementation report format: **Result**, **Changes**,
**Verification**, **Remaining issues**, **Grandma summary**, **What you need to do** — including the
Phase 0 findings, gate decisions, and any items the config-only track could not deliver.

## Phase 0 findings

Baseline revision: `4ba2286d2ee91d58dfbe5080e40efb485ca857fd` on `origin/main`.
Discovery and tests used the isolated `codex/private-browser-autonomy-design`
worktree. The existing Agent Mode stability worktree contains overlapping
uncommitted changes and was preserved. The source implementation track applies.

| Assumption | Verified result and decision |
| --- | --- |
| A1 | First-party Private-Browser repository found locally. The package is private and `UNLICENSED`. Use the source track. |
| A2 | Agent MCP is local stdio over an encrypted named pipe on Windows, with enforcement in Electron main. The project separately has a Cloudflare installer/download service. Leave that service outside the autonomy change. |
| A3 | `electron/agent-host.ts` loads OS-encrypted client policy via `electron/agent-audit.ts`. Origins, profile and outside mode are per client. Spaces have stable IDs and names. Transport limits are fixed in `packages/bridge-protocol/src/agent.ts`. |
| A4 | Current outside modes are `observe` and `deny`. Keep the existing Block behavior through migration. |
| A5 | `electron/agent-workspace.ts` uses a separate Chromium partition per Agent space ID. A real two-space Agent MCP fixture verified independent cookies in both directions. The shipping Open Web/Work isolation tests remain open. |
| A6 | `emulate` is outside the host's read set and requires drive access. The disposable default client reproduced the refusal. |
| A7 | The managed configuration repo has the stated contract, templates and registry. Tracked permissions live in `.claude/settings.json`. Claude Code 2.1.330 is installed, and its public docs describe the server-scoped wildcard. Effective matching against the configured alias remains a Gate G2 check. |
| A8 | The host writes time, tool, origin and decision to an encrypted local 200-row audit. The Agents panel provides a viewer and native export. Extend that path with per-space rotation. |

**Tests.** `npm run check` exited 0. All 518 Vitest tests and 78 Chromium
preview tests passed. Windows Electron reported 67 passed and 2 configured
skips (the hosted Windows clipboard test and the isolated Notes Worker test).
Both Agent Mode Electron tests passed. The build, VSIX verification and Worker
dry run passed. The docs guard reported 13 existing freshness warnings and
zero failures.

**MCP baseline.** The installed connector asked the owner to turn on Agent
Mode. Its live journey could not run. The same tool sequence ran against a
disposable local app and Claude Code MCP identity. It reported `develop`,
zero origins, `observe`, 90 actions/minute, four tabs, 10 minutes idle and a
fresh 60-minute lease. The public tab opened and snapshot returned a
link reference, with no title or heading. Text retrieval returned normally
but the expected heading text was absent. Click and 375 × 812 emulation
returned the current read-only message. Masked JPEG output, console and
network tools, and closing and listing tabs succeeded. In the disposable
isolation fixture, the second space initially returned no cookie, then kept
its own test cookie without replacing the first space's value. Exact safe
outputs are saved with the repository copy of the plan.

**Design decisions carried to Gate G1.** Preserve existing policy ceilings
on migration and require explicit Work loopback grants. Give unlisted Work
pages a separate signed-out preview. Enable broad Open Web only once the
public-network boundary is proven on the supported application build.
Retain popup denial and current consequential action approvals. These are
proposals for owner review at G1. Login detection is limited to observable
sign-in signals.

### Execution checklist

- [x] Phase 0. Locate source, map controls, check assumptions, run the baseline
  and record live connector status and disposable verification.
- [x] Phase 1. Write the permissions model and threat model, inspect the
  current Agents panel, and prepare static desktop and mobile mockups for review.
- [x] Gate G1. Record the owner's explicit approval of the review package.
- [x] Phases 2–5. Implement the policy engine, limits, file controls and approved
  settings. Verify I1–I7 and the listed unit, integration, browser and
  accessibility checks.
- [x] Phase 6 preparation. Prepare the isolated config change and run its local checks.
- [ ] Gate G2. Obtain explicit approval, verify the Claude Code alias and behavior,
  and follow config CI.
- [ ] Optional Phase 7. Keep example jobs disabled. Obtain Gate G3 for any
  enabled job and Gate G4 where applicable.
- [ ] Phase 8. Run T3 verification, including real Windows journeys and a
  four-hour unattended session. Release the exact approved revision under
  the repository's SHA-bound installer approval and verify the active build.

## Execution record

Gate G1 was approved by the owner in response to the explicit design-review
request. Phases 2–5 were implemented in the isolated autonomy worktree.

- Existing Work space IDs and partitions survive migration. The encrypted
  backup retains the original grants. An owner must renew migrated leases
  and choose an upload folder for the intended space.
- Paired clients need explicit space assignments. Work unlisted pages use a
  signed-out preview. Embedded-frame actions are refused by the top-frame
  driver, and popups remain blocked.
- Open Web verifies proxy routing before first use and blocks private
  destinations, manual control and native sign-in features. The owner can
  review and clear a possible sign-in in trusted browser chrome.
- Limits, owner renewal, upload and download controls, encrypted per-space
  action logs and the reviewed settings screens are wired through trusted IPC.

### Verification before G2

- The full local `npm run check` run passed with 558 unit tests, 83 Chromium
  preview tests, and 69 Windows Electron tests. Two pre-existing configured
  Windows tests skipped. Final credential and proxy shutdown changes were
  covered by a refreshed Electron compile, the four Agent Mode tests and
  the disposable public-site and renewal journey. The final UI checks added
  the warning dialog in both themes and sizes, with 10 Agent UI tests passed.
- The decision engine and origin module reached 100% measured branch
  coverage. The Windows suite verified masking/redaction, cookie isolation,
  redirects, embedded-frame and popup denial, private-network blocking,
  reconnect rate limits and the existing loan and recording flows. Quota
  and upload path checks passed.
- A disposable Claude Code MCP identity verified public click, typing without
  submitting, mobile emulation, a synthetic sign-in warning and clear, a
  coded expiry refusal, owner renewal, and Stop followed by Resume.
- Browser UI screenshots are visual evidence. Axe checks at 1440 × 900 and
  375 × 812 in light and dark found zero serious or critical violations in
  the reviewed Agent screens.

### Gate G2 and release

The config candidate adds `mcp__private-browser__*` to the tracked project
settings in a separate worktree. Config policy tests and render checks passed.
Activation, publishing and live prompt verification await owner approval at
G2. The shipping revision still requires Phase 8 verification, including the
four-hour unattended run, applicable CI and the SHA-bound installer approval.

### Upstream integration before release

The local runtime revision is `6fefb5d`. During implementation, `main`
advanced to `b90b7cc`. A merge preview found nine conflicting files. The
overlap includes PR #112, which added automatic lease renewal and a 24-hour
mode, plus the option to remember an exact-site approval. The approved
autonomy design specifies a 12-hour hard cap and owner-only renewal.
An owner decision is pending on that behavior conflict before integration.
The proposed resolution is to keep the G1 lease rules and preserve remembered
approvals for exact, already-listed Work origins. Run verification against
the integrated release candidate.

### Integration decision

Gate G2 and the merge approach were approved. The Claude Code rule merged in
`claude-config` PR #71. The browser merge preserves remembered navigation
only for exact, already-listed Work origins. Older one-hour and eight-hour
preferences migrate to their original durations. The former open setting maps
to the 12-hour cap. All migrated clients require an owner renewal before use.

Execute the entire plan end-to-end in full autopilot. Make independent decisions, always choosing the best long-term solutions for security, reliability, scalability, and maintainability.

Investigate, implement, fix, test, and verify everything autonomously. Do not pause for routine questions. Seek approval only for unavoidable blockers, irreversible high-risk actions, or significant costs. Continue until fully verified, then provide a concise completion report.
