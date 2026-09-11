---
system: agent-bridge
sources:
  - electron/agent-bridge.ts
  - electron/codex-app-server.ts
  - vscode-extension/**
verified_at: 67925bd
---

# Agent Bridge

> Last verified: 2026-09-10

## Agent Brief

**Scope.** The local connection between Private Browser, VS Code and Codex.
`AgentBridgeServer` owns pairing and the OS-pipe protocol; the VS Code companion
owns editor context and trusted task execution; `CodexAppServer` owns the
stdio JSON-RPC session, sandbox selection and streamed task state.

**Not covered here:** Electron IPC and React rendering are documented in
[ipc-contract.md](ipc-contract.md) and [renderer-ui.md](renderer-ui.md).
Developer diagnostic collection is in [browser-shell.md](browser-shell.md).

### Invariants

1. **Remote pages never connect to the bridge.** The server exists only in the
   Electron main process. Tab views have no preload or IPC.
2. **Pairing never persists a bearer token in the browser.** The browser stores
   SHA-256 only; VS Code stores the token in `SecretStorage`.
3. **Editor writes require Workspace Trust.** The extension re-checks trust for
   save, open and task execution; the browser also refuses agent tasks when the
   returned context is untrusted.
4. **Absolute editor paths never reach React.** `rootPath` and
   `activeFileAbsolutePath` are removed by `publicEditorContext` and used only by
   the main-process Codex launcher.
5. **Page telemetry is untrusted.** The Codex prompt labels diagnostics and
   editor context as data, never instructions, and includes no page text,
   cookies, storage, headers, request bodies, query strings or fragments.

## Architecture

The browser listens on `\\.\pipe\private-browser-agent-v1` on Windows. Unix
uses a user-specific socket under the temporary directory for development. The
extension connects as a client; nothing listens on a LAN address or browser-
reachable HTTP port. The Unix socket is restricted to its owner (`0600`).

Messages are newline-delimited JSON, capped at 256 KiB. An eight-digit pairing
code lives in memory for five minutes and permits at most eight failed attempts.
A successful pair returns a 256-bit bearer token once. The browser atomically
stores only `sha256(token)` in `agent-bridge.json` with mode `0600`; the extension
stores the token through VS Code SecretStorage. Reconnect uses constant-time
digest comparison. Disconnect deletes the digest, closes the active socket and
stops Codex.

Only one editor client is active; a new valid editor connection replaces the
old editor socket. Separately authenticated MCP clients can coexist without
displacing it. Every browser-to-extension request has an id and a 15-second
timeout. Capabilities are allow-listed during registration; unknown claims are
dropped.

## VS Code Companion

`vscode-extension/src/extension.ts` contributes pair, connect and disconnect
commands plus a status-bar indicator. It auto-reconnects every five seconds when
a stored credential exists.

`editor.getContext` returns Workspace Trust, workspace/root names, active
workspace-relative file and selection (20,000-character cap), up to 100
diagnostics, Git branch/dirty summary and up to 100 named tasks. Full root and
active-file paths cross only the authenticated pipe for main-process use.

`editor.openLocation` resolves real paths and proves the target remains below a
trusted workspace root, blocking `..`, symlink and junction escapes.
`editor.runTask` accepts only the exact name of a task returned by
`vscode.tasks.fetchTasks`; it never accepts a shell string. `editor.saveAll`
uses the VS Code API. Every mutating method checks `workspace.isTrusted` again.

The root build compiles the extension. `npm run vscode:package` creates
`build/private-browser-vscode-bridge.vsix`; `npm run dist` bundles that file
inside the Windows app. The Agent panel installs it through a fixed Code.exe
command and fixed packaged path—no webpage or renderer-controlled executable.

The companion also registers a stdio MCP server programmatically with VS Code.
Its credential is injected from SecretStorage only when VS Code starts the
server. This makes seven focused tools available to compatible editor agents:
safe browser status/diagnostics, editor context, open source, named task, reload
and DevTools. Read operations carry `readOnlyHint`; actions do not. The MCP
process cannot execute a shell command and connects as a separate authenticated
role, so it cannot replace the editor connection.

## Codex Runtime

`CodexAppServer` launches `codex app-server --listen stdio://` inside the real
trusted workspace root. Its environment allow-list carries only OS/runtime
location variables; arbitrary application secrets are not inherited. App Server
handles authentication, threads, turns and streamed events.

Modes:

| Mode | Sandbox | Network | Intended use |
| --- | --- | --- | --- |
| `diagnose` | workspace-confined read-only | no | inspect and explain |
| `build` | workspace-write | no | edit and test with installed dependencies |
| `autopilot` | workspace-write | yes | complete an explicit end-to-end objective |

All modes use `approvalPolicy: never` inside their stated sandbox. If the runtime
or an administrator asks for extra command, filesystem, network, MCP or user-
input privileges, this client declines rather than silently broadening access.
Autopilot instructions forbid push, merge, deploy, publish, unrelated deletion
and credential access unless the user objective explicitly requests it.
Read access is restricted to the real workspace root plus Codex platform
defaults; workspace-write does not inherit full-home read access. Objective,
selection and diagnostics are redacted once more immediately before the turn.

The UI receives bounded, redacted events: at most 120 timeline entries, a
40,000-character answer and an 80,000-character diff. Workspace roots are
replaced with `<workspace>` and secret patterns are redacted before crossing IPC.
`turn/plan/updated`, `turn/diff/updated`, command/file items and final state feed
the live Agent Command Center. Stop calls `turn/interrupt`, falling back to
process termination.

## Security Boundary

`BrowserController.requireAgentWorkspace` protects every agent IPC method. The
active tab must be in Development and cannot be a detected banking/payment page.
Connection setup is permitted on Development Home; page diagnostics require the
stricter non-home Developer target.

This is a local single-user trust bridge, not a remote-control service. Do not
replace the OS pipe with localhost HTTP: hostile pages can probe loopback
services. Do not add arbitrary command execution to the VS Code protocol. New
capabilities require an allow-list entry, strict input validation, a Workspace
Trust check and tests for root confinement.

## Verification

- `tests/agent-bridge.test.ts` exercises pairing, digest-only persistence,
  capability filtering, context path stripping, disconnect and prompt-injection
  labelling.
- `tests/developer-tools.test.ts` proves only loopback source URLs can become
  workspace-relative open targets.
- `npm run vscode:package` verifies the installable VSIX structure.
- `npm run check` compiles both Electron and the extension and runs the complete
  application/Worker gate.
