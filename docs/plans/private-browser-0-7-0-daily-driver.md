---
title: Private Browser 0.7.0 "Daily Driver" — a browser someone can use all day instead of Chrome
source: ~/.claude/plans/private-browser-0-7-0-merry-otter.md (plan mode, 2026-09-14) + the owner's 0.7.0 brief in conversation 2026-09-14
created: 2026-09-14
status: in-progress
---

# Private Browser 0.7.0 "Daily Driver"

## Context

### Owner instruction during planning (verbatim)

> For every decision, choose the best long-term, scalable, secure, and maintainable option yourself.

### The owner's brief (verbatim; its headings demoted)

#### Private Browser 0.7.0 — "Daily Driver" upgrade

#### Mission
Make Private Browser something a person can use all day as their only browser.
Chrome Precision (0.6.0) fixed how the frame looks. This release fixes everyday
friction: right-click, typing in the address bar, lost tabs, memory, logins,
downloads, and opening links from other apps.

Judge every decision by one question: **does this remove a moment where the user
would reach for Chrome instead?**

Stay privacy-first:
- nothing leaves the machine by default
- no telemetry
- remote features are opt-in and labelled

#### Non-negotiable rules
- `SECURITY.md` is a contract. Do not weaken any of these:
  - context isolation
  - the sandbox
  - no preload in remote views
  - the IPC trusted-sender check, `IpcGuard` and `validateIpcArguments`
  - permission prompts
  - Account Space partition isolation
  - Banking restrictions
  - MyVault (no secret ever reaches the renderer)
  - download verification
  - HTTPS warnings
  - cloud AI consent
  - update integrity
- **Account Space isolation applies to every new feature.** Suggestions, history,
  sessions, discarded tabs, site settings and saved passwords never cross Account
  Spaces or workspaces.
- **Banking is always the strictest case.** For each feature, write down what
  Banking does, and test it.
- Every new IPC channel must be:
  - typed in `preload.cts`
  - validated in `ipc-contracts.ts`
  - wired through `handle()`
  - covered by the parity test
  - mocked in `src/preview-api.ts`
- **Read before you touch; update after.** Read the matching `docs/systems/*.md`
  (Agent Brief first) and `docs/follow-ups.md` before touching an area. Update
  the doc in the same change. Put work you deliberately skip in `follow-ups.md`.
- **`npm run check` is the gate.** Nothing is done until it passes.
  - CI runs it on Ubuntu, where fonts and scrollbars differ. Never let content
    overflow the frame; `html, body, #root` use `overflow: clip` for a reason.
- **Only show what works.** No disabled decoration, no fake features.
- **Do not push to `main`.** Pushing publishes a production release. Commit
  locally with the `[autopilot]` trailer and stop before any push unless I
  explicitly authorize publishing in this task.
- **Never capture the whole screen for evidence.** It has leaked another app's
  private data before. Use `webContents.capturePage()` / window-only composites,
  and inspect every image before keeping it. Save images under
  `C:\Users\abuye\.claude\browser\playwright-mcp\private-browser-0.7\`.
- Never print, commit or type credentials, cookies or tokens. Run the secret
  guard before every commit.

#### Phase 0 — Verify before building (report findings, then plan)
Some gaps below come from reading the code, not from running the app. For each
one, confirm or refute it in the code and in a real Electron window, and cite
`file:line`.

Known leads to check:
- the page `context-menu` handler returns early unless a developer target exists
- the address bar has no suggestion list
- `SEARCH_ENDPOINT` is hard-coded to DuckDuckGo
- `render-process-gone` only clears `loading`
- there is no tab discarding
- `vault-broker.saveLogin` exists, but nothing offers to save after a login
- spellcheck is not configured
- it is unknown whether the app is a single-instance app that accepts URLs from
  the command line, and whether it can be registered as the default browser
- it is unknown whether PDFs render in a tab

Then enter plan mode. The plan must include:
- the list of verified gaps
- the slices, in order
- the data format changes, which may only add optional fields that older builds
  ignore
- an `## Irreversible steps` section

#### Tier 1 — Everyday essentials (must ship)
1. **Page right-click menu for everyone.**
   - **Links:** open in new tab, open in another Account Space (same workspace
     only), copy link.
   - **Images:** open in new tab, save image, copy image, copy image address.
   - **Selected text:** copy, search the web for it.
   - **Editable fields:** cut, copy, paste, select all, and spelling suggestions
     with "Add to dictionary".
   - **Page:** back, forward, reload, save page as, print, find.
   - **Development only:** Inspect and View source.
   - **Banking:** no "open in another Account Space", and saving follows download
     policy.
2. **Smart address bar.**
   - As you type, show a keyboard-navigable suggestion list with inline
     autocomplete.
   - Sources: history (ranked by visits and recency), bookmarks, and open tabs
     ("Switch to tab").
   - Shift+Delete removes a history suggestion.
   - Only the active Account Space's data is used.
   - Remote search suggestions are **off by default**, with a clearly labelled
     opt-in, and never in Banking.
   - Show a "Search <engine> for …" row. Paste-and-go works. Esc restores the
     current URL.
3. **Choice of search engine.**
   - Offer DuckDuckGo (default), Google, Bing, Brave, Startpage and Ecosia, plus a
     custom `https://…%s` template validated as HTTPS.
   - Set it in Settings and on first run.
   - Add site keywords (for example `yt cats`) as a stretch goal.
4. **Open links from other apps and set as default browser.**
   - Use a single-instance lock. `second-instance` URLs, and URLs passed on the
     first launch, open in a new tab of the last active non-Banking Account Space.
     If that is ambiguous, a small chooser asks.
   - Register http/https/.html handlers in the NSIS installer (per user).
   - Add a Settings button that opens the Windows default-apps page.
   - Validate every incoming URL with `isAllowedRemoteUrl`.
5. **Tabs that survive.**
   - **Crashed page:** replace the blank tab with a page that says "This page
     crashed" and offers **Reload**. Log it to the privacy log without the URL in
     Banking.
   - **Memory saver:** put a tab to sleep after it has been inactive for a
     configurable time (default 30 min).
     - Never sleep a tab that is audible, capturing media or in full screen.
     - Never sleep a Banking tab with unsaved form input.
   - **Sleeping tabs:** show a dimmed favicon, and reload on click.
   - **Session restore:** load only the active tab at startup; other tabs load
     when first selected.
   - **Memory figure:** show the approximate memory saved on hover.
6. **Better tab management.**
   - Tab context menu: New tab to the right, Reload, Duplicate, Pin/Unpin,
     Mute/Unmute, Close other tabs, Close tabs to the right, Reopen closed tab.
   - **Pinned tabs:** icon-only, kept left, persisted.
   - **Tab groups:** name, colour, collapse and expand, drag tabs in and out.
     Groups are persisted per Account Space.
