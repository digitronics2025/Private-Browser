---
title: Search engine, Home page and startup settings
source: conversation 2026-09-24 (this file, written after a code investigation)
created: 2026-09-24
status: done
---

# Search engine, Home page and startup settings

> Status: proposed · Written: 2026-09-24 · Base: `main` at `7ec1a22` plus the
> uncommitted IPC registry change in `electron/ipc-contracts.ts`

## Context

### 1. Goal

Let the owner choose, in Settings:

- **Search engine**: what typed text that is not an address searches.
- **Home page**: what the Home button and Alt+Home open.
- **On startup**: whether the browser just restores the previous tabs, or also
  opens the Home page.

Today none of these can be changed. That is not a missing Settings card. The code
has no place to put them:

| Symptom | Root cause (verified in code) |
|---|---|
| Searches always go to DuckDuckGo | `SEARCH_ENDPOINT` is a module constant in [security.ts:1](../../electron/security.ts#L1), used by the pure `normalizeNavigationInput` ([:32](../../electron/security.ts#L32)). Nothing passes it an engine. |
| Home always opens the New Tab page | The renderer hard-codes `navigate('private://home')` for the button ([App.tsx:412](../../src/App.tsx#L412)) and for Alt+Home ([App.tsx:238](../../src/App.tsx#L238)). The main process never decides what "home" means. |
| No startup choice | Tabs are always restored from the per-Account-Space state files, and `whenReady` only opens `pendingLaunchUrl` ([main.ts:2609](../../electron/main.ts#L2609)). |
| No store for behaviour settings | The only persisted preferences are `UiPreferences` ([ui-preferences.ts](../../electron/ui-preferences.ts)): layout and theme. Behaviour settings have no typed, validated home. |

The fix gives behaviour settings one home in the main process, next to
`UiPreferences` and following the same pattern. The main process becomes the only
place that turns "search" and "home" into a URL.

### 2. Scope

**In scope**

1. A `BrowserSettings` record: `searchEngine`, `customSearchTemplate`, `homePage`,
   `homePageUrl`, `startup`. It is persisted as an optional `settings` field of
   the v2 manifest.
2. Search presets: DuckDuckGo (default), Google, Bing, Brave, Startpage, Ecosia,
   and one custom HTTPS template containing `%s`.
3. Home page: "New Tab page" (default) or one web address.
4. On startup: "Continue where you left off" (default, which is today's
   behaviour) or "Also open the Home page". The second choice opens it in a new
   tab and **never closes restored tabs**.
5. One Settings card group, "Search & Home", in the existing Settings panel.
6. The New Tab page search box names the chosen engine.
7. Tests, docs, and a note in the 0.7.0 plan saying which part of its steps 11
   and 15 this delivers.

**Out of scope** (see §9): first-run engine chooser, site keywords, remote search
suggestions, a separate home page per workspace, startup "specific pages", every
other setting from the earlier brainstorm.

This matches 0.7.0 step 11's design: a manifest `settings` field with a validated
setter. Site keywords are left out, so 0.7.0 can build on this rather than
replace it.

### 3. Enhanced design

### 3.1 Data

The new file `electron/browser-settings.ts` mirrors `ui-preferences.ts`:

```ts
export type SearchEngineId = 'duckduckgo' | 'google' | 'bing' | 'brave' | 'startpage' | 'ecosia' | 'custom';
export type HomePageMode = 'new-tab' | 'url';
export type StartupMode = 'continue' | 'home';

export interface BrowserSettings {
  searchEngine: SearchEngineId;
  customSearchTemplate?: string; // present only when searchEngine === 'custom'
  homePage: HomePageMode;
  homePageUrl?: string;          // present only when homePage === 'url'
  startup: StartupMode;
}
export type BrowserSettingsPatch = Partial<BrowserSettings>;

export const SEARCH_ENGINES: Record<Exclude<SearchEngineId, 'custom'>, { label: string; template: string }> = {
  duckduckgo: { label: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s' },
  google:     { label: 'Google',     template: 'https://www.google.com/search?q=%s' },
  bing:       { label: 'Bing',       template: 'https://www.bing.com/search?q=%s' },
  brave:      { label: 'Brave',      template: 'https://search.brave.com/search?q=%s' },
  startpage:  { label: 'Startpage',  template: 'https://www.startpage.com/do/search?q=%s' },
  ecosia:     { label: 'Ecosia',     template: 'https://www.ecosia.org/search?q=%s' },
};
```

Functions, all pure and unit-tested:

- `sanitizeBrowserSettings(value)`: the disk read. Any bad or missing field
  falls back to its default, the same rule as `sanitizeUiPreferences`: a bad
  setting must never put the browser into recovery mode. `custom` without a
  valid template falls back to `duckduckgo`. `url` without a valid address falls
  back to `new-tab`.
- `requireBrowserSettingsPatch(value)`: the IPC patch. Unknown keys, bad values,
  and a patch that would leave `custom` or `url` without its value are
  **errors**, as `requireUiPreferencesPatch` treats them.
- `mergeBrowserSettings(current, patch)`: merge, then sanitize.
- `requireSearchTemplate(text)` returns the template or throws. The rules:
  - HTTPS only.
  - No username or password.
  - At most 2048 characters.
  - Exactly one `%s`.
  - The `%s` must not be in the host: substituting two different values must
    give the same `URL.host`.
- `searchUrl(settings, query)`: the template with `%s` replaced by
  `encodeURIComponent(query)`.
- `resolveHomeUrl(settings, protectedWorkspace)` returns `'private://home'` when
  the mode is `new-tab` **or the workspace is protected (Banking)**, and
  `homePageUrl` otherwise.

### 3.2 Address parsing (security.ts)

`normalizeNavigationInput` gets a second parameter:

```ts
export function normalizeNavigationInput(value: string, searchTemplate = DEFAULT_SEARCH_TEMPLATE): string
```

The address branches move into a new exported `parseWebAddress(input): string | undefined`:

- an `http:`/`https:` URL, with a credential check and tracking parameters stripped
- `localhost` or an IPv4 address, with or without a port
- a bare host such as `tenten.ma`

`normalizeNavigationInput` calls `parseWebAddress` and falls back to the search.
The Home page setting reuses `parseWebAddress`, so "tenten.ma" is saved as
`https://tenten.ma/`, and text that would become a search is refused with "Enter
a web address". One parser serves both, so they cannot drift apart. The default
template keeps every existing `security.test.ts` expectation true unchanged.

### 3.3 Main process

- The v2 manifest gets `settings?: BrowserSettings` in
  [types.ts](../../electron/types.ts#L307). `validateManifest` in
  [account-space-state.ts](../../electron/account-space-state.ts#L341) sets
  `settings: sanitizeBrowserSettings(input.settings)`. `createManifest` (the
  migration from v1) writes defaults. `persist` and `combine` in
  [runtime-state-store.ts](../../electron/runtime-state-store.ts#L137) carry the
  field through. `RuntimeBrowserStateV2` gets `settings: BrowserSettings`.
- `BrowserController`:
  - `navigate(value)` and `openInAccountSpace` pass
    `templateFor(state.settings)` to `normalizeNavigationInput`
    ([main.ts:415](../../electron/main.ts#L415), [:600](../../electron/main.ts#L600)).
  - New `goHome()` resolves `resolveHomeUrl(settings, workspace.protected)` for
    the active tab and calls `navigate`.
  - New `setBrowserSettings(patch)` normalizes `homePageUrl` through
    `parseWebAddress`, refuses a result that is not an allowed remote URL, then
    merges, persists and broadcasts. This is the second boundary after the IPC
    validator, the same layering `setUiPreferences` uses.
  - New `openStartupHome()` runs once from `whenReady`, only when
    `startup === 'home'`, there is no `pendingLaunchUrl`, and `state.recovery` is
    unset. It opens the Home page with `newTab` in the active Account Space.
    Banking gets the New Tab page, because of `resolveHomeUrl`.
- `getSnapshot()` adds `settings` (it holds no secrets) next to `ui`.

### 3.4 IPC (on the fail-closed registry)

| Channel | Validator | Handler |
|---|---|---|
| `settings:set` | `exact(1)` + `requireBrowserSettingsPatch` | `setBrowserSettings(patch)` |
| `browser:home` | `none` | `goHome()` |

Both are added to `IPC_CHANNEL_VALIDATORS`. The preload bridge gains
`setBrowserSettings` and `goHome`. The renderer's `window.privateBrowser` type
and the preview mock ([preview-api.ts](../../src/preview-api.ts#L114)) implement
both, and the mock applies the same templates, so preview e2e tests exercise
real behaviour.

### 3.5 Renderer

- The Home button and Alt+Home call `goHome()`. `private://home` stays the "New
  Tab page" meaning everywhere else: Ctrl+T, empty address input, and closing
  the last tab.
- A "Search & Home" group in [SettingsPanel.tsx](../../src/panels/SettingsPanel.tsx),
  placed after Default browser. It reuses the existing `settings-card`,
  `settings-row` and `segmented` patterns:
  - **Search engine**: a `<select>` of the six presets plus "Custom…". Choosing
    Custom shows one text field (`https://…%s`) with **Save**. An error comes
    back from main as a toast, and the field stays open with the text intact.
  - **Home page**: a segmented control "New Tab page | Web address". Choosing
    Web address shows a text field and **Save**. A small note: "Banking always
    opens the New Tab page."
  - **On startup**: a segmented control "Continue where you left off | Also
    open Home page".
- [NewTabPage.tsx:64](../../src/shell/NewTabPage.tsx#L64) changes its
  placeholder and `aria-label` from "Search privately or enter address" to
  "Search {label} or enter address". Custom shows "Search the web or enter
  address".

### 4. Implementation steps

Each step ends green on its own check before the next begins.

0. **Preflight.**
   - Run `git status`, `git fetch`, and `npm run check` on the tree as found.
   - The uncommitted `electron/ipc-contracts.ts` change is the 0.7.0 step 2
     channel registry, and this plan builds on it. If `npm run check` passes,
     commit that file alone first as `refactor(ipc): one fail-closed channel
     registry`, so this work's diff stays reviewable.
   - If it fails, stop: the premise is false (see §5).
1. **Settings model.** Add `electron/browser-settings.ts` and
   `tests/browser-settings.test.ts`.
   - Check: `npx vitest run tests/browser-settings.test.ts`.
2. **Address parsing.** Add `parseWebAddress` and the template parameter to
   `normalizeNavigationInput`.
   - Check: `npx vitest run tests/security.test.ts`. Existing cases pass
     unchanged, and new cases cover custom templates and `parseWebAddress`.
3. **Persistence.** Update the manifest type, validate, create, persist and
   combine.
   - Check: `npx vitest run tests/state-migration.test.ts`, plus
     `tests/runtime-state-persistence.test.ts` if it exists by then.
4. **Controller and IPC.** Add `setBrowserSettings`, `goHome`,
   `openStartupHome`, the snapshot field, both channels, preload and the
   `handle()` registrations.
   - Check: `npx vitest run tests/ipc-contract.test.ts tests/ipc-guard.test.ts && npm run typecheck`.
5. **Renderer.** Add the Settings group, Home wiring, the New Tab page label and
   the preview mock.
   - Check: `npx playwright test tests/e2e/chrome-shell.spec.ts -g "search engine|home page"`.
6. **Real Electron test.** Add `tests/electron/search-home-settings.spec.ts` (see
   §7).
   - Check: `npx playwright test --config playwright.electron.config.ts tests/electron/search-home-settings.spec.ts`.
7. **Docs, in the same commit as the code.** Merge each change into the section
   that already covers it and bump each single `Last verified:` date:
   - [security-boundary.md](../systems/security-boundary.md): the rule-6 search
     template and `parseWebAddress`
   - [browser-shell.md](../systems/browser-shell.md): `goHome` and startup
   - [workspaces-and-state.md](../systems/workspaces-and-state.md): the manifest
     `settings` field and the sanitize rule
   - [ipc-contract.md](../systems/ipc-contract.md): the two channels and the
     snapshot field
   - [renderer-ui.md](../systems/renderer-ui.md): the Settings row for `settings`
   - Also: add a Ledger line in the 0.7.0 plan saying steps 11 and 15 are partly
     delivered (presets, template validator, settings store, Settings section).
     Site keywords and the first-run chooser remain. Add the §9 items to
     [follow-ups.md](../follow-ups.md).
8. **Gate and browser check.**
   - Run `npm run check`.
   - Run the app, and on the operator's PC verify with `browser-autopilot`:
     Settings → Google, type `weather`, and the tab goes to Google. Set the Home
     page to `tenten.ma`, press Home, and it opens. Switch to Banking, press
     Home, and the New Tab page opens.
   - Save every screenshot under the Playwright MCP output folder, composited
     from the Electron window only (see the screen-capture memory).
9. **Commit locally** with an `[autopilot]` trailer. **Do not push**: see
   Irreversible steps.

### 5. Failure handling and recovery

| Failure | Behaviour |
|---|---|
| `settings` missing (first run, or a manifest written by 0.6.0) | Defaults. Nothing changes for the user. |
| `settings` malformed or tampered on disk | Each field falls back separately. There is no recovery mode, no crash, and the other fields are kept. |
| Newer manifest opened by 0.6.0 after a downgrade | 0.6.0's `validateManifest` rebuilds the object without `settings`, so the choices reset to defaults on its next save. Nothing else is lost. Known and accepted, and documented in workspaces-and-state.md. |
| Bad custom template or Home address from the UI | The IPC validator or controller throws, and the renderer shows the message as a toast. The stored settings stay unchanged: the write is all or nothing, because merge happens only after validation. |
| Home page site down or unreachable | The ordinary page load error in that tab, the same as typing the address. |
| Startup Home fails (for example, the view creation throws) | Caught and logged as a privacy-log event without the URL. Startup continues with the restored tabs. |
| State recovery prompt shown at launch | Startup Home is skipped for that launch, so it never competes with recovery. |
| Launched by clicking a link in another app | The link opens. Startup Home is skipped for that launch. |
| Preflight gate red on the uncommitted registry | Stop and report. Do not revert or rewrite that change. It is not this plan's to fix. |

### 6. Security and data protection

- **The main process is the authority.** Templates and Home addresses are
  checked in the IPC validator (shape and size), then again in the controller.
  The renderer never builds a navigation URL from a setting.
- **Templates are HTTPS only**, with no credentials, exactly one `%s`, and `%s`
  never in the host. So a stored template cannot become a `javascript:`, `file:`
  or `private:` URL, and cannot send the query to a host chosen per query.
- **Queries are always `encodeURIComponent`-escaped** into the template, so a
  query cannot add parameters or break out of the query string.
- **The Home address goes through the same parser and `isAllowedRemoteUrl`** as
  the address bar: HTTP(S) only, no credentials, tracking parameters stripped.
- **Banking stays strict.** Home in Banking is always the New Tab page. That is
  enforced in `resolveHomeUrl` in main, not only hidden in the UI. Searching
  from Banking uses the chosen engine, as 0.7.0 decided: the page is
  Banking-partitioned.
- **No new network requests.** Choosing an engine sends nothing. A request only
  happens when the user searches, the same as today.
- **No secrets.** Settings hold no secrets, sit in the plain manifest the way
  `ui` does, and may appear in the snapshot.
- **Existing data is untouched.** Tabs, history, bookmarks and vault stay as
  they are. "Also open Home page" only adds a tab and never closes one.

### 7. Testing and verification

**Unit tests** (vitest)

- `browser-settings.test.ts`:
  - defaults
  - per-field sanitize fallback
  - patch rejection: unknown key, `custom` without a template, `url` without an
    address
  - template rules: `http:`, credentials, zero or two `%s`, `%s` in the host,
    and 2049 characters are all refused
  - `searchUrl` escaping of `a&b=c #x`
  - `resolveHomeUrl` for each mode, including Banking
- `security.test.ts`:
  - every existing expectation unchanged
  - the Google template produces `https://www.google.com/search?q=best%20television%20morocco`
  - `parseWebAddress('weather')` returns `undefined`
  - `parseWebAddress('tenten.ma')` returns `https://tenten.ma/`
- `state-migration.test.ts`:
  - a manifest without `settings` loads with defaults
  - a garbage `settings` value loads with defaults and without recovery
  - a round-trip keeps the choices
  - v1 migration writes defaults
- `ipc-contract.test.ts`: both channels are registered, and a bad patch throws.

**Preview e2e** (`chrome-shell.spec.ts`)

- Choosing Bing in Settings makes typing `weather` in the address bar produce a
  `bing.com/search?q=weather` tab.
- The New Tab page placeholder reads "Search Bing or enter address".
- A Home address set in Settings is where the Home button goes.
- An invalid custom template shows an error, and the setting stays unchanged.

**Electron** (`search-home-settings.spec.ts`, reusing the local HTTPS fixture
pattern from `chrome-layout.spec.ts`)

- A custom template pointing at the fixture origin means typing `hello` loads
  `/search?q=hello` from the fixture.
- A Home address set to the fixture page means pressing Alt+Home loads it.
- Setting `startup: 'home'`, closing and relaunching with the same user data
  keeps the restored tabs and adds a tab showing the fixture Home page.
- Settings survive the relaunch.
- In the Banking workspace, Home shows the New Tab page.

**Gate:** `npm run check` passes.

**Manual check on the operator's PC:** `browser-autopilot`, as in step 8. It is
reported separately from the automated results. Where the tool is unavailable,
the plan reports "not verified in a real window", never "done".

Known local noise: the Turnstile Electron test fails on this PC even on a clean
main, while CI passes it (see memory). Its failure alone is not this plan's
failure. Say so in the report, and never skip it silently.

### 8. Success criteria

1. Typing non-address text searches the engine chosen in Settings, and the
   choice survives a restart.
2. A custom `https://…%s` template works. Every non-HTTPS, multi-`%s`, host-`%s`
   or credential template is refused with a clear message.
3. The Home button and Alt+Home open the chosen Home page, and Banking always
   opens the New Tab page.
4. "Also open Home page" adds one Home tab at launch, keeps every restored tab,
   and does nothing on a link launch or a recovery launch.
5. A missing or corrupted `settings` field never triggers recovery mode and
   never loses other state.
6. Ctrl+T, closing the last tab and empty address input still open the New Tab
   page.
7. All tests in §7 pass, `npm run check` passes, and the five system docs are
   updated with bumped dates.
8. The manual browser check is reported as checked, or as could not check with
   the reason.

### 9. Found for Later

These go into [follow-ups.md](../follow-ups.md) in the same change:

- **First-run search chooser.** The rest of 0.7.0 step 15.
- **Site keywords** (`yt cats`). The rest of 0.7.0 step 11. `BrowserSettings`
  gets a `keywords` array later.
- **Remote search suggestions.** 0.7.0 step 12. They need the cookieless
  partition and a live check of each engine's endpoint.
- **A different Home page for each workspace**, for example Digitronics opens
  digitronics.ma while Personal opens Gmail. `homePageUrl` becomes a map keyed by
  workspace, with the current single value as the fallback.
- **Startup "open specific pages".**
- **Show or hide the Home button.** A `UiPreferences` field. The button already
  hides at narrow widths through its `optional` class.
- **The earlier brainstorm settings.** None has a root cause in this task:
  HTTPS-only mode, third-party cookie blocking, the Global Privacy Control
  signal, clear-on-exit per Account Space, download folder and "ask where to
  save", default zoom and font size, preferred page languages, the hardware
  acceleration toggle, reset settings, and a Settings search box with subpages.
- **Existing gap, noticed only.** `second-instance` and `open-url` open links in
  the active workspace, which can be Banking
  ([main.ts:2409](../../electron/main.ts#L2409)). 0.7.0 step 19 owns this. It is
  not touched here.

### 10. Next Recommended Task

0.7.0 **S2 remainder**: site keywords, the first-run chooser, and the smart
address bar suggestion list (steps 11, 12, 13 and 15). They build directly on
the `BrowserSettings` store and the `parseWebAddress` split this plan adds.

### Irreversible steps

- **None inside the run.** Every change is a local file edit plus a local
  commit, and both can be undone.
- **Pushing to `main` is the release**: it publishes a build to everyone who uses
  the browser, and that cannot be recalled. This plan does **not** push. The
  push is a separate decision for the owner.

### Assumptions

- The uncommitted `electron/ipc-contracts.ts` change is the finished 0.7.0 step
  2 registry and passes the gate. Step 0 checks this and stops if it is false.
- The six preset URL formats are the engines' public, long-stable search
  addresses. They are verified by opening each once during the manual check,
  not by automated requests to those companies.
- Settings apply to the whole browser, not to one Account Space. Only Banking's
  Home is overridden.

### 11. Final execution prompt

> Implement `docs/plans/SEARCH_AND_HOME_SETTINGS_PLAN.md` end-to-end.
>
> - Start with step 0: `git status`, `git fetch`, `npm run check`. Commit the
>   existing uncommitted IPC registry change on its own only if the gate passes.
>   Otherwise stop and report.
> - Read `docs/systems/security-boundary.md`, `browser-shell.md`,
>   `workspaces-and-state.md`, `ipc-contract.md` and `renderer-ui.md` (Agent
>   Brief first) and `SECURITY.md` before editing.
> - Work steps 1 to 9 in order. Each step's check must pass before the next.
> - Follow the patterns of `electron/ui-preferences.ts` for the new
>   `electron/browser-settings.ts`. Keep the main process the only place that
>   turns a setting into a URL.
> - Keep Banking's Home as the New Tab page in main.
> - Never close restored tabs.
> - Update the five system docs, `follow-ups.md` and the 0.7.0 plan Ledger in
>   the same commit as the code.
> - Run `npm run check`, then verify in the real app with `browser-autopilot`
>   and report that check separately.
> - Commit locally with an `[autopilot]` trailer. Do not push to `main`: that
>   publishes a release.

---
/goal Implement PLAN.md end-to-end on full autopilot. Inspect and investigate the real project first. Make all normal technical decisions yourself. Do not ask unnecessary questions. Fix root causes and blockers, test real behavior, re-test after fixes, protect existing data and functionality, avoid unrelated scope expansion, and only finish when all success criteria are verified.

## Steps

- [x] 1. Isolated worktree on branch `feat/search-home-settings` from `main` HEAD, with dependencies usable — done when: the worktree typechecks on the untouched base — check: `npm run typecheck` (in the worktree)
- [x] 2. Settings model `electron/browser-settings.ts` (§3.1) — done when: defaults, per-field sanitize, patch rejection, template rules, `searchUrl` escaping and `resolveHomeUrl` incl. Banking are tested — check: `npx vitest run tests/browser-settings.test.ts`
- [x] 3. `parseWebAddress` split and search-template parameter in `normalizeNavigationInput` (§3.2) — done when: existing expectations pass unchanged and the new template/address cases pass — check: `npx vitest run tests/security.test.ts`
- [x] 4. Persist `settings` in the v2 manifest (§3.3) — done when: missing or garbage settings load as defaults without recovery, a round-trip keeps choices, v1 migration writes defaults — check: `npx vitest run tests/state-migration.test.ts`
- [x] 5. Controller `setBrowserSettings` / `goHome` / `openStartupHome`, snapshot field, `settings:set` and `browser:home` channels, preload (§3.3–3.4) — done when: both channels validate and typecheck is clean — check: `npx vitest run tests/ipc-contract.test.ts tests/ipc-guard.test.ts && npm run typecheck`
- [x] 6. Renderer: Search & Home settings group, Home wiring, New Tab label, preview mock (§3.5) — done when: preview e2e proves engine choice, label, Home address and invalid-template refusal — check: `npm run build && npx playwright test tests/e2e/chrome-shell.spec.ts -g "search engine|home page"`
- [x] 7. Real Electron test `tests/electron/search-home-settings.spec.ts` (§7) — done when: custom template search, Alt+Home, startup Home after relaunch with tabs kept, and Banking Home all pass — check: `npx playwright test --config playwright.electron.config.ts tests/electron/search-home-settings.spec.ts`
- [x] 8. Docs merged into the owning sections, dates bumped, follow-ups and 0.7.0 Ledger line (§4 step 7, §9) — done when: the five system docs describe the new behaviour and the docs guard passes — check: `node scripts/docs-guard.mjs`
- [x] 9. Full gate and real-window check (§4 step 8) — done when: `npm run check` exits 0 and the manual browser check is reported as checked or could-not-check with the reason — check: `npm run check`

## Tail

- [x] T1. Adversarial review of the whole diff — done when: every finding is fixed or written to the Ledger with a reason — check: `git diff --stat main...HEAD` reviewed hunk by hunk
- [x] T2. Similar-issue sweep — done when: every other place that builds a search URL or hard-codes `private://home` for "Home" was searched — check: `manual: list what was searched and what was found`
- [x] T3. Lint and tests green — done when: the repo gate exits 0 on the full suite — check: `npm run check`
- [x] T4. Docs synced per the repo's rules — done when: the system docs, follow-ups and 0.7.0 Ledger reflect the change — check: `git diff --stat main...HEAD -- docs/`
- [x] T5. Committed path-scoped and pushed → parked: May I merge `feat/search-home-settings` into `main` and push it? Pushing `main` publishes a release to every user — done when: the work is committed on the branch; the push/merge to `main` publishes a release — check: `git log main..HEAD --oneline`
- [x] T6. Confirmed live where the push deploys → no change needed: nothing was pushed, so nothing was published to check — done when: the release is observed, or this step records that nothing was published — check: `manual: what was opened on the live target`
- [x] T7. A claim registered for this change → deferred: this repo has no claims register and nothing was released; the downstream probe belongs to the release that T5 is waiting on — done when: a downstream claim with a deadline exists, or this step says why there is none — check: `manual: name the claim and its deadline, or the reason`

## Ledger

- 2026-09-24 19:05 — created from this conversation's investigation; kept the owner-requested file name `SEARCH_AND_HOME_SETTINGS_PLAN.md` instead of a kebab slug
- 2026-09-24 19:05 — plan §4 step 0 superseded — the uncommitted `ipc-contracts.ts` registry and new uncommitted changes in `main.ts`, `App.tsx`, `NavigationToolbar.tsx`, `StatusMenus.tsx`, `styles.css`, two system docs and `chrome-layout.spec.ts` belong to two busy concurrent sessions (a zoom menu, the IPC registry); they are not committed, staged or touched. Work happens in an isolated worktree off `main` HEAD instead, where `ipc-contracts.ts` is still the switch form, so the two new channels are added as `case`s there and must become registry entries when that work lands
- 2026-09-24 19:12 — step 1 — worktree at `../Private-Browser-search-home` with its own `npm ci` (no junctions, so removing it later cannot delete the main tree's `node_modules`); `npm run typecheck` needs `npm run bridge:build` first on a fresh install, as `npm run build` already does. The plan file is ticked on the branch copy from here on
- 2026-09-24 20:09 — steps 1–5 — `main` moved during the run (the other sessions committed zoom, bookmark icons and the Control Center link; my plan commit was rebased to `3fcb9c5`; the uncommitted IPC registry change was withdrawn, so `ipc-contracts.ts` on `main` is still the switch form). Branch work was committed as a local WIP commit and rebased onto `main` `80cd075`; conflicts in `preload.cts` and `preview-bridge.ts` were import/snapshot lines only, resolved by keeping `main` and adding the settings field. Checks for steps 2–5 re-run green on the rebased tree
- 2026-09-24 20:09 — step 5 — `openStartupHome` logs a failure as a `blocked` privacy event (the closest existing kind) without the URL; the channel tests went into `tests/ipc-contract.test.ts` next to the dialog contract
- 2026-09-24 20:16 — step 6 — also renamed the address bar placeholder (`NavigationToolbar.tsx`), which said "Search privately" too; the renderer merges `DEFAULT_BROWSER_SETTINGS` under `state.settings` exactly as it already does for `ui`, because `developer-bridge.spec.ts` injects a hand-made snapshot without `settings` and the page crashed on it (caught by the full preview suite, now 22/22)
- 2026-09-24 20:24 — step 7 — the two Save buttons got distinct accessible names ("Save search address", "Save Home page") after the real-window test found them ambiguous, and the Home button tooltip changed from "New Tab page (Alt+Home)" to "Home (Alt+Home)" because it is no longer always the New Tab page
- 2026-09-24 20:31 — step 8 — `Last verified:` bumped on all five docs (four were already 2026-09-24 from other sessions' work). The docs guard's 6 non-blocking `verified_at` drift warnings are left: most count other sessions' commits (zoom, bookmark icons, Control Center) whose effect on those docs was not re-read here, and bumping the hash would claim a verification that did not happen. Also fixed a stale line in security-boundary.md step 3, which said the URL branch returns `parsed.toString()` while the code already strips tracking parameters
- 2026-09-24 20:52 — step 9 — first `npm run check` stopped only at `account-spaces.spec.ts` "Turnstile test-key flow" (`ERR_ABORTED (-3)` in `accounts:open-in`). This change touches `openInAccountSpace`, so the test was re-run on an untouched `main` `80cd075` build in this worktree: same failure, and `gh run list --branch main` shows CI green on that commit, matching the saved memory about this PC. After the final wording fix the whole `npm run check` re-ran to exit 0 (unit 287/287, preview e2e 22/22, Electron 11/11 including Turnstile), plus `npm run worker:build` exit 0
- 2026-09-24 20:52 — step 9 manual check — Playwright MCP (real Chrome) against the branch preview on port 5188: Settings shows the Search engine, Home page and On startup cards; choosing Google changed both the address bar and the New Tab search box to "Search Google or enter address"; no console errors. The screenshot is under the Playwright MCP output folder, a page-only capture of the preview's fake data. The VS Code Simple Browser preview was requested but wrote no new receipt, so the visible VS Code preview is **not** claimed
- 2026-09-24 20:52 — T1 — whole diff reviewed hunk by hunk. No defect found. Noted, not changed: a patch that sends only `customSearchTemplate` or `homePageUrl`, without choosing `custom`/`url`, is accepted and then dropped by the merge (harmless, and the UI always sends both)
- 2026-09-24 20:52 — T2 — searched `src/` and `electron/` for `duckduckgo`, "Search privately", `navigate('private://home')` and the old Home tooltip. Fixed: the address bar placeholder (step 6), the Home tooltip (step 7) and the New Tab site-info text in `StatusMenus.tsx`, now "Search or enter an address.". Left: the Banking quick-link tile "Secure search" → duckduckgo.com is a shortcut, not the search setting
- 2026-09-24 20:52 — T5 — committed on branch `feat/search-home-settings` in the worktree, not on `main`: two other sessions were active in the main checkout, and pushing `main` publishes a release, which this plan says not to do. Parked with one question

