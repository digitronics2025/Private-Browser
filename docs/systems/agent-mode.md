---
system: agent-mode
sources:
  - electron/agent-host.ts
  - electron/agent-workspace.ts
  - electron/agent-driver.ts
  - electron/agent-policy.ts
  - electron/agent-lent-tab.ts
  - packages/agent-mcp/src/cli.ts
  - packages/bridge-protocol/src/agent.ts
verified_at: 4ba2286d
---

# Agent Mode

> Last verified: 2026-11-21

## Agent Brief

Coding agents connect to an opt-in, local MCP stdio server. Electron main
enforces permissions and hosts a dedicated Agent Workspace window. The window
uses separate persistent partitions and storage. Its tabs and records never
enter the regular workspace catalog or Account Space recovery and sync code.
See the [setup guide](../agents/private-browser.md) and [security contract](../../SECURITY.md).

### Invariants

- Windows uses a random named pipe. Linux development uses a private Unix
  socket directory. There is no TCP or externally exposed CDP endpoint.
- The Agent wire version, private key, pairings and policy are separate from
  the VS Code bridge. The two reuse bounded framing and cryptographic
  primitives. Signed fresh challenges and per-direction session keys prevent
  replay and reflection.
- Browser identity and client grants use Electron OS-encrypted storage.
  The CLI pins the browser identity after first pairing and stores its private
  identity in Windows DPAPI or Linux Secret Service. Linux must have an
  unlocked Secret Service and `secret-tool`. The basic-text Electron backend
  is refused.
- Device names, exact origins, tab identity, and permissions are resolved
  in main. New destinations and consequential actions pause in trusted
  chrome. Confirmation binds the precise payload and current page revision.
  Session approvals cover navigation to that exact origin. An owner may save
  the exact origin from a repeat open of an already loaded, inspected page
  in the same Agent Account Space. This updates the client's approved origins
  without disconnecting it. Removing the origin clears the remembered
  approval. First visits, sensitive pages, uploads, lent
  writes and consequential actions retain their existing review.
- The owner may take manual control of a tab to enter credentials. That
  detaches the debugger and prevents tool access until control is returned.
  Secrets in sensitive inputs, browser profiles and browser storage remain
  outside the tool surface.
- Sensitive field types and labels are masked. Output uses bounded text
  redaction and wraps page-derived data in `untrusted_page_content`. Pixels of
  identified sensitive controls and embedded frames are masked before encoding.
- The main process accepts fixed page operations in a Chromium isolated
  world. `evaluate` supports `document.title`, `document.readyState`,
  `location.origin`, `window.innerWidth`, and `window.innerHeight` on
  development origins. Arbitrary scripting would bypass field and storage
  restrictions.
- Agent tabs refuse popups and hardware, notification, clipboard and display
  permissions. Script-initiated writes without an exact form authorization
  are blocked. Uploads come from an owner-selected directory and are copied to
  temporary tab-owned staging. Downloads stay in the space's local directory.
- Stop and `Ctrl+Shift+.` close pipes and agent tabs, abort waits and discard
  confirmations and clear leases. Existing and newly paired clients default
  to a one-hour lease that requires manual renewal when it expires. An
  eight-hour lease is renewed on the next connection after expiry. The open
  setting refreshes a 24-hour bound on every new connection. Connections
  still time out after ten idle minutes. One client can own up to four tabs.

## Lend a tab and run parallel tasks

The owner uses the active tab's trusted context menu to pick a connected
client. A loan exposes one opaque ID for at most fifteen minutes, through the
same bounded driver. The regular browser tab ID never crosses MCP. The loan
ends on an attempted change of origin, tab switch, client disconnect or
owner stop. The owner keeps the tab. Each lent write repeats the approval
flow, even for an ordinary click or typing. See
[SECURITY.md](../../SECURITY.md#owner-lent-tabs) for the special restrictions.

For each parallel task, use `tab_open` with a `label` and keep the returned
`tabId`. Pass it on every page call, including `snapshot`, `record_start`
and `record_stop`. Element references include a document identifier and
cannot select elements from a different task's page. The pipe serializes
calls within one connected client so action and approval order remain clear.

## Interfaces and storage

| Surface | Implementation |
| --- | --- |
| MCP tool declarations and validation | `packages/bridge-protocol/src/agent.ts` |
| MCP stdio, doctor and pairing | `packages/agent-mcp/src` |
| Device, policy, session and confirmations | `electron/agent-host.ts`, `electron/agent-policy.ts` |
| Browser isolation, downloads and requests | `electron/agent-workspace.ts` |
| DOM, page capture and developer tools | `electron/agent-driver.ts`, `electron/agent-page.ts` |
| Owner controls | `src/panels/AgentsPanel.tsx` |

`userData/agent-mode` holds the encrypted client list and last 200 audit
entries. The audit includes action, origin and outcome. Keep individual
inputs, page text, queries and passwords out of it. Exports require a native
save dialog. Persistent Chromium data uses random Agent-space partition IDs.

## Threat model

| STRIDE class | Scenario | Control and residual risk |
| --- | --- | --- |
| Spoofing | A local process impersonates a client or browser | An encrypted eight-digit pairing challenge, five attempts, five-minute expiry, signed fresh challenge and pinned browser key after enrollment. The OS user controls the initial rendezvous directory. Malware already executing as that user can act with that user's access. |
| Tampering | A process replays ciphertext or modifies an approval | Independent directional encryption keys, ordered frames, authenticated session IDs, and one-use approvals bound to page revision and exact input. |
| Repudiation | A client disputes an operation | Local encrypted audit with stable outcome codes. The owner can export or clear records. |
| Information disclosure | Malicious instructions or secrets appear in a page | Data envelopes, bounded redaction and image masks. A site can deliberately print its own sensitive data in ordinary page text. Keep high-value accounts out of Agent Spaces. |
| Denial of service | An agent burns resources or a page stalls a call | Per-connection rate limits, frame and output limits, tab caps, idle and absolute expiry, and a chrome stop switch. |
| Elevation of privilege | An agent attempts to access a regular signed-in tab | Main resolves Agent IDs and at most one opaque, owner-lent tab ID. The loan expires, forbids origin changes, and confirms every write. Site content shown in a signed-in tab can still include data the owner has chosen to expose to the client. |
| Supply chain | A compromised MCP dependency adds another route to browser control | Exact dependency version and lockfile, npm audit, a bundled stdio-only client, and no browser capabilities in the CLI. Main validates everything again. |

## Verification

`npm run agent:smoke` drives a disposable local fixture through MCP stdio,
Windows DPAPI, the named pipe and real Electron. The renderer preview covers
the Agents panel, confirmation and stop controls at 1280 and 375 pixels.
