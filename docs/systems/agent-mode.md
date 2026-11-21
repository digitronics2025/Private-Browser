---
system: agent-mode
sources:
  - electron/agent-host.ts
  - electron/agent-workspace.ts
  - electron/agent-driver.ts
  - electron/agent-policy.ts
  - electron/agent-space-policy.ts
  - electron/agent-state.ts
  - electron/agent-public-proxy.ts
  - electron/agent-pipe.ts
  - electron/agent-downloads.ts
  - electron/agent-lent-tab.ts
  - packages/agent-mcp/src/cli.ts
  - packages/bridge-protocol/src/agent.ts
verified_at: 3efa126
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
- Electron main resolves paired client, space, current top-frame document and
  exact origin. Work navigation and consequential actions retain trusted
  confirmation. An approval binds input and page revision. Navigation
  approval for the session is scoped to the same space and exact origin.
- The owner assigns clients to spaces. Work uses explicit origins. Unlisted
  destinations are blocked or open in a disposable signed-out preview.
  An authenticated Work view cannot load an unlisted main frame or subframe.
  Unlisted redirects hand off only as fresh preview GET requests.
- Open Web uses an in-memory partition and a local public-only proxy with no
  direct proxy fallback. The proxy rejects nonpublic DNS results and dials the
  validated address. WebRTC cannot use unproxied UDP. The partition cannot use
  HTTP authentication, passkey or federated credential APIs, saved logins, or
  manual control.
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
  temporary tab-owned staging. Downloads stay in the space’s local directory.
  A short-lived grant binds an agent download to the exact link. Quotas
  account for concurrent reservations and remove oldest completed files first.
- Stop and `Ctrl+Shift+.` close pipes and agent tabs, abort waits and discard
  confirmations. Default limits are eight hours, 30 idle minutes, eight tabs
  and 120 actions per minute. Hard limits are 12 hours, 60 idle minutes, 12
  tabs and 240 actions per minute. Absolute expiry persists across restart.
  The owner renews in trusted chrome. Rate accounting is per paired client.

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
| Device, policy, session and confirmations | `agent-host.ts`, `agent-space-policy.ts`, `agent-state.ts`, `agent-pipe.ts` in Electron |
| Browser isolation, downloads and requests | `electron/agent-workspace.ts` |
| DOM, page capture and developer tools | `electron/agent-driver.ts`, `electron/agent-page.ts` |
| Owner controls | `src/panels/AgentsPanel.tsx` |

`userData/agent-mode` holds encrypted policy and retained audit segments.
A version 1 file is backed up once as `clients.enc.bak`. Existing spaces keep
their IDs and partitions and retain per-client rules until an explicit
owner save. Only Work persists Chromium data. Audit rows include class,
origin and outcome. Up to five 10 MB encrypted segments are retained per
space. The viewer and native export show recent entries. Typed inputs, page
text, queries and file paths stay out of the audit.

## Threat model

| STRIDE class | Scenario | Control and residual risk |
| --- | --- | --- |
| Spoofing | A local process impersonates a client or browser | An encrypted eight-digit pairing challenge, five attempts, five-minute expiry, signed fresh challenge and pinned browser key after enrollment. The OS user controls the initial rendezvous directory. Malware already executing as that user can act with that user's access. |
| Tampering | A process replays ciphertext or modifies an approval | Independent directional encryption keys, ordered frames, authenticated session IDs, and one-use approvals bound to page revision and exact input. |
| Repudiation | A client disputes an operation | Local encrypted audit with stable outcome codes. The owner can export or clear records. |
| Information disclosure | Malicious instructions or secrets appear in a page | Data envelopes, bounded redaction and image masks. A site can deliberately print its own sensitive data in ordinary page text. Keep high-value accounts out of Agent Spaces. |
| Denial of service | An agent burns resources or a page stalls a call | Per-client rate limits, frame and output limits, tab caps, idle and absolute expiry, and a chrome stop switch. |
| Elevation of privilege | An agent attempts to access a regular signed-in tab | Main resolves Agent IDs and at most one opaque, owner-lent tab ID. The loan expires, forbids origin changes, and confirms every write. Site content shown in a signed-in tab can still include data the owner has chosen to expose to the client. |
| Supply chain | A compromised MCP dependency adds another route to browser control | Exact dependency version and lockfile, npm audit, a bundled stdio-only client, and no browser capabilities in the CLI. Main validates everything again. |

## Verification

`npm run agent:smoke` drives a disposable local fixture through MCP stdio,
Windows DPAPI, the named pipe and real Electron. The renderer preview covers
the Agents panel, confirmation and stop controls at 1280 and 375 pixels.
