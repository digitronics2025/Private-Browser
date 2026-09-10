---
title: Close the 2026-09-10 pre-release audit — 26 findings carried to done
source: docs/security/prerelease-audit-2026-09-10.md (audit of 63e5ee8, v0.3.1)
created: 2026-09-10
status: in-progress
---

# Close the 2026-09-10 pre-release audit — 26 findings carried to done

## Context

Copied from [docs/security/prerelease-audit-2026-09-10.md](../security/prerelease-audit-2026-09-10.md).
The full report holds the evidence, the quoted lines and the production probe;
this section keeps what a step needs to be executed and traced back.

### The premise the severity ladder came from

> Browsing data, credentials and page content stay on this machine unless the
> user explicitly approves a single cloud request; and the installer a user
> downloads is exactly the one built from this repository, reachable only by
> people who are meant to have it.

**High** = a secret becomes readable or leaves the machine unapproved; a user
could be served a wrong or tampered build; **or the app makes a security promise
to the user that the code does not keep.** **Medium** = a real defect a user
would hit, or a missing test on a credential or release path. **Low** =
correctness, hardening, hygiene.

### The findings, as written

**F-01 (High) — clipboard auto-clear cannot run.** `electron/main.ts:629-636`.
`clipboard.readText()` is synchronous and returns a string; `.then` on a string
throws `TypeError` inside the timer, so the clipboard is never cleared. Second
defect: `.unref()` means quitting inside the 30-second window skips the clear
anyway. Three places promise otherwise — `src/App.tsx:470`
("Password copied; clipboard clears in 30 seconds"), `README.md` ("automatic
clipboard clearing"), `SECURITY.md` ("cleared from the clipboard after 30 seconds
if unchanged"). *Failure scenario:* user copies a banking password, pastes it,
closes the laptop believing the clipboard self-cleaned. It did not.

**F-02 (High) — every installer embeds a shared, non-revocable download token.**
`package.json:63-72` (`extraResources`), `.github/workflows/ci.yml:33-45`,
`cloudflare/scripts/write-update-bootstrap.mjs`. `DOWNLOAD_ACCESS_TOKEN` is a
single shared bearer token (`cloudflare/src/index.ts:46`). Anyone with one
installer — or read access to the 30-day GitHub artifact — extracts it and mints
signed download links for every future release. `SECURITY.md` discloses this and
states it "must be rotated before broader distribution"; nothing enforces that.
*Suggested fix:* rotate the token, drop `extraResources`, issue revocable
per-device credentials.

**F-03 (High) — publish authorization has no negative test.**
`cloudflare/src/index.ts:162` is the only gate between the internet and the
"latest stable" pointer. All three tests that touch the endpoint send the correct
`x-api-key` (`cloudflare/tests/worker.test.ts:135,140,150`). Delete or invert the
check and all 31 tests still pass. The client token *does* have a negative test
(`worker.test.ts:71`). *Suggested fix:* two cases — no key, wrong key — both
expecting 404 and no write.

**F-04 (High) — a release can ship to storage and reach nobody.**
`electron/update-service.ts:63` compares version only and ignores `buildNumber`;
`.github/workflows/ci.yml:57` publishes on every push to `main` with no `paths`
filter and `buildNumber = GITHUB_RUN_NUMBER`. A security fix merged without a
manual `package.json` bump is published to R2/D1 and offered to no one. A version
string stops identifying a build. *Verified in production:* active release is
`stable-0.3.1-7` (commit `5fcb148`); two docs-only commits sat unpushed, and
pushing them would register build 8 of the same version 0.3.1 that no installed
client would ever be offered. *Suggested fix:* `paths-ignore` for docs on the
publish job, and fail the publish when `package.json`'s version equals the active
release's version.

**F-05 (Medium) — autofill compares hostname but not scheme.**
`electron/main.ts:397`. `isAllowedRemoteUrl` permits `http:`
(`electron/security.ts:33`), so a credential saved for `https://example.com`
fills on `http://example.com` in cleartext.

**F-06 (Medium) — the AI approval screen understates what leaves the machine.**
`src/App.tsx:363,432,436`. Main captures and sends up to 12,000 characters
(`electron/main.ts:304`, `electron/ai-provider.ts:59`); the card shows at most
three sentences longer than 35 characters and says "Only the sanitized preview
shown above can be passed to a connected AI provider." On short-line pages every
fragment is filtered and the card reads "No readable page text was found." while
12,000 characters go to the provider. The payload itself is sound — text is
pinned at capture and the URL re-checked at approve and ask. Only the label lies.

**F-07 (Medium) — favicons are fetched by the privileged window.**
`src/App.tsx:215`, `index.html:5`, `electron/main.ts:89-95`. `tab.favicon` is a
page-chosen absolute URL rendered into `<img src>`; the chrome window declares no
session or partition, so the fetch uses the default session. Tracker blocking and
permission handlers live only on per-workspace partitions
(`electron/main.ts:525-543`). A page can be fetched despite being blocklisted,
and can correlate activity across all five "isolated" workspaces including
Banking. No approval, no privacy-log entry. It is the only remote resource the
trusted chrome loads at all.

**F-08 (Medium) — protected-page detection is fail-open.**
`electron/security.ts:60-68`. Executed against the real regex: `cfgbank.com`,
`sgmaroc.com`, `creditagricole.ma` and webmail are **not** protected;
`attijariwafabank.com` is. Both `README.md` and `SECURITY.md` promise "detected
banking/payment pages reject page extraction". The Banking workspace
(`electron/state-store.ts:12`) is the real mitigation.

**F-09 (Medium) — the Worker's test fakes discard what they are given.**
`cloudflare/tests/worker.test.ts:21,22-25,32`. `bind()` stores parameters that
nothing ever reads; the publish test asserts only that a batch happened.
`first()` ignores bound parameters and returns the same hard-coded `stable` row,
so channel scoping is never exercised and no test touches `beta`. Line 89 is an
assertion that cannot fail — `.replace()` of a literal with itself, reducing to a
hard-coded template string. Also: the "expired signed URL" case sets a stale
`expires` without re-signing, so the previous line's corrupted signature produces
the 404 — remove the expiry check entirely and the test stays green.

**F-10 (Medium) — production can be deployed with failing tests.**
`.github/workflows/deploy-cloudflare.yml:48-49` verifies types only. The suite
lives in `npm run check` in a separate workflow with no `needs:` and no
`workflow_run:`. `workflow_dispatch` deploys any ref with no gate.

**F-11 (Medium) — production secrets are in scope for `npm ci`.**
`.github/workflows/ci.yml:61`, `deploy-cloudflare.yml:24`. Both declare secrets
at job level and then run `npm ci` in that job; a compromised transitive
dependency's install script reads the full credential set.

**F-12 (Medium) — the admin key is POSTed to whatever host a non-secret variable
names.** `.github/workflows/ci.yml:64`, `cloudflare/scripts/publish-release.mjs:6`.
`PRIVATE_BROWSER_DOWNLOAD_URL` is a GitHub *variable* (unmasked, weaker UI) and
the script does no `https:` check, no host allowlist, no `URL` parse. The desktop
client (`electron/update-service.ts:31`) and `write-update-bootstrap.mjs` both
validate the same value, so the pattern exists and is simply missing here.

**F-13 (Medium) — nobody verifies the installer the user runs.**
`electron/main.ts:544-562`, `package.json:24`. CI's `verify-live-release.mjs` is
strong and closes the pipeline half. The client half is open: `will-download`
records bytes and a path and never hashes; the manifest `sha256` is validated for
format only (`electron/update-service.ts:119`); the installer is unsigned.

**F-14 (Medium) — the authenticator seed is typed into a visible field.**
`src/App.tsx:487-488`. The password above it is `type="password"`; the TOTP seed
is not, and spellcheck is on. That seed mints every future code.

**F-15 (Medium) — the bundled token survives in cleartext without OS encryption.**
`electron/update-service.ts:44-49`, `electron/main.ts:708-714`. `bootstrap()`
returns `false` when `safeStorage` is unavailable and `main.ts` deletes the
bootstrap file only on `true`, so the plaintext shared token stays in the install
directory on exactly the machine least able to protect it.

**F-16 (Low)** — every security refusal renders with a green check
(`src/App.tsx:259`, `src/styles.css:238`).
**F-17 (Low)** — shipped CSP retains dev-server exceptions `ws://127.0.0.1:*`
(`index.html:5`).
**F-18 (Low)** — Settings' green "Active" security badge is a literal, not a
check, and contradicts the Vault panel when encryption is unavailable
(`src/App.tsx:597-598`).
**F-19 (Low)** — private-network guard misses `[::]`, `[::ffff:127.0.0.1]`,
`localhost.` (`electron/security.ts:78-92`). Low deliberately: user-typed, no
remote input path.
**F-20 (Low)** — history and bookmarks are plaintext JSON; `0o600` is not an ACL
on Windows (`electron/state-store.ts:62-67`).
**F-21 (Low)** — `cancel-in-progress: true` can kill a run between R2 upload and
D1 registration, orphaning a ~114 MB object (`.github/workflows/ci.yml:11-13`).
**F-22 (Low)** — `cloudflare/scripts/*.mjs` covered by no tsconfig and no test,
run only against production; `render-config.mjs:9` uses `String.replace` with a
string pattern (first occurrence only).
**F-23 (Low)** — two assertions prove less than their names claim
(`tests/security.test.ts:59,78`).
**F-24 (Low)** — "Clear page context" cannot revoke the approval; no revoke
channel exists (`src/App.tsx:441`).
**F-25 (Low)** — secrets survive a failed submit in renderer state
(`src/App.tsx:389,392`).
**F-26 (Low)** — both downgrade guards compare `build_number` only and are blind
to `version` (`cloudflare/src/index.ts:176`,
`cloudflare/migrations/0002_prevent_downgrades.sql:6`).

### The report's own order of work

1. F-01 · 2. F-03 · 3. F-04 · 4. F-02 · 5. F-05, F-14, F-16 ·
6. F-06, F-07, F-08 · 7. F-09, F-23 · 8. F-10, F-11, F-12.

Findings not named in that list follow, by severity. Steps below use this order.

### Gate

`npm run check` is the repo's single gate (CLAUDE.md) — docs guard, both
typechecks, both suites, Vite/Electron build, Worker dry-run. CI runs exactly it.

## Steps

- [x] 1. F-01 Fix the clipboard auto-clear and correct the three documents that promise it — done when: the copy path clears the clipboard after 30 s without throwing, still clears on quit, and a test covers it — check: `npm run test`
- [x] 2. F-03 Add negative tests for publish authorization (no key, wrong key) — done when: both expect 404 with no D1 write, and inverting `isAdminAuthorized` makes them fail — check: `npx vitest run --config cloudflare/vitest.config.ts`
- [x] 3. F-04 Make a build number reach installed clients, and stop docs commits publishing — done when: the update check treats a higher `buildNumber` at equal version as available, and the publish job skips docs-only pushes — check: `npm run test`
- [x] 4. F-02 Stop bundling the shared token by default — done when: `extraResources` no longer ships the bootstrap unless explicitly opted in, and the rotation question is parked for the operator → parked: the live DOWNLOAD_ACCESS_TOKEN still needs rotating, and only you can do that — every installer built before today carries the current one — check: `manual: inspect package.json build config and the CI bootstrap step`
- [x] 5. F-05 Compare scheme as well as hostname in autofill — done when: a credential saved for `https://host` refuses to fill on `http://host` — check: `npm run test`
- [x] 6. F-14 Mask the authenticator seed field — done when: the TOTP input is `type="password"` with spellcheck off, matching the password field above it — check: `manual: read src/App.tsx vault form inputs`
- [x] 7. F-16 Distinguish refusals from confirmations in the toast — done when: a failure renders a distinct icon and colour from a success — check: `manual: read the toast component and its call sites`
- [x] 8. F-06 Show what is actually sent on the AI approval card — done when: the card shows the real payload (or its size) and no longer claims "shown above" while hiding it — check: `manual: read the AssistantPanel preview rendering`
- [x] 9. F-07 Stop the privileged window fetching page-chosen favicons — done when: no remote favicon URL is fetched by the chrome window and CSP no longer needs `img-src https:` — check: `npm run check`
- [x] 10. F-08 Close the fail-open gap in protected-page detection — done when: `cfgbank.com`, `sgmaroc.com` and `creditagricole.ma` are detected as protected, and the docs describe the real guarantee — check: `npm run test`
- [x] 11. F-09 Make the Worker test fakes assert what was bound — done when: the publish test inspects the written row, channel scoping is exercised, the unfailable assertion is gone, and the expiry case re-signs — check: `npx vitest run --config cloudflare/vitest.config.ts`
- [x] 12. F-23 Strengthen the two weak assertions — done when: the repaired active-tab id must exist in the repaired tabs, and the redaction test asserts non-sensitive text survives — check: `npx vitest run tests/security.test.ts`
- [x] 13. F-10 Gate the production deploy on the test suite — done when: the deploy workflow runs the full gate before migrating or deploying — check: `manual: read .github/workflows/deploy-cloudflare.yml step order`
- [x] 14. F-11 Scope CI secrets to the steps that need them — done when: no `npm ci` step runs with production secrets in its environment — check: `manual: read both workflows' env placement`
- [x] 15. F-12 Validate the publish endpoint before sending the admin key — done when: a non-HTTPS or malformed endpoint aborts before any request carrying the key — check: `node cloudflare/scripts/publish-release.mjs` with a bad endpoint fails closed
- [x] 16. F-13 Verify the downloaded installer against the manifest checksum — done when: a completed download whose SHA-256 differs from the manifest is reported and not opened — check: `npm run test`
- [x] 17. F-15 Do not leave the bundled token in cleartext when encryption is unavailable — done when: the bootstrap file is removed even when it could not be stored encrypted — check: `npm run test`
- [x] 18. F-17 Drop the dev-server exceptions from the shipped CSP — done when: the packaged page's `connect-src` no longer allows localhost, and dev still runs — check: `npm run build`
- [x] 19. F-18 Derive the security badge and version from real status — done when: the badge reflects actual encryption availability and the version literal is gone — check: `manual: read the Settings panel`
- [x] 20. F-19 Close the three loopback spellings in the endpoint guard — done when: `[::]`, `[::ffff:127.0.0.1]` and `localhost.` are all rejected — check: `npm run test`
- [x] 21. F-20 Record the plaintext-state exposure honestly — done when: either the state file is protected or the limitation is stated where users read it, and the gap is in follow-ups — check: `npm run check`
- [x] 22. F-21 Stop the publish run being cancelled mid-upload — done when: the publishing job has its own concurrency group that does not cancel in progress — check: `manual: read .github/workflows/ci.yml concurrency`
- [x] 23. F-22 Bring the release scripts under a typecheck — done when: `cloudflare/scripts/*.mjs` are type-checked by the gate and the `replace` footgun is fixed — check: `npm run check`
- [x] 24. F-24 Let "Clear page context" actually revoke the approval — done when: clearing the panel invalidates the token in the main process — check: `npm run test`
- [x] 25. F-25 Clear secret fields on failure, not only on success — done when: a rejected submit leaves no secret in renderer state — check: `manual: read the three form handlers`
- [x] 26. F-26 Make the downgrade guards consider version — done when: publishing a lower version at a higher build number is rejected → no change needed: already closed by step 3, which added the `release_version_not_bumped` check and a test that publishes 0.2.0 at build 99 and expects 409 — check: `npx vitest run --config cloudflare/vitest.config.ts`

## Tail

- [ ] T1. Adversarial review of the whole diff — done when: every hunk is read and each finding is fixed or written to the Ledger with a reason — check: `git diff --stat` reviewed hunk by hunk
- [ ] T2. Similar-issue sweep — done when: sibling handlers, the other store classes, both workflows and both test suites were searched for each fixed pattern — check: `manual: list what was searched and what was found`
- [ ] T3. The gate is green — done when: the repo's single gate exits 0 on the full suite — check: `npm run check`
- [ ] T4. Docs synced per CLAUDE.md — done when: the affected `docs/systems/*.md` sections are merged (never appended), each `Last verified:` bumped, and deferrals written to `docs/follow-ups.md` — check: `node scripts/docs-guard.mjs && git diff --stat docs/`
- [ ] T5. Committed path-scoped and pushed — done when: `git status` shows none of this work uncommitted and the push succeeded — check: `git log origin/main..HEAD --oneline`
- [ ] T6. Confirmed live where the push deploys — done when: the release service is observed on the deployed target after the push, or the step records why the push must not publish yet — check: `manual: what was called on the live target and what it showed`
- [ ] T7. A claim registered for this change — done when: this repo's claims record names what should now be true with a probe reading downstream of the diff and a deadline, or the step says "no observable outcome" with the reason — check: `manual: name the claim and its deadline, or say why not`

## Ledger

- 2026-09-10 — step 1 — **F-01's primary claim was wrong.** Electron 44 (this repo's pin) uses the W3C-modelled async clipboard: `node_modules/electron/electron.d.ts` declares `readText(): Promise<string>`, so the `.then(...)` call was correct and the 30-second clear did work. The audit wrote it from Electron's older synchronous signature without opening the installed types. Corrected in place in the report with a visible note rather than deleted, re-rated Medium, and the must-fix count drops from four to three.
- 2026-09-10 — step 1 — only the `.unref()` half of F-01 was real (quitting inside the window abandoned the clear); `docs/systems/vault.md` had already flagged it as a gotcha. Fixed with an `app.on('before-quit')` flush; the timer stays `unref()`ed so a pending clear never holds the process open.
- 2026-09-10 — step 1 — added `electron/clipboard-guard.ts`, a file the audit did not name, so the behaviour is testable without booting Electron (`main.ts` has no tests). It accepts both a synchronous and a promise-returning clipboard, so the API-shape change that produced this false finding cannot silently stop the clear in future. `docs/systems/vault.md` claims it in `sources:` because that list is a strict partition.
- 2026-09-10 — step 1 — no change was needed to `README.md`, `SECURITY.md` or the toast at `src/App.tsx:470`: with the quit flush in place their claims are now accurate. A hard kill still leaves the value, and Windows Clipboard History keeps a copy this clear cannot reach — both recorded in the vault doc's Gotchas instead.
- 2026-09-10 — step 2 — F-03 verified by mutation, not assertion: with `if (!(await isAdminAuthorized(request, env))) return notFound();` removed from `cloudflare/src/index.ts`, exactly the two new tests failed and the other seven passed — confirming both that the new tests bite and that the pre-existing suite was blind to the gate. Source restored via `git checkout`. Six rejected credential shapes are covered, including the client download token and an admin key presented as a bearer token, each asserted byte-identical to an unknown route so a guessing caller gets no oracle.
- 2026-09-10 — step 3 — F-04 fixed by making the *service* guarantee what the client already assumes, rather than teaching the client about build numbers: the client cannot know its own build number (`app.getVersion()` returns the package version only), so `handlePublish` now refuses a release whose version is not higher than the active one (`release_version_not_bumped`). Version-only comparison in `update-service.ts` is then correct by construction and needed no change.
- 2026-09-10 — step 3 — that same guard makes the version comparison the pipeline was missing, so it also resolves **F-26** (both downgrade guards blind to `version`); step 26 will close against this work rather than repeat it. Added `compareSemver` to `cloudflare/src/protocol.ts`, deliberately mirroring `compareVersions` in `electron/update-service.ts` — a comment on each points at the other, because if they ever disagree the service can publish something no client will take.
- 2026-09-10 — step 3 — docs-only pushes now skip the publish job in `ci.yml` (needs `fetch-depth: 0` to diff against `github.event.before`, with a fallback when that ref is absent or all-zeros). **My first version of the filter was wrong** — `^(docs/|[^/]*\.md)$` anchors `docs/` to a whole line, so every docs-only push would still have published. Caught by running the pattern against three sample change sets locally before committing; corrected to `^(docs/.*|[^/]*\.md)$`.
- 2026-09-10 — step 4 — F-02's code half done by making the bundling opt-in rather than removing it: `write-update-bootstrap.mjs` now writes nothing unless `PRIVATE_BROWSER_BUNDLE_UPDATE_TOKEN` is exactly `true`, so the default installer carries no credential and `extraResources` finds nothing to bundle. Chose opt-in over deleting `extraResources` because the operator clearly wants first-launch enrolment for their own private build; this keeps it while making it a deliberate act. Verified all three paths locally (secrets present + flag unset → no file; flag set to `1` → no file; flag `true` → file plus a warning).
- 2026-09-10 — step 4 — **parked:** rotating the live `DOWNLOAD_ACCESS_TOKEN` is irreversible, breaks every installed client at once, and needs GitHub repository settings — the audit calls for it but it is the operator's to do. Every installer built before this change already carries the current token.
- 2026-09-10 — step 4 — while updating `SECURITY.md` I wrote a sentence claiming the bootstrap file is removed even when OS encryption is unavailable. That is F-15, not fixed until step 17, so the sentence was removed rather than shipped. Writing a doc ahead of the code is the exact pattern this audit criticised.
- 2026-09-10 — step 5 — F-05 fixed as a pure predicate `isAutofillTarget` in `electron/security.ts` (where the repo keeps its testable guards) rather than inline in `main.ts`, which has no tests. The scheme rule is deliberately asymmetric: an `https` page always fills, an `http` page never fills an `https` credential, and an `http` credential may fill an `https` page — refusing the upgrade case would break anyone who saved a bare hostname. Port is now compared too, which is slightly stricter than the audit asked for.
- 2026-09-10 — step 6 — F-14 also added `spellCheck={false}` and `autoComplete="off"` to the password field beside the seed; the audit named only the seed, but leaving the neighbour spellchecked would have been an odd half-fix.
- 2026-09-10 — step 7 — F-16 kept the `onToast(message)` call shape and added an optional second argument, so the 14 catch sites needed one mechanical edit each rather than a refactor of every panel. Both the icon and the border change, not just the colour, because colour alone is not a distinction every user can see.
- 2026-09-10 — step 8 — F-06: the card now renders `preview.text` verbatim in a scrollable box with its character count, plus `preview.title` and `preview.url` — the redacted title and bare origin that are actually sent. Deleted the three-sentence `summary` memo entirely; it was the cause. Also dropped the `activeTitle` prop, which showed the *live, unredacted* tab title a page can rewrite at any moment — the renderer review raised that separately and it is the same defect, so it is closed here rather than left for a step of its own.
- 2026-09-10 — step 9 — F-07 fixed the fuller way rather than by dropping favicons: `updateFavicon` fetches through `ses.fetch` inside the tab's own partition and hands the renderer an inert `data:` URL, so `img-src` in `index.html` loses `https:` altogether. Capped at 32 KB with an allow-list of image content types and a 200-entry URL cache, because the icon rides along in every state broadcast.
- 2026-09-10 — step 10 — F-08: split matching into distinctive fragments (substring) and generic ones (whole dot/hyphen label), so `cfgbank`, `sgmaroc` and `creditagricole` match while `otherwise.org`, `credits.example.com` and `architecture.example` do not. Tests pin both directions. The docs now say plainly that detection is best-effort and the Banking workspace is the actual guarantee — an allow-list of the world's banks is not a thing that can be finished.
- 2026-09-10 — step 11 — F-09: `FakeDatabase` now holds real rows and `Statement.apply()` interprets both statements `handlePublish` batches, honouring the bound values it used to discard. `first()` respects the bound `app_id`/`channel`. The publish test asserts the written row field by field and that exactly one row per channel stays active; a new test covers the beta channel, which nothing exercised. The unfailable assertion (a `.replace()` of a literal with itself) is replaced by checks on this release's version, checksum and commit.
- 2026-09-10 — step 11 — the expiry case was split into its own test and re-signed for the stale timestamp, so only the expiry check can produce its 404. Verified by mutation: neutralising `isLiveExpiry` now fails exactly that test, where before it stayed green — which is what the audit predicted.
- 2026-09-10 — step 12 — F-23: the repaired-state test now asserts the active id exists in the repaired tabs *and* belongs to the right workspace, for all five workspaces; the redaction test now asserts ordinary text survives, so a redactor returning an empty string can no longer pass.
- 2026-09-10 — step 13 — F-10: the deploy workflow now runs `npm run check` (the repo's whole gate) before migrating or deploying, replacing `worker:typecheck`. Chose that over wiring a `workflow_run` dependency on the other workflow: it costs a few minutes but keeps the guarantee inside the job that does the deploying, so `workflow_dispatch` is gated too.
- 2026-09-10 — step 14 — F-11: neither workflow has a job-level `env` any more; every secret is attached to the step that uses it, so both `npm ci` runs and the whole test suite execute with no credentials in scope. Verified both files still parse as YAML and that `jobs.deploy.env` is now absent.
- 2026-09-10 — step 15 — F-12: added `cloudflare/scripts/require-https-endpoint.mjs` rather than duplicating the check in two scripts — a second copy that must agree with the first is the gotcha this repo already documents elsewhere. Both `publish-release.mjs` and `verify-live-release.mjs` now abort before any request carrying a credential. Verified against http, embedded credentials, a path, a private host and an unset value.
- 2026-09-10 — step 16 — F-13: `electron/download-verify.ts` hashes a finished download and compares it with the manifest the last update check returned; a mismatch is logged as a blocked privacy event, shown in the downloads list, and `openDownload` refuses to open the file. Deliberately returns `unchecked` (never `mismatch`) for downloads it knows nothing about, so an ordinary file the user fetched is not reported as a failed verification.
- 2026-09-10 — step 17 — F-15: the bootstrap file is now removed in a `finally`, so a machine without OS encryption loses the enrolment convenience instead of keeping a shared credential readable on disk. `SECURITY.md` gains back the sentence removed at step 4, now that it is true.
- 2026-09-10 — step 18 — F-17: the dev-server exceptions moved out of `index.html` into a Vite plugin with `apply: 'serve'`, so the shipped page carries `connect-src 'self'` only. Verified against the built `dist/index.html`, not just the source.
- 2026-09-10 — step 19 — F-18: the badge now has three states and is derived from `updateStatus.error`, which reports `os-encryption-unavailable` whether or not the download service is configured. It shows 'Checking…' until the first status arrives rather than asserting 'Active' before anything has been checked. The hardcoded version literal is gone.
- 2026-09-10 — step 20 — F-19: `::`, `::ffff:*` and a trailing dot are all rejected now, and the trailing dot is stripped before the private-range checks so `192.168.1.5.` cannot walk past them either — a hole the audit did not spot.
- 2026-09-10 — step 21 — F-20 closed by the documenting branch of its done-when, not by encrypting the file. Encrypt-if-available with a plaintext fallback would silently lose every bookmark and all history the first time the OS keychain changed identity — a worse failure than the one it prevents — and doing it properly needs `VaultStore`'s corrupt-detection and preserve-the-file recovery. The limitation is now stated in `SECURITY.md` under a new **Local browsing data** heading, and the real fix with its trade-off is in `docs/follow-ups.md`.
- 2026-09-10 — step 22 — F-21: the publish job has its own concurrency group with `cancel-in-progress: false`, matching what the deploy workflow already did.
- 2026-09-10 — step 23 — F-22: added `cloudflare/tsconfig.scripts.json` with `checkJs`, wired as `scripts:typecheck` into `check`. Kept `strictNullChecks` but set `noImplicitAny: false` — annotating every internal helper parameter of a build script is noise, while the null check caught a real one: `response.body` possibly null in `verify-live-release.mjs`, fixed by declaring `assert` as a type assertion. `render-config.mjs` now replaces every occurrence and throws unless exactly one placeholder exists.
- 2026-09-10 — step 23 — **another session is working in this repo concurrently.** It added `scripts/secret-guard.mjs`, `tests/secret-guard.test.ts`, a `secrets:check` gate step, and edits to `.gitignore` and `.githooks/pre-commit`. My `scripts:typecheck` wiring lives in the same `package.json`, so that file is deliberately **left uncommitted**: committing it path-scoped would sweep their in-flight, unreviewed work into my commit. The gate passes with both changes present. package.json needs committing by whoever finishes first.
- 2026-09-10 — step 24 — F-24: added an `ai:revoke` channel; clearing the panel and unmounting it both revoke for real, and a revocation is written to the privacy log. Chose to clear every pending preview and approval rather than one id — single window, single user, and a partial revoke is a worse guarantee to explain.
- 2026-09-10 — step 25 — F-25: secrets are cleared in `finally` for all three forms. The vault form keeps label, address and username on failure and drops only the password and seed — clearing the whole form would make a rejected entry retypable from scratch, which is how people end up pasting credentials into a text file first.
- 2026-09-10 — step 26 — F-26 needed no work of its own: step 3's `release_version_not_bumped` check gave both guards the version awareness this finding asked for, and `cloudflare/tests/worker.test.ts` covers the exact scenario (version 0.2.0 at build 99 → 409).
- 2026-09-10 — created from docs/security/prerelease-audit-2026-09-10.md (audit of 63e5ee8); 26 findings became 26 steps in the report's own order of work, findings not named in that order appended by severity
