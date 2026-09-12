---
system: vscode-bridge
sources:
  - electron/vscode-bridge.ts
  - packages/bridge-protocol/**
  - vscode-extension/**
verified_at: 1e9a38cd
---

# VS Code Bridge

> Last verified: 2026-09-12

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
   escapes, secrets, and browser profiles fail closed.
4. Commands come only from detected immutable specifications. VS Code displays
   the exact executable, arguments, and working directory and remembers only
   that specification's SHA-256 fingerprint.
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

Ordinary calls time out after 30 seconds; test calls may run for 15 minutes.
The browser accepts no extension-initiated privileged browser request. Incoming
traffic is limited to 120 messages per minute, and the extension permits at most
five command starts per minute.

## Project and Command Authorization

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
cancellation on Windows.

## Inspect and Test

Chromium DevTools remain available only on non-protected Development pages.
Element selection uses Electron's main-process `webContents.debugger` CDP
session without exposing a remote-debugging socket. When native DevTools already
owns the debugger, the same bounded evaluation runs through the main process.
Selectors contain only IDs, tag names, and a few classes. Route, framework,
viewport, console sources, failed requests, active editor, and confidence labels
are presented without claiming an exact React component when only a nearest
match exists.

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
their bounded artifacts are written with user-only permissions under extension
global storage. The browser receives summaries and artifact metadata only.
Users can list, open, delete, clear, and change retention (1–365 days, 10–500
reports). Defaults are 30 days and 100 reports.

## Packaging and Compatibility

The extension and browser are both version 0.4.0, require protocol v1, and the
extension declares VS Code `^1.95.0`. `npm run extension:package` creates the
fixed `build/private-browser-bridge.vsix` embedded in the installer. `npm run
dist` also emits `release/private-browser-bridge-0.4.0.vsix` as a separate
private CI artifact. Marketplace publication is intentionally absent.

Protocol incompatibility requires updating both the browser and VSIX from the
same release. Remote SSH, Codespaces, WSL extension hosts, virtual workspaces,
and unrestricted terminal access are unsupported in v1.

## Ten-step non-developer walkthrough

1. Open Private Browser and switch to the **Development** workspace.
2. Open **Dev → Project** and choose **Install VS Code extension** once.
3. In Private Browser press **Pair** and note the eight-digit code.
4. In VS Code run **Private Browser: Pair with Browser** and enter that code.
5. Back in Private Browser choose the open workspace folder; approve the named
   folder in the VS Code modal.
6. Press **Start server**; read the exact command in VS Code and approve it.
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