7. **Offer to save passwords.**
   - After a successful form login, a toolbar bubble asks "Save password for
     site.com?" with Save, Never for this site, and Not now. It also offers to
     update a changed password.
   - Detection runs in the isolated fill layer. The password goes straight to
     MyVault through the broker and is **never** sent to the React chrome.
   - Respect workspace policy, and do nothing when the vault is locked except
     offer to unlock.
   - Never save automatically.
8. **Downloads bubble.**
   - A toolbar download icon shows a progress ring and opens a recent-downloads
     bubble: open, show in folder, cancel, retry.
   - Keep the existing verification and dangerous-file warnings.
   - The full Downloads panel stays.
9. **Per-site controls in site info.**
   - Show and reset permissions (camera, microphone, location, notifications,
     clipboard, popups).
   - Show "Cookies and site data for this site" with a delete button for the
     current Account Space only.
   - Remember zoom per site.
   - Add a Settings → Site settings page listing every site with exceptions.
10. **Spellcheck in pages.** Enable the session spellchecker with a language
    picker in Settings. Its dictionary downloads only after the user enables it.

#### Tier 2 — Power features (ship if Tier 1 is green)
11. **Split view.** Put two tabs of the same Account Space side by side with a
    draggable divider, built on the existing `WebContentsView` layout maths
    (extend `computeChromeLayout`, keep one geometry source). Not in Banking.
12. **Quick commands in the address bar.** Typing `>` lists browser actions (the
    existing `runCommand` ids: settings, history, clear data, toggle theme, and so
    on) and runs them. Add a keyboard shortcut help sheet on Ctrl+/.
13. **Page screenshot.** Capture the visible area or a selected region to the
    clipboard or a file. Disabled on protected pages and in Banking.
14. **Import passwords from a Chrome CSV into MyVault.**
    - Preview and dedupe the entries before saving.
    - Parse in the main process only.
    - Afterwards, tell the user to delete the CSV.
    - Never log contents.
15. **PDF viewing.** If Phase 0 shows PDFs don't render, enable the built-in
    viewer safely, or download with an "Open" action. Document the choice.
16. **Relaunch-to-update.** When an update has been downloaded and verified, the ⋮
    menu shows "Update Private Browser — Relaunch". Show a "What's new" page once
    after updating, built from `CHANGELOG.md`.

#### Tier 3 — Fix known debt (from docs/follow-ups.md; verify each first)
- Block IPv4-mapped IPv6 in `isSafeAiEndpoint`/`isSafeUpdateEndpoint` (decode
  `::ffff:a.b.c.d` before range tests), with tests.
- Make `decodeBase32` reject malformed TOTP secrets, and show a clear error in the
  Vault UI.
- Confirm the shortcut double-fire is gone with the shared `resolveShortcut`
  (input.type), and close or fix the entry.
- Make the Electron Turnstile test order-independent. It passes alone and fails
  when run second; find the navigation that aborts the load.
- Close any follow-ups the 0.6.0 redesign already resolved (the layout triple
  source).

#### Explicitly out of scope (record in follow-ups.md with reasons)
- A Chrome extensions platform. It is a huge attack surface and would need its own
  security design.
- Multiple windows and dragging a tab out into a new window. This needs a
  controller refactor; note the design.
- Cookie or session import from Chrome.
- Page translation through a cloud service.
- Sync of anything beyond the existing encrypted backup.

#### Performance and quality budgets
- Cold start to a usable window: no slower than 0.6.0 (measure both).
- Typing in the address bar: suggestions under 50 ms for 50k history entries.
  Index in main, return at most 8 results.
- 30 open tabs with memory saver on: resident memory at least 40% lower than with
  it off after the idle timeout (measure in Electron).
- Accessibility:
  - every new menu and bubble is keyboard-reachable
  - every new menu and bubble has ARIA roles
  - Esc closes it and focus returns to where it was
  - it works in both themes and in forced colours
  - minimum text size is 11 px

#### Tests (all must be added, not just run)
- **Unit tests:**
  - suggestion ranking and isolation
  - the search template validator
  - the discard eligibility rules (Banking, audio, forms)
  - context menu model per workspace
  - password-capture state machine
  - URL intake from the command line
  - IPv6 predicate
  - base32 rejection
  - data migration (new optional fields; old builds ignore them)
- **Browser e2e (preview mock):** omnibox keyboard flow, tab context menu, pinned
  tabs and groups, downloads bubble, site settings, quick commands.
- **Real Electron:**
  - right-click on a local HTTPS fixture
  - crash recovery via `forcefullyCrashRenderer`
  - discard and restore
  - second-instance URL opening
  - password save bubble (fixture login form, throwaway profile, fake
    credentials generated in the test, never real ones)
  - split-view bounds
- Every Electron test uses a throwaway `PRIVATE_BROWSER_E2E_USER_DATA` profile and
  must pass when run alone and in the full suite.

#### Visual verification
Test in the real Electron window at these sizes and states:
- 1920×1080
- 1366×768
- maximized
- dark and light themes
- Banking
- two Account Spaces

Take window-only captures of each Tier 1 surface, check each image, then delete
anything that shows real data.

#### Release preparation (no publishing)
- Bump the version to 0.7.0 and add the `CHANGELOG.md` entry.
- Add a `docs/history/` change story.
- Update the docs and bump the `Last verified` dates.
- Pass `npm run check`.
- Run the secret scan.
- Make local commits per slice with the `[autopilot]` trailer.
- Stop before pushing and ask me.

#### Final report
1. Which verified gaps were fixed, with before and after.
2. What was deferred and why.
3. Security review of every new channel and data flow.
4. Test counts and gate result.
5. Measured performance numbers against the budgets.
6. Screenshot list.
7. Remaining risks.
8. Exactly what publishing would ship.

### The approved plan (verbatim; headings demoted so this file keeps one Context section)

#### Private Browser 0.7.0 — "Daily Driver"

#### Context

0.6.0 fixed how the frame looks. 0.7.0 removes the everyday moments where a user
reaches for Chrome: right-click, typing in the address bar, lost or crashed tabs,
memory, saving logins, downloads, links from other apps. Privacy-first: nothing
leaves the machine by default, remote features are opt-in and labelled, Banking is
always the strictest case, and SECURITY.md is not weakened anywhere.

All decisions below were made on the owner's instruction to pick the most
maintainable, scalable, secure option without asking.

- - -

#### Phase 0 — verified findings (code + real Electron window)

Runtime evidence came from two probes of the built app (`dist-electron`, built
19:40 on 2026-09-14, three minutes before HEAD `f283826`, whose only change is
renderer CSS) with throwaway profiles under the session scratchpad. No images
were taken.

