---
system: control-center-link
sources:
  - electron/control-center-link.ts
verified_at: 7ec1a22
---

# Control Center Link

> Last verified: 2026-09-24

## Agent Brief

**Scope.** How the Developer panel's **Tasks** tab sends a page problem to the
AI Development Control Center on this computer as a task, follows the tasks it
sent, and attaches a re-check once a task has run. The client and sealed store
are in [electron/control-center-link.ts](../../electron/control-center-link.ts).
The controller methods sit in `electron/main.ts` (`controlCenter*`,
`sendToControlCenter`, `recheckControlCenterTask`); that file is owned by
[browser-shell.md](browser-shell.md). The panel is
[src/panels/ControlCenterSection.tsx](../../src/panels/ControlCenterSection.tsx),
owned by [renderer-ui.md](renderer-ui.md).

The Control Center side of the same link is its `docs/systems/connected-apps.md`.

**Boundary.** The browser is always the client. The Control Center never sends
the browser a request, and nothing here gives it any power over the browser,
its Account Spaces, cookies or the vault. Agents never drive Private Browser.

### Invariants

1. **Every send spends one approval of a Developer-panel preview.**
   `sendToControlCenter` and `recheckControlCenterTask` check the Development
   workspace first, then spend the approval (`consumeAiApproval`: deleted before
   it is validated, with the tab, Account Space and revision re-checked and the
   protected-page test run again), then require that the preview came from
   `prepareDeveloperAiPreview` (`developerPreviewIds`). An ordinary page preview
   is refused, and its approval is spent anyway.
2. **Nothing is re-read after approval.** The body is `developerEvidence(preview)`,
   which is the approved text plus the DOM if it was chosen, cut to 30,000
   characters. The screenshot goes only if it is in the approved preview. The
   page address is `sanitizeDiagnosticUrl` of the tab: origin and path only.
3. **The renderer sends only an approval token, a repository id and a note**
   (or a task id). The contract refuses any other field.
4. **The token never reaches the renderer.** It lives in main memory and in
   `userData/control-center-link.enc`, sealed with `safeStorage`. `status()`
   returns `{state, url, fingerprint?, detail?}` only.
5. **Only loopback is ever called.** The address comes from
   `%LOCALAPPDATA%\AIDevControlCenter\runtime.json` when it names an `http:`
   loopback URL. Otherwise it is `http://127.0.0.1:4317`. Every request uses
   `redirect: 'error'`, a 10 s timeout and a 256 KB answer bound. Main-process
   `fetch` sends no `Origin` header, which the Control Center requires.
6. **The key is pinned.**
   - Pairing keeps the Control Center identity key only if it signed
     `acc-connected-app-v1 pair\n<appId>\n<nonce>`.
   - Before the first call of each run at an address, a fresh signed `hello`
     must verify against the pinned key. Otherwise nothing is sent
     (`identity-changed`).
   - A 401 forgets the token only after the pinned key answered at that
     address, so a program squatting the port can't unpair the browser.
   - Test vectors:
     [tests/fixtures/acc-connected-app-v1.vectors.json](../../tests/fixtures/acc-connected-app-v1.vectors.json),
     byte-identical to the Control Center's copy.

## States

| `state` | Meaning |
| --- | --- |
| `not-paired` | No saved link, or the Control Center refused the token |
| `connected` | The pinned key answered a fresh `hello` this run |
| `unreachable` | Nothing answers on the loopback address |
| `identity-changed` | Something answers without the pinned key; nothing is sent |
| `unavailable` | OS encryption is off, or the saved link was unreadable. The file is moved aside as `*.corrupt-<time>`, never reused. |

**Disconnect** deletes the local file. Disconnecting in the Control Center
(Tools → Connected apps) stops the token there.

## Flow

1. **Pair.** In the Control Center: Tools → Connected apps → **Pair Private
   Browser** → **Make a pairing code**. In the Tasks tab, type the eight digits
   and compare the key it then shows with the Control Center's dialog.
2. **Report.** Choose the repository. The suggestion comes from the page origin
   matching the repository's app address, then from the last choice for that
   origin; up to 50 origins are remembered in the sealed file. Write the note in
   your own words (it becomes the task's request) and optionally choose the DOM
   or a screenshot. **Preview what will be sent** shows the exact context;
   **Send to Control Center** approves it and sends it once.
3. **Follow.** "Sent from this browser" polls every 5 s while the tab is open.
   It shows the stage, outcome and blocker of the app's own tasks, and a link
   that opens the task in the Control Center in a new Development tab.
4. **Re-check.** On a finished task, **Check again** clears the tab's captured
   console and network entries (they otherwise survive a reload, and a re-check
   would repeat the old error), reloads the page, waits for it to load, and
   builds a fresh preview. **Attach to TASK-…** approves and
   sends it as re-check evidence.

A create or re-check that loses its answer is retried up to twice with the
**same** request id, so the Control Center returns the task it already made
instead of making a second one.

## Privacy log

| Action | Entry |
| --- | --- |
| Pair | `vault` "Paired with the Control Center" (key and address) |
| Disconnect | `vault` "Control Center link removed" |
| Send | `cloud-approved` "Control Center handoff approved" |
| Re-check | `cloud-approved` "Control Center re-check approved" |

The sends use the same `cloud-approved` kind as the VS Code handoff: an approved
hand-off to another program.

## Verified

- [tests/control-center-link.test.ts](../../tests/control-center-link.test.ts)
  covers:
  - vectors;
  - the loopback check;
  - sealed round-trip, and the token absent from disk and status;
  - refused unsigned pairing;
  - squatter refusal without unpairing;
  - suggestion memory;
  - same-id retry;
  - redirect and size refusal;
  - revoke;
  - corrupt-file quarantine.
- [tests/ipc-control-center.test.ts](../../tests/ipc-control-center.test.ts)
  covers channel parity across main, preload, contract and preview mock; exact
  shapes; and ordering in the controller.
- [tests/electron/control-center.spec.ts](../../tests/electron/control-center.spec.ts)
  runs the real app against a loopback stand-in Control Center signing with the
  test key:
  - pairing through the panel;
  - exact-context send with no query string;
  - task list and re-check;
  - replay refused;
  - a non-developer preview refused;
  - Banking refused, with no Tasks tab.
  Set `PB_EVIDENCE_DIR` to save window-only screenshots.

## Gotchas

- `runtime.json` disappears when the Control Center stops cleanly; the default
  port is then tried, and the pinned key still decides.
- The Tasks tab needs a non-home Development page to preview. Pairing and the
  task list work from any Development page.
