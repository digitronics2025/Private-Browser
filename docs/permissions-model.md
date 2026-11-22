# Private Browser permissions model

Approved at Gate G1. Scope is Agent Mode in the Windows Electron app. See the
[security contract](../SECURITY.md#agent-mode) and
[Agent Mode guide](systems/agent-mode.md) for the runtime and setup.

## Spaces and access

| | Open Web | Work |
| --- | --- | --- |
| Purpose | Public browsing in a disposable Chromium partition | Owner-managed sessions in separate Agent partitions |
| Origins for interaction | Public HTTP and HTTPS, subject to the existing protected-site rules and the public-network boundary below | Exact origins or explicit subdomain patterns entered by the owner |
| Outside listed origins | No access outside public HTTP and HTTPS | Signed-out preview with read and view by default for a new Work space. Existing Read only and Block settings survive migration. |
| Classes | Read, view, interact and authorized downloads. Uploads require a separate folder grant. Diagnostics are off. | Read, view and interact. Files are off until enabled by the owner with a folder grant. Fixed diagnostics require an explicitly listed loopback origin. |
| Accounts | No saved logins, cookie import, autofill, browser credential integration or HTTP authentication | The owner takes manual control to sign in. The agent is detached while the owner controls the tab. |

Use a versioned, validated policy in the existing OS-encrypted store. Each
space has its stable ID, name, trust type, origin mode and rules,
outside behavior, enabled classes, optional upload root and download quota.
Keep client pairing and client space access as a separate ceiling. Space access
is granted to each client by the owner. Creating a space or granting client
access must use trusted settings. Work manual sign-in is available only on a
listed origin. On changes, revoke affected pending approvals,
stop active operations and require a fresh policy decision before reconnecting
or reopening tabs. A space with existing data cannot switch trust type in place.

Migrate every existing Agent space to Work with its existing ID and partition.
Move existing client restrictions forward as a ceiling, including Block and
Observe. Preserve the exact origin lists. An empty list remains empty.
The old Develop shortcut for loopback access becomes an explicit owner grant
for an exact scheme, host and port. Keep the old upload grant in the encrypted backup. Require a fresh owner
choice before a space can use any upload folder.
Create Open Web as a separate, unassigned space. Its agent access begins only
after the owner enables it for a paired client. On save, replace the encrypted
policy atomically. Retain the old encrypted file for rollback. A corrupt file
or unsupported version disables Agent Mode with a visible recovery error.
Rollback should restore the prior grants from the encrypted backup and must
never convert Open Web data into a Work partition.

Keep unlisted Work pages in a disposable signed-out preview partition separate
from both the Work account partition and Open Web. A listed Work page cannot
redirect its authenticated view into an unlisted destination. For an eligible
GET navigation, resolve the destination in the preview with fresh requests,
no copied headers, referrer, form data or credentials. Refuse if the browser
cannot make that transition safely. Unlisted subframes in a signed-in Work
view cannot take action or reuse the Work grant.

Open Web may hold ordinary site state within a session. Reset its ephemeral
partition when the lease ends, the app stops or the owner clears it. The browser exposes manual control only in listed Work tabs, so the owner
signs in there. Warn in trusted chrome and pause tools if a probable
authentication cookie on a listed Work origin is detected in Open Web. Observe signals as
booleans only. Never retain credentials, form values, cookie names or cookie
values. The owner may clear the isolated space or keep it paused. Sites can
authenticate without these detectable signals. The UI should describe the
warning as detection of a possible sign-in. It cannot certify anonymous use.

## What the browser checks

Keep one exhaustive tool classification in the shared protocol and a single
authorization entry in Electron main. The MCP CLI transports requests. It
cannot edit policy, pair other clients, renew a lease, clear a space, or grant
file access. The decision function takes validated policy, client capability,
a classified action, frame origin, the current time and session state. It returns an allow result
or a stable code and plain explanation. Main applies existing protected-site,
owner-control, sensitive-field, loan, confirmation and request checks even
when the policy permits an action.

| Class | Tools |
| --- | --- |
| Read | `browser_status`, `tabs_list`, `snapshot`, `get_text`, `screenshot`, `console_messages`, `network_requests`, `performance_snapshot`, `accessibility_audit`, `downloads_list`, `dev_servers` |
| View | `scroll`, `hover`, `emulate`, `wait_for`, `tab_select`, `record_start`, `record_stop` |
| Interact | `navigate`, `tab_open`, `tab_close`, `go_back`, `go_forward`, `reload`, `click`, `type`, `check`, `select_option`, `drag`, `press_key`, `handle_dialog` |
| Files | `upload_file` and any operation that triggers a download |
| Diagnostic | `evaluate` with a fixed expression on an explicitly granted loopback origin |

- Normalize HTTP(S) origins with the URL parser. Convert IDNs to ASCII, remove
  default ports and normalize case. Keep explicit nondefault ports and
  distinguish schemes. Treat a trailing dot as a distinct host unless it is
  explicitly listed. Refuse user information, ambiguous host forms, and
  paths, queries or fragments in policy entries. Wildcards are subdomain-only,
  scheme- and port-specific and allowed only below a registrable domain.
- Resolve the owned tab, partition and live Chromium frame from trusted
  metadata. Bind references to the frame's document revision. Recheck after
  awaits and after confirmation. Cross-frame targets, including the source and
  destination of a drag, require separate decisions. At the point of dispatch
  the driver must validate document identity again. Refuse uncertain or opaque
  frames. The existing top-frame driver can deny actions in unsupported frames
  until a real frame-bound execution path is verified.
- An explicitly requested safe navigation may open a Work origin in read or
  view mode if policy permits. Refuse requests to blocked origins. Any allowed
  redirect must have its own navigation decision and must shed the previous
  document's grants and references before it loads. Existing popup denial
  stays in force. An explicitly opened alternate tab receives its own decision.
  Refuse unsupported schemes, including top-level `file:`, `data:`, `blob:`
  and `javascript:`.
- Expose display controls on view-only pages. Viewport, theme and motion
  emulation are eligible. Offline mode and CPU throttling remain restricted.
  For hover use a trusted target highlight if pointer events could run page
  code. Scrolling and resizing can run site handlers. Keep request protections
  active, cancel downloads they initiate, and refuse a view operation if it
  would cross the frame boundary or dispatch interaction. Refuse scripted
  non-read-only network requests on view-only origins. A server can still
  attach side effects to a GET request, including ordinary navigation.
- Keep exact approvals for consequential actions. A granted origin does not
  authorize account recovery, payments, credential entry, posting or other
  actions that require owner approval. A remembered navigation approval may
  be saved only for an exact, already-listed Work origin and a previously
  loaded, inspected page. Removing access or the exact rule clears the approval.
  Lend a tab under its existing separate,
  shorter grant and origin restrictions.
- Return safe effective policy from `browser_status`, with space name, origin
  mode, access outside the list, tool classes, upload folder presence, configured
  limits, lease expiry and renewal state. Never return the local path. Use
  `ORIGIN_READ_ONLY`, `SESSION_EXPIRED`, `POLICY_UNAVAILABLE` and
  `UNKNOWN_TOOL` for their respective conditions. A rejected session may reveal
  its own expiry code and renewal hint, without exposing page or policy data.

## Sessions, files and audit

| Per-client limit | Default | Hard cap |
| --- | --- | --- |
| Actions per minute | 120 | 240 |
| Open agent tabs | 8 | 12 |
| Idle time | 30 minutes | 60 minutes |
| Absolute session duration | 8 hours | Owner setting, 12 hours by default and up to 24 hours |

Rate accounting follows the paired client across tabs and reconnects. The
browser keeps an expiry for that client independent of the transport and
preserves it across restart. Owner renewal issues a fresh lease through trusted
chrome. Editing the cap from trusted Settings can shorten existing leases.
Longer durations require a saved client limit and owner renewal. Tool activity
cannot renew leases or change the cap. Revocation, expiry and Stop cancel
operations, release tabs and invalidate approvals. Idle time is per client
and ordinary waiting cannot run past the absolute expiry.

Use the existing temporary upload staging with a default 25 MB limit. Check
absolute local paths and reject traversal, UNC/device paths, alternate streams,
reserved names, and reparse escapes. Validate the opened file against the
real folder, check size during copy and stage a bounded copy. Clean up on tab
close or failure. Do not allow another space's internal directory as a grant.
Use a folder per space for downloads. Reserve and enforce a default 500 MB
on-disk quota across concurrent transfers, including those with unknown length.
Clean up completed ordinary files oldest first. Never auto-open or unpack
downloads. Preserve extension restrictions and remove filenames and paths from
audit records.

Append local audit records per space to protected, encrypted segments. Show the
timestamp, tool, class, origin, decision and refusal code. Retain up to five
10 MB segments per space. Exclude queries, text, inputs, file paths, images and
credentials. The viewer uses trusted chrome and the existing native export
dialog. A failed durable audit write stops the affected session. Default
screenshot retention is off. If owner retention is available, cap it at
200 MB per space, with oldest-first cleanup.

## Threat model

| Threat | Control and verification |
| --- | --- |
| Prompt injection in a web page | Keep all page output in untrusted envelopes. Fixed driver methods, existing redaction and masking, and browser-side confirmation rules still apply. Check against the current prompt-injection fixture. |
| Open redirect | Recheck the redirect destination and detach old grants and references. A Work redirect to an unlisted origin opens in the signed-out preview or is blocked. T-REDIR. |
| Hostile embedded frame | Chromium-provided frame identity and document revision must match at dispatch. Unsupported or opaque frames are refused. Do not send a blind pointer or keyboard event into a frame. T-IFRAME. |
| Popup or new tab | Preserve trusted main-process popup denial. Test that an unlisted popup cannot be driven or inherit a grant. T-POPUP. |
| Non-web addresses | Accept only supported HTTP(S). Refuse opaque frames and top-level non-web URLs, before and after navigation. |
| Look-alike domains | Compare canonical ASCII origins and show them before the owner saves. Warn for IDNs and broad patterns. Verify apex, unrelated suffix and homograph cases. |
| DNS resolves to a private address | Keep explicit Work loopback grants exact. For Open Web, enforce public-only connections at the actual connection boundary, including redirects, subresources and sockets. Electron's pre-request hook has no final connected IP. A DNS preflight alone cannot establish this boundary. Keep broad Open Web access disabled unless the local guard is proven on the supported build. T-REBIND. |
| Cookie, cache or service-worker leakage | Random partition IDs and separate download/history namespaces. Reset Open Web without touching Work. Verify both directions and the signed-out Work preview in the shipping implementation. T-ISO. |
| Upload traversal or file replacement | Reject unsafe path forms, validate the opened file and use a restricted staged copy. T-UPLOAD. |
| Download or archive bomb | Count actual bytes, reserve space across transfers, cancel at the bound and never automatically expand files. T-DL. |
| Rate limit across tabs or reconnects | Count per paired client from one trusted clock and keep accounting across reconnect. T-RATE. |
| Lease renewal or policy changes from MCP | Trusted owner IPC only. Persist lease state, reject unknown tools and discard approvals when policy changes. T-NOESC and expiry tests. |
| Sensitive data in logs | Build rows from trusted, typed fields and retain origins only. Keep existing output redaction and snapshot masks. T-LOG. |

Sources for implementation feasibility: [Electron webRequest](https://www.electronjs.org/docs/latest/api/web-request),
[Electron frame metadata](https://www.electronjs.org/docs/latest/api/web-frame-main/)
and [Electron popup controls](https://www.electronjs.org/docs/latest/api/window-open/).
The current repository uses a local MCP transport. Its existing Cloudflare
download service is outside these changes.

## Gate G1 design review

The [settings mockups](plans/private-browser-autonomy-review/settings-mockups.pdf)
cover every screen at 1440 × 900 and 375 × 812 in light and dark. Settings stays
in the browser's side panel, with its Segoe UI text, navigation and outline
buttons. Renewal and sign-in warnings stay in the trusted Agent Workspace.
Mockups use fixture origins and audit records.

Keyboard order follows heading, section navigation, fields in reading order,
then Save or Cancel. Give the first invalid field focus and announce its
inline error. Associate help text and limits with their controls. Announce
save results and canonical preview changes politely after input settles.
Dialogs keep focus inside, begin on the safer action and return focus to the
opener. Cancellation keeps a possible sign-in paused. At mobile width, audit
rows stack as labelled values. Use named landmarks, labelled fields, text
alongside color, at least 4.5:1 for normal text, visible focus and reduced motion.
Screen-reader behavior and automated accessibility checks apply to Phase 5.

Claude Code's documented wildcard for server-specific permissions matches
all tools from the named server. Keep that change at Gate G2 and test it
against the installed client and exact server alias before merging.
[Claude Code MCP permission rules](https://code.claude.com/docs/en/permissions#mcp).
