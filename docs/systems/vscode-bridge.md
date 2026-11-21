---
system: vscode-bridge
sources:
  - electron/vscode-bridge.ts
  - packages/bridge-protocol/**
  - vscode-extension/**
verified_at: dcd6823a
---

# VS Code Bridge

> Last verified: 2026-11-21

## Agent Brief

**Scope.** This subsystem connects Private Browser 0.4.0 to the private
`digitronics.private-browser-bridge` VS Code extension. It owns the typed wire
protocol, local transport, device pairing, project and command authorization,
project adapters, isolated browser testing, local reports, and the editor-side
AI handoff and patch gate.

**Boundary.** The browser's main process is the only bridge server. Remote page
renderers have no preload, IPC, socket, or Chrome debugging port. The trusted
chrome renderer can call a narrow set of guarded Electron IPC methods; the VS
Code extension separately re-checks Workspace Trust, the selected root, paths,
commands, live origins, and edits.

### Invariants

1. Only the per-launch random Windows named pipe is accepted; there is no TCP
   fallback. Unix-domain sockets are supported outside Windows for development.
2. A project is unusable until VS Code Workspace Trust and the per-folder modal
   grant both pass.
3. Paths are canonicalized through `realpath`; traversal, UNC paths, symlink
   escapes, secrets, and browser profiles fail closed. The secret-name rule is
   applied to both the typed and the resolved path, after stripping Windows
   stream suffixes and trailing dots/spaces.
4. Commands come only from detected immutable specifications. VS Code displays
   the exact executable, arguments, and working directory and remembers only
   that specification's SHA-256 fingerprint (for a Playwright run: runner, kind,
   project and target URL).
5. Test browser contexts begin empty. Cookies, storage, headers, and browser
   profiles are never imported.
6. AI context is a visible, five-minute, single-use capability. Structural DOM
   and compressed screenshots are opt-in; protected content and sensitive
   browser data are always excluded.
7. Reports live only in extension global storage, default to 30 days and 100
   items, and are never placed in VS Code sync state.

## Protocol and Transport

`packages/bridge-protocol` is the single protocol source for both processes.
Protocol v1 validates request, response, event, report, project, command, hello,
welcome, and encrypted-frame envelopes with Zod. Frames use a four-byte
big-endian length prefix and are capped at 256 KiB. Artifacts are capped at 10
MiB and captured task output at 1 MiB.

Electron writes an owner-local rendezvous document to
`%LOCALAPPDATA%\Private Browser Bridge\rendezvous.json`. It contains the random
pipe name, per-launch challenge, browser public identity, version, and expiry;
it contains no private key or session key. Browser identity material is sealed
with Electron `safeStorage`. The extension identity and remembered browser key
use VS Code `SecretStorage`, so they are OS protected and not settings-sync data.

Pairing uses an eight-digit single-use code valid for five minutes and permits
five attempts. Both peers sign the transcript with Ed25519 identities. Each
connection contributes an ephemeral X25519 key, derives AES-256-GCM material
with HKDF-SHA256, and binds ciphertext to session ID and monotonically
increasing sequence. Replays, reordered messages, invalid signatures, identity
changes, expired sessions, and incompatible schemas close the connection. The
extension emits a ten-second heartbeat and reconnects/rekeys when the 15-minute
session expires.

Signed transcripts use `stableStringify`, which skips `undefined` fields exactly
as JSON does, so a hello signed with no pairing code verifies after crossing the
pipe; the extension also omits the field and never auto-reconnects mid-pairing.
A failed handshake on another socket never replaces a live session's status.

Ordinary calls time out after 30 seconds, calls that wait on a VS Code modal or
language model after 5 minutes, test calls after 15 minutes. A response to a call
the browser already gave up on is dropped, not treated as a replay. Only one VS
Code window holds the session: a live session (heartbeat within 25 s) is replaced
only by the same window (its per-window `instanceId`) or by pairing; another
window is refused quietly and retries once a minute. The extension opens frames
in order but handles requests concurrently, spends a sequence number only once a
frame is built (an oversized answer becomes an error response), sends dev-server
progress at most once a second, and drops a reply whose session was replaced.
The browser accepts no extension-initiated privileged browser request. Incoming
traffic is limited to 120 messages per minute, and the extension permits at most
five command starts per minute.

The [Agent Mode](agent-mode.md) channel shares the frame codec, cryptographic
primitives and file containment checks. Its rendezvous, wire schema, pairing
records and approvals are separate from VS Code. The only project data shared
into Agent Mode is the authorized project's loopback server URL.

## Project and Command Authorization

The Project panel can read the branch, commit and worktree totals for the
approved workspace root from VS Code’s built-in Git provider. It uses the
provider’s current state and never runs a Git command or reads a diff. GitHub
links open only on request. Local test summaries record the revision at report
start. Bridge 0.4.1 adds this read-only action without changing earlier report
or project formats.

`adapters.ts` detects npm, pnpm, yarn, bun, or Gradle from lockfiles and trusted
project files. It composes Vite/React, Node, Electron, PWA, Cloudflare Worker,
WordPress/WooCommerce, and Android traits rather than choosing only one. Android
uses `gradlew.bat`/`gradlew` before any global Gradle and gives installation
guidance when required tools or Playwright are absent.

The browser sees multi-root folders as bounded summaries. Selecting a folder
opens a modal in VS Code. Restricted or virtual workspaces cannot inspect files,
run commands, test pages, or apply edits. The extension recalculates command
fingerprints from package scripts and adapter metadata; a changed configuration
therefore invalidates a remembered command approval. Commands use argument
arrays with `shell: false`, sanitized bounded output, and whole-process-tree
cancellation on Windows. A `.cmd`/`.bat` (npm, pnpm, yarn, `gradlew.bat`,
`wrangler.cmd`) cannot be spawned without a shell since Node's CVE-2024-27980
fix, so `spawn-command.ts` resolves it to a full path and runs it through
`System32cmd.exe /d /s /c` with every part quoted — refusing any part containing
`% ! ^ & | < > "`. `ai.handoff` requires Workspace Trust and the folder grant
like every other project action; `ai.apply-edits` hashes the editor buffer,
refuses unsaved files and re-checks after the review.

## Inspect and Test

Chromium DevTools remain available only on non-protected Development pages.
Element selection uses Electron's main-process `webContents.debugger` CDP
session without exposing a remote-debugging socket. When native DevTools already
owns the debugger, the same bounded evaluation runs through the main process.
Selectors contain only IDs, tag names, and a few classes. The inspector groups
request failures by sanitized URL, method, type and outcome for the current tab.
Each group shows its count and first and last occurrence. Source opening requires
companion 0.4.4, the selected project's running local server and a confirmed
workspace file for a direct HTML route or explicit asset reference. The companion
rechecks the short-lived file reference and project grant on open. Other elements
show the available source confidence and keep opening disabled.

Quick Test and Test Everything execute approved project checks. Current Page,
Responsive, Accessibility, Performance, Record Flow, Live Website, and
Local-vs-Live invoke the bundled Playwright runner from VS Code. Each run creates
fresh browser contexts for desktop, tablet, and 375px mobile as applicable. It
captures bounded screenshots/diffs and console, request, axe, and navigation
evidence. Playwright and Chromium remain project-side prerequisites rather than
inflating the VSIX.

Live-site approval is per project and HTTPS origin. Payment, checkout, banking,
credentials-in-URL, crawling, attacks, and authentication guessing are blocked.
Runs are passive; adding any form submission, upload, purchase, publishing,
message, record creation, or deletion requires a new explicit modal capability
and is outside protocol v1.

## AI and Edits

AI Fix builds a second, redacted debugging bundle from aggregate page metadata,
console/network failures, and the selected project summary. It excludes cookies,
storage, form values, environment contents, headers, bodies, URL credentials,
queries and fragments. DOM metadata and a bounded JPEG screenshot begin off and
must be selected before preview. The browser shows the exact context before it
can be copied, handed to VS Code's stable Language Model API, or sent through
the already configured Private Browser provider.

Model output is evidence, never authority. Editor edits must name a path inside
the granted root, include the current SHA-256 file hash, remain below size/count
limits, and pass a final VS Code modal before `WorkspaceEdit` applies them.
Generated tests use this same route; direct filesystem writes from the browser
are not supported.

## Reports and Retention

Outcomes normalize to Passed, Needs attention, Failed, or Skipped. Findings
carry a cause, evidence, optional location, and recommendation. JSON reports and
their bounded artifacts are written under extension global storage (mode `0o600`,
which Windows ignores; there the user profile's access control protects them). Stored report size and content are checked through one open file
handle before schema validation, preventing a check/read swap. `reports.list`
sends the 20 newest reports with evidence cut to 200 characters; full reports
open in VS Code.
Users can list, open, delete, clear, and change retention (1–365 days, 10–500
reports). Defaults are 30 days and 100 reports.

Bridge 0.4.3 adds **Report history** for currently approved projects. Filter the
local reports by project, route, date, and result. **Stop test** cancels only the
selected project’s test. **Rerun with saved settings** reuses the selected
report’s effective inputs. Replay settings use VS Code’s encrypted local
storage. Sensitive routes are eligible only within the current session.
**Review export** shows a JSON summary with counts and result metadata.

## Packaging and Compatibility

The browser and extension use protocol v1. The extension is version 0.4.3 and
requires VS Code `^1.95.0`. `npm run extension:package` creates the fixed
`build/private-browser-bridge.vsix` embedded in the installer. `npm run dist`
also emits `release/private-browser-bridge-0.4.3.vsix` as a separate private CI
artifact.

Protocol incompatibility requires updating both the browser and VSIX from the
same release. Remote SSH, Codespaces, WSL extension hosts, virtual workspaces,
and unrestricted terminal access are unsupported in v1.

## Ten-step non-developer walkthrough

1. Open Private Browser and switch to the **Development** workspace.
2. Open **Dev → Project** and choose **Install VS Code extension** once.
3. In Private Browser open **Developer Bridge**, then **Project**. Choose
   **Generate pairing code** and note the eight digits and expiry time.
4. In VS Code run **Private Browser: Pair with Browser** and enter that code.
   **Cancel pairing** invalidates the current code. **Check connection status**
   shows the connected extension, protocol compatibility, local window,
   workspace trust and the project that has been approved.
5. Back in Private Browser choose the open workspace folder; approve the named
   folder in the VS Code modal.
6. Press **Start server**; read the exact command in VS Code and approve it.
   Bridge 0.4.2 shows the selected project, the expected framework URL, and its
   reported listening port. It checks only the exact local address printed by
   the approved task. **Retry** and **Stop server** operate on that project's
   managed process. **Check server status** refreshes missing-command guidance.
7. Open the reported local app in Development, then use **Inspect** to select a
   page element or open Chromium DevTools.
8. Use **Test** for Quick Test or a page-specific isolated check. Approve the
   exact Playwright command the first time.
9. For help, open **AI Fix**, optionally select DOM or screenshot, review the
   exact context, then choose **Fix in VS Code**. Review every proposed diff in
   VS Code before applying it.
10. Open **Results** to inspect local evidence. Use **Disconnect** for a normal
    stop or **Revoke this VS Code** to require fresh pairing next time.

## Troubleshooting

- **Pairing endpoint unavailable:** start Private Browser first and confirm both
  apps run as the same Windows user. Do not enable a TCP listener.
- **Code rejected:** generate a fresh code; codes expire after five minutes and
  stop after five attempts.
- **Identity changed:** revoke the connection in both apps and pair again. Do
  not copy secret-storage files between machines.
- **Workspace restricted:** use VS Code's Workspace Trust prompt. The bridge
  deliberately cannot bypass Restricted Mode.
- **No server command:** add a standard package script or Gradle wrapper. The
  browser never accepts an arbitrary shell command.
- **Page test skipped:** install `@playwright/test` and Chromium in that project
  through an approved VS Code terminal action.
- **Gradle unavailable:** add the project wrapper. ADB and Java detection alone
  are not enough to run a Gradle task.
- **Protected-page refusal:** move development work to Development. There is no
  override for Banking or payment pages.