| Lead | Verdict | Evidence |
|---|---|---|
| Page `context-menu` returns unless a developer target exists | **Confirmed** | [main.ts:2026-2036](electron/main.ts#L2026); live: a real right-click in the DigiTronics workspace built no menu |
| Address bar has no suggestion list | **Confirmed** | [NavigationToolbar.tsx:69-78](src/shell/NavigationToolbar.tsx#L69) has no keydown/Esc/paste handling; live: 0 `listbox`/`option` elements after typing |
| `SEARCH_ENDPOINT` hard-coded to DuckDuckGo | **Confirmed** | [security.ts:1](electron/security.ts#L1), used at [:32](electron/security.ts#L32) |
| `render-process-gone` only clears `loading` | **Confirmed** | [main.ts:2054](electron/main.ts#L2054); live: after `forcefullyCrashRenderer` the tab keeps its URL, the view is blank, the chrome shows no message |
| No tab discarding | **Confirmed** | no discard/sleep code in `electron/` or `src/`; views are only destroyed on close ([main.ts:488-492](electron/main.ts#L488)) |
| `saveLogin` exists but nothing offers to save after login | **Partly refuted** | a *manual* "Save from page" capture exists ([main.ts:1730-1746](electron/main.ts#L1730), [isolated-fill.ts:96-110](electron/myvault/isolated-fill.ts#L96), comment: "No automatic post-submit capture exists"). No automatic offer after a login. The password never reaches React |
| Spellcheck not configured | **Refuted as stated** | not configured in code, but Electron's default is on: live `isSpellCheckerEnabled()=true`, languages `en-US`, no `Dictionaries` folder in a fresh profile (Windows built-in checker). Squiggles exist; suggestions are unreachable because there is no page menu |
| Single-instance app accepting command-line URLs | **Exists, with a security gap** | lock [main.ts:2397](electron/main.ts#L2397), `second-instance` [:2402-2406](electron/main.ts#L2402), first launch [:2386](electron/main.ts#L2386)/[:2604](electron/main.ts#L2604). Live: works, but opens in the **active** workspace, and **opened inside Banking** when Banking was active |
| Can be registered as default browser | **Exists but ineffective** | `setAsDefaultProtocolClient` [main.ts:1777-1781](electron/main.ts#L1777) cannot change the default on Windows 10/11 (the per-user choice is protected), and in development it registers `electron.exe`. The installer declares no `Capabilities`/`RegisteredApplications`, so Windows cannot list the app (`package.json` build has no protocols/include) |
| PDFs render in a tab | **Refuted — they render** | live: the built-in viewer frame `chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai` loaded, no download, 43 distinct sampled colours in the captured view |

Additional gaps found while verifying (not in the brief):

1. **No IPC parity test exists.** [tests/ipc-contract.test.ts](tests/ipc-contract.test.ts) only tests dialog parsing. `validateIpcArguments` returns silently for any unlisted channel ([ipc-contracts.ts:146](electron/ipc-contracts.ts#L146)), so roughly 80 of about 120 channels are unvalidated. The preview mock is cast `as unknown as PrivateBrowserApi` ([preview-api.ts:185](src/preview-api.ts#L185)), so a missing mock is not a type error.
2. **History cap crosses Account Spaces.** `state.history.slice(0, 2500)` over all spaces ([main.ts:2342](electron/main.ts#L2342)), so one busy space evicts another's history.
3. **Every state change rewrites every file.** `RuntimeStateStore.update` structured-clones the whole state and synchronously writes every account file plus the manifest ([runtime-state-store.ts:57-65, 137-163](electron/runtime-state-store.ts#L57)). A title change rewrites all history. This blocks the 50k-history budget.
4. **Downloads leak across Account Spaces in the renderer.** The snapshot sends every space's downloads ([main.ts:343](electron/main.ts#L343)); the panel does not filter. There is no cancel or retry.
5. **Session restore already loads only the active tab.** Views are created lazily ([main.ts:2227-2237](electron/main.ts#L2227)). The requirement holds; it gets a test, not new code.

Tier 3 leads:

| Lead | Verdict | Evidence |
|---|---|---|
| IPv4-mapped IPv6 in `isSafeAiEndpoint` | **Already fixed; follow-up stale** | `/^::ffff:/` blocks [security.ts:201](electron/security.ts#L201), test [security.test.ts:89](tests/security.test.ts#L89). Still open: IPv4-compatible `[::127.0.0.1]`→`::7f00:1`, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`, `fec0::/10`, `100.64/10`, `0/8`, `198.18/15`, multicast/reserved |
| `decodeBase32` accepts malformed secrets | **Confirmed** | [vault.ts:3-9](electron/vault.ts#L3): invalid characters stripped before the unreachable throw |
| Shortcut double-fire | **Fixed in code** | `input.type !== 'keyDown'` guard [main.ts:2370](electron/main.ts#L2370), shared `resolveShortcut` in both halves ([App.tsx:275](src/App.tsx#L275)). Needs one Electron check, then both shortcut follow-ups close |
| Turnstile test order dependence | **Plausible cause found** | it launches with `--user-data-dir=` instead of `PRIVATE_BROWSER_E2E_USER_DATA` ([account-spaces.spec.ts:41](tests/electron/account-spaces.spec.ts#L41)), so profile and the single-instance lock may be shared between tests; it also awaits a `loadURL` that can reject with `ERR_ABORTED`, which its sibling test tolerates and it does not |
| Layout triple source | **Resolved by 0.6.0** | renderer and main both derive from `computeChromeLayout` ([chrome-layout.ts:102](electron/chrome-layout.ts#L102), [App.tsx:4,128](src/App.tsx#L128)) |

- - -

#### Decisions (made, not open)

- **Page right-click menu is a native Electron `Menu` built in main** from a pure, tested model (`buildPageContextMenuModel(params, policy)`). Link URLs, selections and misspellings never cross to the renderer. Native menus sit above the page with no freeze-frame and are OS-accessible (UI Automation, Esc, forced colours).
- **Tab, download, password and omnibox surfaces are React**, built on the existing `MenuSurface`/`useOverlayLayer` (ARIA roles, Esc, focus return already exist).
- **Suggestions are indexed in main** by a per-Account-Space in-memory index (visit count + recency), queried over one validated channel, at most 8 results. Nothing but the active space is ever queried.
- **History stays in the same file and field**, capped at **10,000 per Account Space** (the 0.6.0 load cap, so a downgrade loses nothing). 50k total = five or more spaces; the index is benchmarked at 50k.
- **Persistence becomes change-tracked**: only files whose content changed are written, coalesced on a short timer, flushed synchronously on quit, recovery actions and account deletion. One writer per file stays.
- **IPC channels move to one declarative registry** (`electron/ipc-channels.ts`): every channel has a validator, and an unknown channel throws. A new parity test proves preload ↔ `handle()` ↔ registry ↔ preview mock.
- **Remote search suggestions** are off by default, fetched by main through a non-persistent, cookieless partition, never in Banking, never for URL-like input, and offered only for engines whose endpoint is verified working. Otherwise the toggle is hidden for that engine.
- **Outside links** open in the active workspace's Account Space when that workspace is not Banking. When Banking is active they go to the last-used non-Banking Account Space; if none is recorded and several exist, a chooser asks. They never land in Banking.
- **Default browser**: the installer registers per-user `Capabilities` (http/https URL associations) and `RegisteredApplications`; Settings opens `ms-settings:defaultapps`. The ineffective `setAsDefaultProtocolClient` path is removed. **No `.html` file association**: opening local files needs `file:` navigation in remote views, which SECURITY.md forbids ("views reach http/https only"). Recorded in follow-ups.
- **Memory saver** destroys an idle tab's view, keeping its navigation entries in main memory (`navigationHistory.getAllEntries`), and restores them with `navigationHistory.restore` on selection. Not eligible: active or split-visible tab, audible, holding a granted camera/microphone/display capture, full screen, dirty form input (any workspace), pinned while playing. **Banking**: eligible only with no form input, and its saved `pageState` is discarded (form data could be sensitive), so it restores URL and title only.
- **Crashed tab**: the view is hidden and the chrome draws "This page crashed" with **Reload** in the page area. No `data:` page is ever loaded into a remote view.
- **Password save**: an isolated-world listener stores the submitted values in isolated-world memory and pings main through a per-document secret nonce on the console. Main pulls the values out of the isolated world, holds them in a main-only pending capture bound to tab, navigation generation, workspace, Account Space and origin, and decides success by the state machine below. The React bubble receives only origin, username and "new vs update". **Saved passwords stay in the single MyVault vault**: scoping entries per Account Space would change the MyVault payload contract shared with the MyVault app ([COMPATIBILITY.md](electron/myvault/COMPATIBILITY.md)). The pending capture, bubble and "Never for this site" list are per Account Space. Recorded in follow-ups.
- **Per-site settings** (zoom, never-save-password) live in the **encrypted** Account Space record, not plaintext state.
- **Spellcheck** stays on by default with the Windows built-in checker (no network, as verified). Settings adds an on/off switch and language picker. A language that needs a downloaded dictionary shows a labelled one-time consent. Until consent, the download URL points at a local sentinel so nothing is fetched. In Banking, suggestions show but "Add to dictionary" does not (it writes a plaintext word list).
- **PDF**: keep Chromium's built-in viewer (it already works). Banking still blocks its Save through the download policy. Documented and tested.
- **Relaunch-to-update** re-verifies the installer's SHA-256 against the manifest immediately before running it (`spawn`, no shell), then quits. "What's new" is built from the bundled `CHANGELOG.md`, rendered as plain text, shown once per version.
- **New code goes in new modules**, not `main.ts` (already 2,621 lines). The controller gains thin delegation only. Each new file is claimed by one doc's `sources:`.

- - -

#### Banking behaviour per feature

| Feature | Banking |
|---|---|
| Page menu | No "Open in another Account Space", no "Search the web for…", no Inspect/View source; Save image/page follows download policy (blocked); no "Add to dictionary" |
| Omnibox | Local suggestions from Banking's own space only; remote suggestions never; quick commands allowed |
| Search engine | Same engine; searching from Banking is allowed (the page is Banking-partitioned) |
| Outside links | Never open in Banking |
| Crash page | Shown; privacy log entry omits the URL |
| Memory saver | Only without form input; `pageState` dropped |
| Tab menu | No Duplicate into another space; Reopen closed tab stays disabled (closed Banking tabs are not recorded today) |
| Password bubble | Never (policy `saveCapture: false`) |
| Downloads bubble | Shows nothing (downloads blocked) |
| Site controls | All permissions show "Blocked by Banking"; cookie delete allowed |
| Spellcheck | Suggestions only |
| Split view, screenshot | Not available |
| CSV import | Not into Banking |

- - -

#### Data format changes (optional fields only; 0.6.0 ignores them)

0.6.0's loaders rebuild manifests, tabs and account records from allow-lists, so
unknown fields are **dropped, never rejected**. A downgrade loses the new
settings, pins, groups and site zoom, and never enters recovery. This is proven
by a test that runs verbatim copies of 0.6.0's validators (from `f283826`)
against 0.7.0 files.

| File | New optional field |
|---|---|
| `browser-state-v2.json` manifest | `settings?: { searchEngine, customSearchTemplate?, siteKeywords?, remoteSuggestions, memorySaver: { enabled, idleMinutes }, spellcheck: { enabled, languages }, firstRunDone? }`, `lastExternalAccountSpaceId?`, `lastSeenVersion?` |
| `account-browsing/<id>.json` | tab `pinned?`, tab `groupId?`, `tabGroups?: [{ id, title, color, collapsed }]` (history unchanged, per-account cap 10,000) |
| `account-spaces/<id>.account.enc` (encrypted) | `siteSettings?: [{ origin, zoomPercent?, neverSavePassword? }]` (cap 500) |
| Memory only, never persisted | suggestion index, discarded-tab navigation entries, pending password capture, pending URL intake, CSV import preview, downloads, crash state |

- - -

#### Slices, in order

Each slice ends with its tests green and a local commit carrying the
`[autopilot]` trailer, after `npm run secrets:check`. Doc updates land in the same
commit. `npm run check` runs at the end of every slice from S2 on, and in full
before Tier 2 and before release. Subagents that touch code are told: no push, no
deploy, report in plain English.

**S0 — Baseline and foundations**
1. Rebuild HEAD and measure 0.6.0 cold start (5-run median) and resident memory for 30 fixture tabs, before any change.
2. Registry `electron/ipc-channels.ts` covering every channel; `validateIpcArguments` throws on unknown channels; `handle()` unchanged otherwise.
3. Parity test `tests/ipc-parity.test.ts`: channel sets from `preload.cts` invokes, `main.ts` `handle()` calls, registry keys and events table must match; the preview mock is typed per `PrivateBrowserApi` key, with no cast.
4. Change-tracked persistence in `RuntimeStateStore`, per-account history cap, flush on quit.
5. `electron/omnibox/history-index.ts` (pure) with its benchmark test.

**S1 — Tier 3 debt**
IPv6/IPv4 private-range predicate rewritten around a decoded address, with tests. `decodeBase32` rejects invalid input, and the vault dialog shows "This authenticator key isn't valid". Electron shortcut test (Ctrl+T in page focus makes exactly one tab). Turnstile spec moved to `PRIVATE_BROWSER_E2E_USER_DATA`; run alone and in full order to prove it; root cause recorded. Close the stale follow-ups (IPv4-mapped, both shortcut entries, layout triple source).

**S2 — Search engines, smart address bar, quick commands** (T1.2, T1.3, T2.12)
- `electron/omnibox/search-engines.ts`: presets and HTTPS `%s` template validator; `normalizeNavigationInput` takes the engine.
- `electron/browser-settings.ts` with `settings:get/set`.
- Channel `omnibox:suggest(text, requestId)`, returning history, bookmarks and open-tab rows for the active space plus the "Search <engine> for …" row. Remote rows only when opted in.
- `omnibox:remove-history(url)` for Shift+Delete.
- `src/shell/OmniboxPopup.tsx`: `combobox`/`listbox`, arrows, Enter, Esc restores the URL, inline autocomplete, paste-and-go.
- `>` lists `runCommand` ids; Ctrl+/ shortcut help sheet (new `shortcut-help` command in `resolveShortcut`).
- First-run engine chooser; Settings section; site keywords (`yt cats`).
- History panel full search via the index (closes that follow-up).

**S3 — Page context menu and spellcheck** (T1.1, T1.10)
`electron/page-context-menu.ts` model per workspace; controller actions (open in new tab, open in another Account Space via submenu of same-workspace spaces, copy link/image/address, save image via `downloadURL` so policy applies, search selection, edit commands, spelling suggestions and add-to-dictionary, back/forward/reload/save page as/print/find, Inspect/View source in Development). Spellcheck settings and download sentinel.

**S4 — Links from other apps, default browser** (T1.4)
`electron/url-intake.ts`: pure `parseLaunchUrls(argv)` and `chooseIntakeTarget(state)`. `second-instance`, first launch and a queued intake before the window exists. Chooser dialog over `intake:resolve(intakeId, accountSpaceId)`. `build/installer.nsh` via `nsis.include` (per-user registration on install, removal on uninstall). `system:open-default-apps`; default-browser status read from the per-user choice through `reg query` without a shell.

**S5 — Tabs that survive** (T1.5)
Crash state and chrome crash page with Reload; privacy log (no URL in Banking). `electron/memory-saver.ts`: pure eligibility plus a scheduler (checks every minute; configurable idle time, default 30 min; unpackaged-only environment override for tests, gated like `PRIVATE_BROWSER_E2E_USER_DATA`). Dirty-form probe in the isolated world returns a boolean only. Sleeping tabs dimmed; memory saved on hover (renderer process memory recorded before discard).

**S6 — Tab management** (T1.6)
Tab context menu (New tab to the right, Reload, Duplicate, Pin/Unpin, Mute/Unmute, Close other tabs, Close tabs to the right, Reopen closed tab; Shift+F10 and the menu key). Pinned tabs icon-only, kept left, persisted. Groups: name, colour, collapse, drag in and out, persisted per Account Space. Pure tab-order operations extend `moveTabWithinAccountSpace` in [bookmark-tree.ts](electron/bookmark-tree.ts).

**S7 — Offer to save passwords** (T1.7)
`electron/myvault/login-capture.ts` state machine:
`idle → submitted(captured) → navigated → evaluate`
- A navigation or in-page navigation within 30 s where the login form is gone gives `offer`.
- The same form still visible, or a timeout with the form still present, gives `discard`.
- Any change of tab, generation, Account Space or workspace gives `discard`.

Pending captures expire after 2 minutes and are cleared on vault lock.

Outcomes:
- **Offer**: bubble "Save password for site.com?" or "Update password?" with Save / Never for this site / Not now.
- **Vault locked**: the bubble offers Unlock, which opens the secure unlock dialog, then saves.
- **Policy off, Banking or Development**: nothing.

Save goes `VaultBroker.saveLogin` directly. It never saves automatically.

**S8 — Downloads bubble** (T1.8)
Toolbar icon with a progress ring (only while there are downloads in this space), bubble of recent downloads: open, show in folder, cancel, retry/resume (`canResume`, else `downloadURL` in the same partition). Snapshot downloads are filtered to the active space (fixes finding 4). Verification and danger warnings unchanged; full panel stays.

**S9 — Per-site controls** (T1.9)
Site info shows and resets this space's grants for the capabilities that exist (camera, microphone, notifications, clipboard, display capture, downloads). Geolocation shows "Always blocked"; there is no popup permission model, so no popup row. "Cookies and site data for this site", with counts and delete, for this space's partition only (`cookies.get`/`clearStorageData({ origin })`). Zoom remembered per site. Settings → Site settings lists every site with exceptions, per space.

**Tier 2 gate** — full `npm run check` green on Tier 1 before starting S10.

**S10 — Split view** (T2.11): `computeChromeLayout` returns a primary and a secondary rect from a ratio; one geometry source; keyboard-operable divider (`role="separator"`); same space only; not in Banking.

**S11 — Page screenshot** (T2.13): visible area or dragged region over the freeze-frame, to clipboard (`clipboard.writeImage` in main) or file; region validated in main; refused for protected pages and Banking.

**S12 — Chrome CSV import** (T2.14): `vault:csv-preview` parses in main and holds rows under a 5-minute token (returns origin, username and duplicate status only); `vault:csv-commit(token, rowIds)`; contents never logged; the completion screen tells the user to delete the CSV.

**S13 — PDF** (T2.15): Electron test for render; Banking save blocked; documented.

**S14 — Relaunch-to-update and What's new** (T2.16): ⋮ "Update Private Browser — Relaunch" once the verified installer exists; re-verify, run, quit. What's new shown once from the bundled changelog.

**S15 — Release preparation**
- Version 0.7.0 and the CHANGELOG entry.
- `docs/history/2026-09-xx-daily-driver.md`.
- System docs merged, each with its `Last verified:` bumped: browser-shell, ipc-contract, renderer-ui, workspaces-and-state, security-boundary, vault, release-and-updates.
- SECURITY.md sections for each new surface.
- follow-ups.md: deferrals added, closed entries removed.
- Performance measurements.
- Visual captures.
- Final `npm run check` and secret scan.
- Stop and ask before any push.

- - -

#### Explicitly out of scope → follow-ups.md with reasons

- Chrome extensions: a large attack surface that needs its own security design.
- Multiple windows and tab tear-off: `BrowserController` owns one window. Design note: a `WindowController` per window owning views, layout and overlay state, with the trusted-sender check widened to a set of chrome webContents.
- Cookie and session import: undermines partition isolation.
- Cloud page translation: page text leaving the device.
- Sync beyond the encrypted backup.
- `.html` file association: needs `file:` in remote views.
- Per-Account-Space vault scoping: MyVault protocol change.
- Popup permission row: no popup model exists.

- - -

#### Tests added

**Unit (vitest):**
- suggestion ranking and isolation (including a 50k-entry timing test)
- search template validator and keywords
- memory-saver eligibility (Banking, audio, capture, full screen, forms)
- page menu model per workspace
- login-capture state machine
- `parseLaunchUrls` and intake target
- IPv6/IPv4 predicate
- base32 rejection
- IPC registry and parity
- change-tracked persistence
- migration: new fields optional, 0.6.0 validator copies accept 0.7.0 files

**Browser e2e (preview mock):** omnibox keyboard flow, tab context menu, pinned tabs and groups, downloads bubble, site settings, quick commands and shortcut help.

**Real Electron**, each with its own throwaway `PRIVATE_BROWSER_E2E_USER_DATA`, passing alone and in the full suite:
- right-click on the local HTTPS fixture (menu model captured by intercepting `Menu.buildFromTemplate`)
- crash recovery via `forcefullyCrashRenderer`
- discard and restore (navigation entries back)
- second-instance URL opening, including Banking active
- password save bubble (fixture login form, credentials generated in-test)
- split-view bounds
- PDF render
- spellcheck makes no dictionary fetch (download host mapped to a counting local server)
- shortcut single fire
- memory budget

#### Performance and quality budgets — how each is measured

- **Cold start**: Electron launch until the address bar is focusable and the first state has arrived; 5-run median, 0.6.0 build from S0 against 0.7.0, same machine. Must not be slower.
- **Suggestions**: index query p95 under 50 ms at 50k entries (unit), plus the IPC round trip in Electron; at most 8 rows.
- **Memory**: 30 fixture tabs, idle override to about 1 minute; sum of `app.getAppMetrics()` working sets with memory saver off, then on. Must be at least 40% lower.
- **Accessibility**: keyboard-only e2e for every new menu and bubble; ARIA roles asserted; Esc and focus-return asserted; both themes and `forced-colors` emulation screenshots; no font below 11 px (existing token scale).

#### Visual verification

- Real Electron window at 1920×1080, 1366×768 and maximized; dark and light; Banking; two Account Spaces.
- Window-only captures: `BrowserWindow.capturePage()` composited with the page view's `capturePage()`, never a screen grab.
- Fixture pages and generated fake data only, in throwaway profiles.
- Saved to `C:\Users\abuye\.claude\browser\playwright-mcp\private-browser-0.7\`; every image opened and inspected; any showing real data deleted.
- The preview mock is also shown in VS Code Simple Browser for visibility. The receipt file is checked, and it is reported separately from the Playwright runs.

#### Assumptions (a false one stops the run)

- Electron 44.3.0 provides `navigationHistory.getAllEntries/restore` with `pageState`, spellchecker session APIs and `DownloadItem.canResume` (confirmed in `electron.d.ts`).
- Windows uses its built-in spellchecker for `en-US` with no download (a fresh profile had no `Dictionaries` folder; S3 proves it with a network test).
- 0.6.0 loaders drop unknown fields rather than reject them (confirmed at [account-space-state.ts:348-390](electron/account-space-state.ts#L348) and [account-store.ts:326-348](electron/account-store.ts#L326)).
- CI (Ubuntu, xvfb) can run the new Electron tests; Windows-only ones (registry, default apps) skip elsewhere with a stated reason.
- The build at probe time matched HEAD for main-process behaviour.

#### Irreversible steps

- **Test queries to search-suggestion services**: one harmless fixed query ("weather") per engine to Google, Bing, DuckDuckGo, Brave, Startpage and Ecosia, to confirm each endpoint before offering its toggle. These requests are received by those companies and cannot be recalled.
- **Deleting evidence images** under `private-browser-0.7\` that show real data: permanently removed.
- **Deleting throwaway test profiles** in the temp and scratchpad folders after runs: permanently removed. They contain only fixture data.

Not done in this run: no push, no tag, no deploy, no installer run on this machine (it would change this machine's default-app registration), no change to the MyVault format, no real credentials anywhere.

- - -
goal: Run this end-to-end on autopilot. Decide everything yourself, don't
ask for confirmation, and only report back when it's finished.

## Steps

<!-- S0 — Baseline and foundations -->
- [ ] 1. S0 Measure 0.6.0 baselines on a fresh HEAD build: cold start (5-run median, launch → address bar focusable with first state) and resident memory of 30 fixture tabs — done when: both numbers and the method are written in the Ledger — check: `manual: Ledger line with the two 0.6.0 numbers`
- [ ] 2. S0 One declarative IPC channel registry; every registered channel has a validator and an unknown channel throws — done when: `validateIpcArguments('nope:x', [])` throws and every existing channel has an entry — check: `npx vitest run tests/ipc-parity.test.ts tests/ipc-account-spaces.test.ts tests/ui-preferences.test.ts`
- [ ] 3. S0 IPC parity test: preload invoke channels = `handle()` channels = registry keys = event table; preview mock typed per API key with no cast — done when: removing any one side makes the test fail — check: `npx vitest run tests/ipc-parity.test.ts && npm run typecheck`
- [ ] 4. S0 Change-tracked persistence (only changed files written, flushed on quit) and a per-Account-Space history cap of 10,000 — done when: a title change writes one account file, and a busy space no longer evicts another's history — check: `npx vitest run tests/state-migration.test.ts tests/runtime-state-persistence.test.ts`
- [ ] 5. S0 Per-Account-Space history index (visits + recency) with a 50k-entry benchmark — done when: p95 query under 50 ms at 50k entries and results never include another space — check: `npx vitest run tests/history-index.test.ts`

<!-- S1 — Tier 3 debt -->
- [ ] 6. S1 Private-address predicate decodes IPv6 forms (IPv4-mapped, IPv4-compatible, NAT64, 6to4) and blocks the missing IPv4 ranges — done when: `[::127.0.0.1]`, `[64:ff9b::a00:1]`, `[2002:7f00:1::]`, `100.64.0.1`, `0.1.2.3` are refused and public hosts pass — check: `npx vitest run tests/security.test.ts`
- [ ] 7. S1 `decodeBase32` rejects malformed TOTP secrets; the vault editor shows a clear error — done when: `"not a secret!!!"`, `"####"` and `""` throw, and saving such a secret reports "This authenticator key isn't valid" — check: `npx vitest run tests/vault-migration.test.ts tests/totp-validation.test.ts`
- [ ] 8. S1 Confirm shortcut single fire in a real Electron page and close both shortcut follow-ups — done when: Ctrl+T with page focus creates exactly one tab — check: `npx playwright test --config playwright.electron.config.ts tests/electron/shortcuts.spec.ts`
- [x] 9. S1 Make the Turnstile Electron test order-independent — done when: the spec passes run alone and run after the rest of its file, with the root cause in the Ledger — check: `npx playwright test --config playwright.electron.config.ts tests/electron/account-spaces.spec.ts`
- [ ] 10. S1 Close follow-ups already resolved (IPv4-mapped entry, layout triple source) — done when: `docs/follow-ups.md` no longer lists them and the docs guard passes — check: `node scripts/docs-guard.mjs`

<!-- S2 — Search engines, smart address bar, quick commands -->
- [ ] 11. S2 Search engine presets, HTTPS `%s` template validator, site keywords, and browser settings stored in the manifest `settings` field with `settings:get/set` — done when: typed input searches the chosen engine and invalid templates are refused — check: `npx vitest run tests/search-engines.test.ts tests/browser-settings.test.ts`
- [ ] 12. S2 `omnibox:suggest` and `omnibox:remove-history` in main (active space only, at most 8 rows, "Search <engine> for …" row); remote suggestions opt-in through a cookieless partition, never in Banking, offered only for endpoints verified live — done when: suggestions never include another space, and Banking never fetches remotely — check: `npx vitest run tests/omnibox-suggestions.test.ts`
- [ ] 13. S2 Address bar suggestion popup: combobox/listbox, arrows, Enter, Esc restores the URL, inline autocomplete, Shift+Delete, paste-and-go — done when: the keyboard flow works in the preview — check: `npx playwright test tests/e2e/omnibox.spec.ts`
- [ ] 14. S2 Quick commands after `>` and the Ctrl+/ shortcut help sheet — done when: `>theme` runs the theme toggle and Ctrl+/ opens a dialog that Esc closes with focus returned — check: `npx playwright test tests/e2e/omnibox.spec.ts -g "quick commands|shortcut help"`
- [ ] 15. S2 First-run search engine chooser and the Settings search section — done when: a fresh profile asks once and Settings changes the engine — check: `npx playwright test tests/e2e/omnibox.spec.ts -g "search engine"`
- [ ] 16. S2 History panel searches the full history through the index — done when: an entry older than the newest 100 is found by search — check: `npx vitest run tests/history-index.test.ts && npx playwright test tests/e2e/chrome-shell.spec.ts`

<!-- S3 — Page context menu and spellcheck -->
- [ ] 17. S3 Page right-click menu for every workspace from a pure model (links, images, selection, editable, page, Development-only tools, Banking rules) — done when: the model test covers each workspace and a real right-click on an HTTPS fixture builds the expected menu — check: `npx vitest run tests/page-context-menu.test.ts && npx playwright test --config playwright.electron.config.ts tests/electron/page-context-menu.spec.ts`
- [ ] 18. S3 Spellcheck on/off and language picker; dictionary download only after consent; no "Add to dictionary" in Banking — done when: a fresh profile makes no dictionary request and misspellings show suggestions in the menu — check: `npx playwright test --config playwright.electron.config.ts tests/electron/spellcheck.spec.ts`

<!-- S4 — Links from other apps, default browser -->
- [ ] 19. S4 URL intake: first-launch and second-instance URLs validated and routed to the last non-Banking Account Space, with a chooser when ambiguous — done when: a second instance opens the URL outside Banking even while Banking is active — check: `npx vitest run tests/url-intake.test.ts && npx playwright test --config playwright.electron.config.ts tests/electron/url-intake.spec.ts`
- [ ] 20. S4 Per-user NSIS registration (Capabilities, RegisteredApplications, URL associations) and a Settings button opening Windows default apps — done when: the installer script is included by the build config, and Settings opens `ms-settings:defaultapps` through a validated channel — check: `npx vitest run tests/packaging-security.test.ts tests/default-browser.test.ts`

<!-- S5 — Tabs that survive -->
- [ ] 21. S5 Crashed tab shows "This page crashed" with Reload; privacy log without URL in Banking — done when: after `forcefullyCrashRenderer` the message shows and Reload brings the page back — check: `npx playwright test --config playwright.electron.config.ts tests/electron/tab-lifecycle.spec.ts -g crash`
- [ ] 22. S5 Memory saver: eligibility rules and scheduler; discard keeps navigation entries in memory; restore on select; Banking drops page state — done when: an idle tab's renderer is gone, and selecting it restores URL and back history — check: `npx vitest run tests/memory-saver.test.ts && npx playwright test --config playwright.electron.config.ts tests/electron/tab-lifecycle.spec.ts -g discard`
- [ ] 23. S5 Sleeping tabs dimmed with memory saved on hover; startup loads only the active tab — done when: a sleeping tab renders dimmed with a memory tooltip and a restart creates one page view — check: `npx playwright test --config playwright.electron.config.ts tests/electron/tab-lifecycle.spec.ts -g "sleeping|restore"`

<!-- S6 — Tab management -->
- [ ] 24. S6 Tab context menu (New tab to the right, Reload, Duplicate, Pin/Unpin, Mute/Unmute, Close others, Close to the right, Reopen closed) with keyboard access — done when: every item works in the preview and Shift+F10 opens it — check: `npx playwright test tests/e2e/tab-management.spec.ts -g "context menu"`
- [ ] 25. S6 Pinned tabs icon-only, kept left, persisted per Account Space — done when: a pinned tab stays left after reorder and survives restart — check: `npx vitest run tests/tab-order.test.ts && npx playwright test tests/e2e/tab-management.spec.ts -g pinned`
- [ ] 26. S6 Tab groups: name, colour, collapse and expand, drag in and out, persisted per Account Space — done when: a group round-trips through persistence and collapses in the strip — check: `npx vitest run tests/tab-order.test.ts && npx playwright test tests/e2e/tab-management.spec.ts -g groups`

<!-- S7 — Offer to save passwords -->
- [ ] 27. S7 Login-capture state machine in main (submit, navigate, evaluate; bound to tab, generation, space, workspace, origin; expiry; lock clears) — done when: success, failed login, context change and expiry are all unit-tested — check: `npx vitest run tests/login-capture.test.ts`
- [ ] 28. S7 Password save bubble end to end (Save, Never for this site, Not now, update, locked-vault unlock offer; never Banking or Development; password never in renderer) — done when: a fixture login with generated fake credentials offers once and Save stores it — check: `npx playwright test --config playwright.electron.config.ts tests/electron/password-save.spec.ts`

<!-- S8 — Downloads bubble -->
- [ ] 29. S8 Toolbar downloads icon with progress ring and bubble (open, show in folder, cancel, retry/resume), downloads filtered to the active space — done when: the bubble works by keyboard in the preview and a cancelled download retries in Electron — check: `npx playwright test tests/e2e/downloads-bubble.spec.ts && npx vitest run tests/downloads.test.ts`

<!-- S9 — Per-site controls -->
- [ ] 30. S9 Site info shows and resets this space's permissions, cookies and site data for this site with delete, and zoom remembered per site (stored in the encrypted account record) — done when: resetting a grant and deleting site data affect only this space — check: `npx vitest run tests/site-settings.test.ts`
- [ ] 31. S9 Settings → Site settings lists every site with exceptions, per space — done when: the page lists and resets exceptions in the preview — check: `npx playwright test tests/e2e/site-settings.spec.ts`
- [ ] 32. Tier 1 gate: the full project gate passes before any Tier 2 work — done when: `npm run check` exits 0 — check: `npm run check`

<!-- Tier 2 -->
- [ ] 33. S10 Split view from one geometry source with a keyboard-operable divider; same space only; not in Banking — done when: both views sit exactly in the computed rects at several ratios — check: `npx vitest run tests/chrome-layout.test.ts && npx playwright test --config playwright.electron.config.ts tests/electron/split-view.spec.ts`
- [ ] 34. S11 Page screenshot of the visible area or a region to clipboard or file; refused on protected pages and Banking — done when: capture works on a fixture and is refused in Banking — check: `npx vitest run tests/page-screenshot.test.ts`
- [ ] 35. S12 Chrome CSV import with preview and dedupe before saving, parsed in main, contents never logged, delete-the-CSV reminder — done when: preview shows duplicates and commit imports only selected rows — check: `npx vitest run tests/vault-migration.test.ts tests/csv-import-preview.test.ts`
- [ ] 36. S13 PDF viewing kept on Chromium's built-in viewer, tested and documented; Banking save blocked — done when: an Electron test sees the viewer frame render a fixture PDF — check: `npx playwright test --config playwright.electron.config.ts tests/electron/pdf.spec.ts`
- [ ] 37. S14 "Update Private Browser — Relaunch" once a verified installer exists (re-verified before running), and What's new shown once per version from the bundled changelog — done when: the menu item appears only for a verified installer and What's new appears once — check: `npx vitest run tests/update-relaunch.test.ts tests/whats-new.test.ts`

<!-- S15 — Release preparation -->
- [ ] 38. S15 Data-migration test: 0.7.0 files load in verbatim copies of 0.6.0 validators, and 0.6.0 files load in 0.7.0 — done when: both directions pass — check: `npx vitest run tests/state-downgrade.test.ts`
- [ ] 39. S15 Measure 0.7.0 against the budgets (cold start vs step 1, suggestions at 50k, memory 30 tabs off vs on) — done when: numbers are in the Ledger and each budget is met or its miss is stated — check: `manual: Ledger lines with 0.7.0 numbers beside the 0.6.0 baselines`
- [ ] 40. S15 Window-only visual captures of every Tier 1 surface at 1920×1080, 1366×768 and maximized, dark and light, Banking, two Account Spaces; every image inspected — done when: the image list is in the Ledger and no image shows real data — check: `manual: list of files under private-browser-0.7 and what each shows`
- [ ] 41. S15 Accessibility pass: keyboard reach, ARIA roles, Esc and focus return, forced colours, 11 px minimum — done when: the e2e accessibility assertions pass and forced-colours captures are inspected — check: `npx playwright test tests/e2e/accessibility-0-7.spec.ts`
- [ ] 42. S15 Version 0.7.0, CHANGELOG entry, docs/history change story — done when: `package.json` says 0.7.0 and both documents exist — check: `node -e "console.log(require('./package.json').version)" && node scripts/docs-guard.mjs`
- [ ] 43. S15 SECURITY.md, the system docs (merged, single Last verified bumped) and follow-ups (deferrals with reasons, closed entries removed) — done when: the docs guard passes and each new surface is described — check: `node scripts/docs-guard.mjs && git diff --stat HEAD~1 -- docs SECURITY.md`

## Tail

- [ ] T1. Adversarial review of the whole 0.7.0 diff — done when: every finding is fixed or written to the Ledger with a reason — check: `git diff --stat f283826..HEAD` reviewed hunk by hunk
- [ ] T2. Similar-issue sweep — done when: every channel, every Banking branch, every persisted field and every renderer surface was searched for the same pattern as each fix — check: `manual: list what was searched and what was found`
- [ ] T3. Full gate green — done when: `npm run check` exits 0 on the final tree — check: `npm run check`
- [ ] T4. Docs synced per the repo's rules — done when: system docs, history, follow-ups, CHANGELOG and SECURITY.md reflect the change, and the guard passes — check: `node scripts/docs-guard.mjs && git diff --stat f283826..HEAD -- docs`
- [ ] T5. Committed path-scoped and pushed — done when: `git status` shows none of this work uncommitted and the push succeeded — check: `git log origin/main..HEAD --oneline`
- [ ] T6. Confirmed live where the push deploys — done when: the release is observed on the download service, or this step says why not — check: `manual: what was opened on the live download service and what it showed`
- [ ] T7. A claim registered for this change — done when: the repo's claims register holds an entry, or this step says why there is none — check: `manual: name the claim and its deadline, or say why the change has no observable outcome`

## Ledger

- 2026-09-14 — created from ~/.claude/plans/private-browser-0-7-0-merry-otter.md and the owner's brief; plan-mode approval was declined in the tool and the owner then invoked /implement-plan, which is taken as the go-ahead
- 2026-09-14 — T5 push: the owner's brief says "Do not push to main … stop before any push unless I explicitly authorize publishing in this task", so the push is not run; it closes as parked with one question
- 2026-09-24 — steps 11 and 15 partly delivered by [SEARCH_AND_HOME_SETTINGS_PLAN.md](SEARCH_AND_HOME_SETTINGS_PLAN.md): engine presets, the HTTPS `%s` template validator and the manifest `settings` field (`BrowserSettings`, written through `settings:set` — no `settings:get`, the snapshot carries it) plus the Settings search section. Site keywords (11) and the first-run chooser (15) remain; their boxes stay open
- 2026-09-24 — step 9 — root cause was in the app, not the spec's profile flag: `showActiveTab` re-loaded a tab whose first `loadURL` had not committed yet (`getURL()` is empty while loading), aborting it with `ERR_ABORTED (-3)`; `createWindow`'s final `showActiveTab` races `openInAccountSpace` right after launch. Guarded with `!webContents.isLoading()`. Proof: `account-spaces.spec.ts --repeat-each 5` failed the Turnstile test in at least 4 of 5 runs without the guard and passed 20/20 with it. It also failed CI run 36049499069, which blocked the release of the search and Home settings
