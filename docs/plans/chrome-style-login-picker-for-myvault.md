---
title: Chrome-style login picker for MyVault
source: ~/.claude/plans/quiet-petting-clock.md
created: 2026-09-24
status: in-progress
---

# Chrome-style login picker for MyVault

## Context

When a saved site has several logins, Private Browser silently auto-fills the
most recently updated one (`selectAutomaticFillEntry`,
[automatic-fill.ts](electron/myvault/automatic-fill.ts)). Choosing another
account means opening the side panel → Vault → search → Fill. Chrome instead
shows a dropdown under the focused email/password field listing every saved
account for the site. The operator wants that.

The constraint that shaped the current design: remote pages get no preload and
no Node ([SECURITY.md](SECURITY.md)), and the React chrome sits *under* the tab's
`WebContentsView`, so it cannot draw over the page. Injecting a list into the
page DOM would let the page read every saved username. So the picker must be a
**trusted overlay view owned by the main process**, like Chrome's browser-drawn
popup.

## Design

### 1. Trigger — real user input only (nothing a page can forge)

In `ensureView` ([main.ts:1941](electron/main.ts#L1941)), listen to the tab
view's `input-event` (Electron 44, emits genuine mouse/keyboard input):

- `mouseDown` (left button) inside the page, or `keyUp` of `Tab`, or `keyDown`
  of `ArrowDown` while no picker is open → after ~50 ms (focus has settled), run
  a new isolated-world probe.
- New `probeFocusedLoginField(contents)` in
  [isolated-fill.ts](electron/myvault/isolated-fill.ts), world
  `VAULT_ISOLATED_WORLD_ID`: returns `{ kind: 'username' | 'password', rect }`
  when `document.activeElement` is a visible, enabled, non-readonly input that
  matches the **same selectors** fill already uses, the document has exactly one
  visible current-password field, and there is no `autocomplete="new-password"`
  field (the same refusals as `fillLoginAutomaticallyInIsolatedWorld`). It
  returns `undefined` otherwise. The rect is `getBoundingClientRect()` in CSS px.
  It runs only in the main frame, so iframes get no picker (fail closed, as fill does now).

No page script, console channel or DOM event is trusted. The page can at most
focus a field itself, and that still needs a real click or keypress from the user
before anything opens.

### 2. Eligibility gate (main, before showing anything)

Show the picker only when all hold:
- new policy flag `fillPicker` in
  [workspace-policy.ts](electron/myvault/workspace-policy.ts): `true` in
  STANDARD (Digitronics, TenTen, Personal), `false` in Banking and Development.
- vault `unlocked`, active tab, not home, no `certificateError`,
  `isAutomaticFillPageUrl(url)` (HTTPS, no signup/reset paths).
- `currentFillContext()` succeeds (rejects punycode, credentialed URLs, and
  origin mismatch).
- `vault.searchMetadata('', origin)` filtered by `hasPassword`, `url`, and
  `isAutofillTarget(entry.url, origin)` is non-empty. It is sorted like
  `selectAutomaticFillEntry` (preferred first, then newest) and capped at 8 rows,
  plus a "Manage logins…" row that opens the side panel Vault tab.

### 3. The overlay — new `electron/myvault/fill-picker.ts`

A `FillPicker` class modelled on `SecureVaultDialogs`
([secure-dialog.ts](electron/myvault/secure-dialog.ts)):

- one `WebContentsView` child of the main window, added last so it's on top;
  `sandbox`, `contextIsolation`, `nodeIntegration:false`, `devTools:false`,
  `data:` HTML with a strict nonce CSP, deny window-open and navigation, and
  `escapeHtml` on every username or title.
- new preload `electron/myvault/fill-picker-preload.cts` exposing only
  `choose(index)` and `dismiss()`, with nonce passed via `additionalArguments`.
  The preload never receives an entry id. Main maps the row index to the entry
  id through the open session's private list.
- a session holds `{ nonce, context: FillContext, entryIds[], viewId }`.
  `choose` is accepted only from that view's `webContents.id` and that nonce, and
  only once.
- position: the tab view's bounds + `rect × contents.getZoomFactor()`, placed below
  the field. It flips above the field when there's no room below and is clamped
  to the tab view. Width = max(field width, 280). Row height is fixed, so the view's
  height is known before load.
- the rows show a site icon letter, the username (or "No username"), and a dotted
  password placeholder, in the same dark style as the side panel.

### 4. Keyboard, done like Chrome

While open, the tab view's `before-input-event` (already routed to
`handleShortcut`, [main.ts:2042](electron/main.ts#L2042)) intercepts, before the
shortcut handling:
- `ArrowDown` / `ArrowUp` → `preventDefault`, move the highlight (main sends the
  index to the overlay)
- `Enter` with a highlighted row → `preventDefault`, choose it
- `Escape` → `preventDefault`, dismiss
- any other key → dismiss and let it through (the user is typing)

Page focus stays in the field. The overlay never takes keyboard focus. Mouse
clicks on it work normally.

### 5. Dismissal — close on any context change

Close the overlay on: `did-start-navigation` (main frame, next to the existing
`invalidateTab` call), tab switch or close, workspace switch, vault lock
(the `invalidateAll` sites at [main.ts:508](electron/main.ts#L508) and
[main.ts:520](electron/main.ts#L520)), window blur, resize, `applyLayout`,
`mouseWheel` in the page, a `mouseDown` outside the overlay, fullscreen, and a
10-second idle timeout. A choice arriving after any of these fails the context check.

### 6. Filling the choice

Extract the body of `autofill(id)` ([main.ts:1648](electron/main.ts#L1648))
into a private `fillEntryInto(context, id, { confirm })` that both the side panel
Fill and the picker call:
`issue` → `redeem` against `currentFillContext()` → `isAutofillTarget` →
`resolveSecretForTrustedOperation` → re-check context → `fillLoginInIsolatedWorld`.
The picker path passes the **session's** context, so a tab, generation, origin or
account-space change between opening and clicking throws and fills nothing. On
success it sets `preferredFillEntryByOrigin` and marks
`automaticFillGeneration`, the same as today, and writes the privacy event
"Credential filled from picker".

Choosing overwrites the fields, which matches Chrome and the existing manual Fill.
Automatic fill is unchanged: it still pre-fills the newest (or last-chosen)
login, and the picker is how you switch.

## Files

- new `electron/myvault/fill-picker.ts`, `electron/myvault/fill-picker-preload.cts`
  (+ build wiring beside `secure-preload.cts`)
- [electron/myvault/isolated-fill.ts](electron/myvault/isolated-fill.ts) — `probeFocusedLoginField`
- [electron/myvault/automatic-fill.ts](electron/myvault/automatic-fill.ts) — export an
  ordering helper `orderFillCandidates(entries, preferredId)` reused by both paths
- [electron/myvault/workspace-policy.ts](electron/myvault/workspace-policy.ts) — `fillPicker`
- [electron/main.ts](electron/main.ts) — input listeners, gate, dismissal hooks,
  `fillEntryInto` refactor
- docs: [docs/systems/vault.md](docs/systems/vault.md) (invariant 6 + Components,
  bump `Last verified`), [SECURITY.md](SECURITY.md) (new trusted overlay surface),
  [docs/systems/security-boundary.md](docs/systems/security-boundary.md) if it
  lists trusted views

## Tests

- unit (`tests/`): `orderFillCandidates` ordering/cap; `fillPicker` policy per
  workspace; picker session rejects a wrong sender, wrong nonce, replay, an
  out-of-range index, and a changed context (extend
  [vault-security-boundary.test.ts](tests/vault-security-boundary.test.ts)).
- Electron e2e: new `tests/electron/fill-picker.spec.ts` built on the HTTPS fixture in
  [automatic-fill.spec.ts](tests/electron/automatic-fill.spec.ts) with **two**
  saved logins:
  1. clicking the email field opens the overlay with both usernames, and the page's
     main world can't see them (`document.body.innerText` contains neither)
  2. clicking the second row fills that account, and nothing submits
  3. ArrowDown + Enter picks by keyboard, and Escape closes
  4. navigating while it's open closes it, and a stale choose fills nothing
  5. a Banking tab shows no overlay
  6. a signup-path page shows no overlay

## Verification

1. `npm run check`, the single gate. Per memory, the Turnstile Electron test fails
   on this PC even on clean main. If that one test is the only failure, it gets
   reported as known and not as a regression.
2. Visual check through `browser-autopilot` / the running app on the operator's
   PC: open the digitronics sign-in page in TenTen with the vault unlocked,
   click the email field, and confirm the list appears under the field and
   switches account. Screenshots only of the Electron window render (memory:
   full-screen grabs leaked other windows), saved under
   `C:\Users\abuye\.claude\browser\playwright-mcp`.

## Assumptions

- Only in-page login forms in the main frame get the picker. Sign-in forms inside
  an iframe keep today's behaviour (side panel only).
- Fill targets the first visible username/password fields, like today, not
  necessarily the exact field clicked. That is enough for single-form login pages.
- No "suggest a strong password" row or passkey rows in this round. Both go in
  [docs/follow-ups.md](docs/follow-ups.md).
- The working tree already holds uncommitted, unrelated search/home-settings edits,
  including in `electron/main.ts`. So this work **is not committed or pushed**. It
  stays in the working tree for the operator to review alongside those edits.
  Pushing to main publishes a release, so that stays a separate decision.

### Irreversible steps (from the approved plan)

None. No commit, no push, no release, no data migration. The vault file format is
untouched.

## Steps

- [ ] 1. `fillPicker` policy flag (on in STANDARD, off in Banking/Development) and `orderFillCandidates` helper in automatic-fill.ts, reused by `selectAutomaticFillEntry` — done when: unit tests cover ordering, cap and per-workspace flag — check: `npx vitest run tests/fill-picker.test.ts`
- [ ] 2. `probeFocusedLoginField` in isolated-fill.ts — done when: it typechecks and returns kind+rect only for the focused recognized login field — check: `npm run typecheck`
- [ ] 3. `FillPicker` overlay class + `fill-picker-preload.cts` with nonce/sender/single-use/index validation and build wiring — done when: session validation unit tests pass and the preload is emitted by the build — check: `npx vitest run tests/fill-picker.test.ts && npm run build`
- [ ] 4. main.ts wiring: `fillEntryInto` refactor shared by side-panel Fill and picker; input-event trigger; eligibility gate; keyboard interception; every dismissal hook — done when: typecheck and existing vault tests pass — check: `npm run typecheck && npx vitest run tests/vault-browser-integration.test.ts tests/vault-security-boundary.test.ts`
- [ ] 5. Electron e2e `tests/electron/fill-picker.spec.ts` (two logins: click opens list, page cannot read usernames, row click fills second account without submit, ArrowDown+Enter, Escape, navigation closes, Banking none, signup none) — done when: the spec passes — check: `npx playwright test --config playwright.electron.config.ts tests/electron/fill-picker.spec.ts`
- [ ] 6. Visual check of the overlay in the real app on an HTTPS fixture — done when: a screenshot of the Electron window render shows the list under the field — check: `manual: screenshot under C:\Users\abuye\.claude\browser\playwright-mcp`

## Tail

- [ ] T1. Adversarial review of the whole diff — done when: every finding is fixed or written to the Ledger with a reason — check: `git diff --stat` reviewed hunk by hunk
- [ ] T2. Similar-issue sweep — done when: other fill paths (TOTP fill, capture) and the passkey overlay were checked for the same context-change gaps — check: `manual: list what was searched and what was found`
- [ ] T3. Gate green — done when: `npm run check` exits 0 (the known local Turnstile Electron failure excepted and named) — check: `npm run check`
- [ ] T4. Docs synced — done when: vault.md invariant 6 + Components, SECURITY.md, security-boundary.md and follow-ups reflect the change — check: `git diff --stat docs/ SECURITY.md`
- [ ] T5. Committed path-scoped on branch feat/fill-picker; not pushed — done when: `git status` in the worktree is clean — check: `git -C ../Private-Browser-fill-picker status --short`
- [ ] T6. Confirmed live where the push deploys — done when: this step records that nothing was pushed — check: `manual: git log origin/main..feat/fill-picker`
- [ ] T7. A claim registered for this change — done when: the claim is named or the step says why none applies — check: `manual`

## Ledger

- 2026-09-24 19:10 — created from ~/.claude/plans/quiet-petting-clock.md
- 2026-09-24 19:10 — worktree — another session is committing in the main checkout (unpushed zoom commit, an autostash holding ipc-contracts.ts edits). Work moved to worktree `../Private-Browser-fill-picker` on branch `feat/fill-picker` off 80cd075, with a real `npm ci` (no junction), matching how other sessions here isolate work. The approved plan's "no commit" assumption is narrowed to "no commit on main, no push": commits land only on the local branch, which is reversible, while pushing main publishes a release.
