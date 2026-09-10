# Pre-release audit — Private Browser

- **Audited commit:** `63e5ee8` (local `main`), version **0.3.1**
- **Production active release at audit time:** `stable-0.3.1-7`, commit `5fcb148`
- **Date:** 2026-09-10
- **Scope:** whole repository — desktop app, Cloudflare download service, pipeline, docs
- **Probes:** production probed read-only (secret **names** only, never values)

---

## 0. A note on the baseline, first

This audit began at commit `d0102bf`. While it was running, another session
committed three times — `5fcb148`, `6268e71`, `63e5ee8` — and the subject moved
underneath the audit. The working tree was clean at both ends; this was committed
work, not stray dirt.

The audit was **re-baselined onto `63e5ee8`** rather than published against a tree
that no longer exists. Every finding below was re-verified at its line **after**
the move. Three findings that were real at `d0102bf` were fixed by those commits
and have been dropped rather than reported (§5).

At the close, `git status` showed only this report and the index row that points
at it. No source file was touched by the audit.

---

## 1. The premise, and the ladder derived from it

The repository does not state a premise in one sentence, so one was derived from
`README.md`, `SECURITY.md` and the code:

> Browsing data, credentials and page content stay on this machine unless the
> user explicitly approves a single cloud request; and the installer a user
> downloads is exactly the one built from this repository, reachable only by
> people who are meant to have it.

Severity is derived from that, not from a fixed table:

| Level | Means |
|---|---|
| **High** | A secret becomes readable or leaves the machine unapproved; a user could be served a wrong or tampered build; **or the app makes a security promise to the user that the code does not keep.** |
| **Medium** | A real defect a user would hit, or a missing test on a credential or release path. |
| **Low** | Correctness, hardening, hygiene. |
| **Info** | Worth knowing, no action. |

The third clause of High is deliberate. In a product whose entire value is a
privacy claim, a false promise on screen is not a documentation bug — it causes
the user to take a risk they believe they have been protected from.

---

## 2. Method, and what was dropped

Premise-critical code was read in full and **not delegated**: `electron/main.ts`,
`vault.ts`, `security.ts`, `update-service.ts`, `ai-provider.ts`, and the whole
`cloudflare/src/` tree. Two `read-only-reviewer` passes ran in parallel over the
renderer and over the pipeline/test-honesty slice.

Every candidate was re-opened at its cited line before entering this report.

**Seven candidates were dropped or corrected** — listed in §5. Two of them were my
own, and they are the reason the rule exists: I expected `https://2130706433/`
and `https://0x7f000001/` to defeat the private-network guard. Executing the guard
showed Node's URL parser normalises both to `127.0.0.1`, so both are blocked.
Reported from memory they would have been two confident, wrong findings.

**Gates run** (all pass, exit 0):

| Gate | Result |
|---|---|
| `npm run check` (docs guard, typecheck x2, tests x2, Vite build, Electron compile, Worker bundle) | pass |
| Tests | **31 passing across 6 files** — 24 desktop, 7 Worker |
| Skipped / focused tests | **none** anywhere in the repository |
| `npm audit --omit=dev` (production) | **0 vulnerabilities** |
| `npm audit` (including dev) | **0 vulnerabilities** |

Reported separately on purpose: a high advisory in test tooling is not a shipping
vulnerability, and conflating the two teaches people to ignore both.

---

## 3. Findings

### High

#### F-01 — The clipboard auto-clear is abandoned when the app quits early

> **Correction, 2026-09-10, made while fixing this finding.** As first published,
> F-01 claimed `clipboard.readText()` is synchronous, so `.then(...)` throws and
> the clipboard is **never** cleared, and rated it High. **That claim was wrong.**
> Electron 44 — the version this repo pins — moved the clipboard module to the
> W3C-modelled asynchronous API: `node_modules/electron/electron.d.ts` declares
> `interface Clipboard { readText(): Promise<string>; writeText(text: string):
> Promise<void>; clear(): void }`. The `.then(...)` call was correct, and the
> 30-second clear worked in the ordinary case. The finding was written from
> Electron's older synchronous signature without opening the installed types.
>
> What survives is the second half, which was always real and which the vault
> system doc had already flagged as a gotcha: the timer is `unref()`ed, so
> **quitting inside the 30-second window abandoned the clear**. Re-rated
> **Medium** — the promise was kept in the common case and broken on early quit,
> not broken on every use. Fixed; see the plan's step 1.
>
> The original text is kept below so the correction is auditable.

`Verified: code + run` · [electron/main.ts:629-636](../../electron/main.ts#L629-L636)

```ts
private copySensitiveValue(value: string): void {
  void clipboard.writeText(value);
  setTimeout(() => {
    void clipboard.readText().then((current) => {
      if (current === value) void clipboard.clear();
    });
  }, 30_000).unref();
}
```

Electron's `clipboard.readText()` is **synchronous and returns a string**. Calling
`.then` on a string throws `TypeError` inside the timer callback, so the clipboard
is never cleared. A copied password stays in the Windows clipboard indefinitely,
where Clipboard History (`Win+V`) may retain it and, if enabled, sync it to other
devices.

Two independent defects in six lines: even with the `.then` corrected, `.unref()`
means the timer does not keep the process alive, so quitting inside the 30-second
window skips the clear entirely.

What makes this **High** rather than Medium is that three places tell the user
otherwise:

| Where | Claim |
|---|---|
| [src/App.tsx:470](../../src/App.tsx#L470) | "Password copied; clipboard clears in 30 seconds" |
| [README.md](../../README.md) | "automatic clipboard clearing" |
| [SECURITY.md](../../SECURITY.md) | "cleared from the clipboard after 30 seconds if unchanged" |

The `SECURITY.md` sentence was **added during this audit**, in `5fcb148`. The drift
is getting worse, not better.

**Failure scenario.** The user copies a banking password, pastes it, and closes the
laptop believing the clipboard self-cleaned. It did not. Anyone with the machine,
or any app polling the clipboard, reads it.

---

#### F-02 — Every installer embeds a shared, non-revocable download token

`Verified: code + production` · [package.json:63-72](../../package.json#L63-L72), [.github/workflows/ci.yml:33-45](../../.github/workflows/ci.yml#L33-L45), [cloudflare/scripts/write-update-bootstrap.mjs](../../cloudflare/scripts/write-update-bootstrap.mjs)

CI writes `build/private-browser-update.json` containing
`{version, endpoint, accessToken}` from `secrets.PRIVATE_BROWSER_DOWNLOAD_TOKEN`,
and `electron-builder`'s `extraResources` bundles it into the installer. The
installer is then uploaded as a **GitHub artifact with 30-day retention** and to
the R2 bucket behind the public download page.

`DOWNLOAD_ACCESS_TOKEN` is a **single shared bearer token** for all clients
([cloudflare/src/index.ts:46](../../cloudflare/src/index.ts#L46)). Anyone who
obtains one installer — or read access to the artifact — can extract it and call
`/update.json` to mint signed download links for **every future release**. There is
no per-device credential and no revocation short of rotating the secret and
redeploying, which breaks every installed client at once.

`SECURITY.md` discloses this honestly and states the precondition: *"this test
token is not considered confidential and must be rotated before broader
distribution."* **Nothing enforces that precondition.** No check, no gate, no
reminder — it is a sentence in a document.

The desktop side is careful: the app copies the value into OS-encrypted storage
and deletes the bootstrap file ([electron/main.ts:708-714](../../electron/main.ts#L708-L714)).
That protects the token *after* install; it does nothing about the copy sitting
inside the `.exe` that anyone can unpack.

**Verified clean alongside it:** `build/private-browser-update.json` is correctly
git-ignored ([.gitignore:9](../../.gitignore#L9)) and is not present in the working
tree, so the token has not reached the repository.

**Recommendation before any distribution wider than one trusted machine:** rotate
the token, drop `extraResources`, and issue revocable per-device credentials.

---

#### F-03 — Publishing authorization has no negative test at all

`Verified: code + run` · [cloudflare/src/index.ts:162](../../cloudflare/src/index.ts#L162), [cloudflare/tests/worker.test.ts:135](../../cloudflare/tests/worker.test.ts#L135)

```ts
if (!(await isAdminAuthorized(request, env))) return notFound();
```

That single line is the only thing between the internet and the pointer that
decides which binary is "latest stable". Every test that touches the publish
endpoint sends the **correct** `x-api-key` — all three of them, at lines 135, 140
and 150. No test sends a wrong key, an empty key, or no key.

Delete that line, or invert it, and the entire 31-test suite still passes green.

By contrast the *client* download token does have a negative test
([worker.test.ts:71](../../cloudflare/tests/worker.test.ts#L71),
`authorization: 'Bearer wrong'`), which shows the gap is an oversight rather than
a decision.

**Failure scenario.** A refactor of the auth helpers silently breaks admin
authorization. CI is green. Anyone who finds the Worker URL can register a release
row pointing `latest.exe` at an R2 object of their choosing.

---

#### F-04 — A release can ship to storage and reach nobody

`Verified: code + production` · [electron/update-service.ts:63](../../electron/update-service.ts#L63), [.github/workflows/ci.yml:57](../../.github/workflows/ci.yml#L57), [cloudflare/scripts/publish-release.mjs:9-18](../../cloudflare/scripts/publish-release.mjs#L9-L18)

The release service and the update client disagree about what "newer" means.

- **The service** publishes on *every* push to `main`, with
  `buildNumber = GITHUB_RUN_NUMBER` and `version` read from `package.json`. There
  is no `paths` filter, so a docs-only commit produces a fresh installer with
  different bytes, a new R2 object, and a new active D1 row.
- **The client** decides on version alone:
  `compareVersions(manifest.version, currentVersion) > 0 ? 'available' : 'up-to-date'`.
  `buildNumber` is ignored.

Two consequences, both real:

1. **A security fix merged without a manual `package.json` bump is published and
   offered to no one.** Every installed client compares `0.3.1` to `0.3.1`, gets
   `0`, and reports "up to date". Nothing in CI bumps the version or checks that
   it changed.
2. **A version string no longer identifies a build.** Two people who install a week
   apart get different bytes under the same version number.

**This is not hypothetical, and it is about to happen.** Production is serving
build 7 (commit `5fcb148`), `origin/main` is at `5fcb148`, and two docs-only
commits sit unpushed locally:

```
63e5ee8 Point three docs' verified_at at an immutable commit
6268e71 Document every subsystem and guard the docs against accretion
```

Pushing them will build a new installer, register it as **build 8 of version
0.3.1**, and make it the active "latest stable" — and no installed 0.3.1 client
will ever be told. That is a prediction this report can be checked against.

---

### Medium

#### F-05 — Autofill compares the hostname but not the scheme

`Verified: code` · [electron/main.ts:397](../../electron/main.ts#L397)

```ts
if (new URL(credential.url).hostname !== new URL(tab.url).hostname) throw new Error('This credential belongs to another website');
```

Hostname only. `isAllowedRemoteUrl` permits `http:`
([electron/security.ts:33](../../electron/security.ts#L33)), so a credential saved
for `https://example.com` will fill on `http://example.com` — over the network in
cleartext, and reachable by anyone who can get the user to that URL on a hostile
network. `SECURITY.md` describes autofill as "restricted to an exact hostname
match", which is precisely and only true.

#### F-06 — The AI approval screen understates what leaves the machine

`Verified: code` · [src/App.tsx:363](../../src/App.tsx#L363), [:432](../../src/App.tsx#L432), [:436](../../src/App.tsx#L436)

The main process captures up to 12,000 characters and sends all of it
([electron/main.ts:304](../../electron/main.ts#L304),
[ai-provider.ts:59](../../electron/ai-provider.ts#L59)). The approval card renders
only sentences longer than 35 characters, capped at three, and tells the user:

> "Only the sanitized preview shown above can be passed to a connected AI provider."

On a page whose text is mostly short lines — an inbox, a table of orders, a
dashboard, a chat log — every fragment is filtered out and the card reads
**"No readable page text was found."** The user then approves, and up to 12,000
characters of that page go to the provider.

This is the one screen where the explicit consent the whole product rests on is
given, and it can understate the payload by orders of magnitude. `SECURITY.md`
claims "The user approves the exact sanitized preview" — the exact preview is
never shown.

The payload itself is sound: the text is pinned at capture time and the URL is
re-checked at both approve and ask, so page A's approval cannot send page B's
text. Only the label is wrong.

#### F-07 — Favicons are fetched by the privileged window, outside every isolation boundary

`Verified: code` · [src/App.tsx:215](../../src/App.tsx#L215), [index.html:5](../../index.html#L5), [electron/main.ts:89-95](../../electron/main.ts#L89-L95)

`tab.favicon` is an absolute URL the visited page chooses freely. The renderer puts
it straight into `<img src>`, and the chrome window is created with **no session or
partition**, so the request goes out on the default session. Tracker blocking and
the permission handlers are installed only on the per-workspace partitions
([main.ts:525-543](../../electron/main.ts#L525-L543), reached only via `ensureView`).

So a page can hand out a unique icon URL and: be fetched even when its host is on
the tracker blocklist while the toolbar shows blocking enabled; correlate activity
across all five "cookie-isolated" workspaces through one shared session, including
the protected Banking workspace. The fetch is automatic, needs no approval, and
writes no privacy-log entry.

It is also the *only* remote resource the trusted chrome loads at all — no remote
fonts, scripts or images exist anywhere else — so fixing it closes the whole class.

#### F-08 — Protected-page detection is fail-open, and misses most real banks

`Verified: code + run` · [electron/security.ts:60-68](../../electron/security.ts#L60-L68)

Executed against the actual regex:

| URL | Result |
|---|---|
| `https://www.attijariwafabank.com/fr` | protected |
| `https://cfgbank.com/login` | **not protected** |
| `https://www.sgmaroc.com/particuliers` | **not protected** |
| `https://www.creditagricole.ma` | **not protected** |
| `https://mail.google.com/mail/u/0` | **not protected** |

The hostname rule needs a literal `bank.` / `paypal.` / `wise.` / `revolut.` label;
the keyword rule is a hand-written list of six Moroccan institutions. Both
`README.md` and `SECURITY.md` promise "detected banking/payment pages reject page
extraction". The Banking *workspace* is genuinely protected
([state-store.ts:12](../../electron/state-store.ts#L12)), which is the real
mitigation — but it depends on the user having filed the site there.

#### F-09 — The Worker's test fakes discard what they are given

`Verified: code` · [cloudflare/tests/worker.test.ts:21](../../cloudflare/tests/worker.test.ts#L21), [:22-25](../../cloudflare/tests/worker.test.ts#L22), [:32](../../cloudflare/tests/worker.test.ts#L32)

Three compounding problems in the hand-written fakes:

1. `bind(...values) { this.values = values; return this; }` stores the parameters
   and **nothing in the file ever reads `.values`** (confirmed by grep — the only
   hit is the assignment). The publish test asserts `database.batches` is `1`,
   i.e. that a batch happened, never what was written. The insert could bind
   `sha256` into `object_key`, write `is_active = 0`, or omit the statement that
   deactivates the previous release, and the test still passes.
2. `first()` ignores the SQL's bound parameters and returns the same hard-coded
   `stable` row whatever `app_id` / `channel` was asked for. The channel dimension
   is never exercised; no test publishes or fetches a `beta` release.
3. [worker.test.ts:89](../../cloudflare/tests/worker.test.ts#L89) is an assertion
   that cannot fail — it calls `.replace()` on a literal with itself, so it reduces
   to asserting the page contains "Download Private Browser", a hard-coded string
   in the template ([page.ts:8](../../cloudflare/src/page.ts#L8)) present for every
   release. It reads like a filename check and is not one. `page.ts` never renders
   `release.filename` at all.

Also: the "rejects tampered and expired signed URLs" test sets a stale `expires`
**without re-signing**, so the corrupted signature from the previous line produces
the 404. Remove the expiry check from `handleBinary` entirely and the test stays
green — link expiry, the control that stops a leaked URL working forever, is not
actually tested.

#### F-10 — The production service can be deployed with failing tests

`Verified: code` · [.github/workflows/deploy-cloudflare.yml:48-49](../../.github/workflows/deploy-cloudflare.yml#L48-L49)

The only verification before deploying the Worker is `npm run worker:typecheck` —
types only. The test suite lives in `npm run check`, which runs in a **separate
workflow** with no `needs:`, no `workflow_run:` trigger and a different concurrency
group. A push touching `cloudflare/**` deploys to production in parallel with the
tests, and deploys even if they fail. `workflow_dispatch` lets anyone with write
access deploy any ref with no test gate whatsoever.

#### F-11 — Production secrets are in scope for `npm ci` lifecycle scripts

`Verified: code` · [.github/workflows/ci.yml:61](../../.github/workflows/ci.yml#L61), [deploy-cloudflare.yml:24](../../.github/workflows/deploy-cloudflare.yml#L24)

Both workflows declare secrets at **job** level, and both then run `npm ci` in that
job. A compromised transitive dependency's install script can read the full
production credential set — API token, account ID, admin key, download token,
signing secret — and exfiltrate it. Log masking does not stop a network call.
Moving the `env:` blocks onto the specific steps that need them costs nothing.

#### F-12 — The admin key is POSTed to whatever host a non-secret variable names

`Verified: code` · [.github/workflows/ci.yml:64](../../.github/workflows/ci.yml#L64), [cloudflare/scripts/publish-release.mjs:6](../../cloudflare/scripts/publish-release.mjs#L6)

`PRIVATE_BROWSER_DOWNLOAD_URL` comes from `vars.` — a GitHub **variable**, which is
unmasked in logs and edited under a weaker part of the settings UI than the secret
it protects. The script does no validation: no `https:` requirement, no host
allowlist, no `URL` parse. Point the variable at `http://…` and the admin key
crosses the network in clear; point it at another host and the key is handed to
that host.

The desktop client is stricter about the very same value
([update-service.ts:31](../../electron/update-service.ts#L31)), and the newer
`write-update-bootstrap.mjs` does validate its endpoint — so the pattern is known
in the codebase and simply missing here. `redirect: 'error'` is correctly set,
which closes the redirect variant.

#### F-13 — Nobody verifies the installer the user actually runs

`Verified: code` · [electron/main.ts:544-562](../../electron/main.ts#L544-L562), [package.json:24](../../package.json#L24)

CI's end-to-end check is genuinely strong — `verify-live-release.mjs` re-downloads
the published installer, compares SHA-256 against the locally built file, checks
ranges, and confirms unauthenticated requests get 404. That closes the pipeline
half of this.

The client half is open. The desktop app opens the download page in a tab; the
`will-download` handler records bytes and a save path and **never hashes anything**.
The manifest's `sha256` is validated only for *format*
([update-service.ts:119](../../electron/update-service.ts#L119)). The installer is
also unsigned (`--publish never`, no `certificateFile`), which `README.md` admits.
So the checksum shown to the user on the download page is presentation, not
verification: the real integrity chain is TLS plus the signed URL plus a size
check.

#### F-14 — The authenticator seed is typed into a visible, spellchecked field

`Verified: code` · [src/App.tsx:487-488](../../src/App.tsx#L487-L488)

The password field one line above is `type="password"`; the TOTP secret is not.
That seed is strictly more valuable than the password — it mints every future code
— and sits in cleartext on screen, with spellcheck on, for as long as the form is
open. The address bar sets `spellCheck={false}`; no vault field does.

#### F-15 — The bundled token survives in cleartext when OS encryption is unavailable

`Verified: code` · [electron/update-service.ts:44-49](../../electron/update-service.ts#L44-L49), [electron/main.ts:708-714](../../electron/main.ts#L708-L714)

`bootstrap()` returns `false` when `safeStorage.isEncryptionAvailable()` is false,
and `main.ts` only deletes the bootstrap file when it returns `true`. On a machine
where OS encryption is unavailable, the plaintext file holding the shared download
bearer token stays in the installed application directory indefinitely. That is
exactly the machine least able to protect it.

---

### Low

| # | Finding | Where |
|---|---|---|
| F-16 | Every security refusal renders with a green check. One toast component, always a check glyph in `--green`; "AI access is disabled for protected and banking pages" and "This credential belongs to another website" look identical to "Credential filled". | [src/App.tsx:259](../../src/App.tsx#L259), [styles.css:238](../../src/styles.css#L238) |
| F-17 | The shipped CSP still carries dev-server exceptions: `connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*`. Static file, no build-time transform. Latent widening — nothing in the renderer fetches today. | [index.html:5](../../index.html#L5) |
| F-18 | Settings shows a hardcoded green "Active" security badge that is a literal, not a check — it keeps claiming "encrypted secrets … Active" when the Vault panel correctly reports encryption unavailable. The adjacent version literal will drift at the next bump. | [src/App.tsx:597-598](../../src/App.tsx#L597-L598) |
| F-19 | The private-network guard misses three loopback spellings: `[::]`, `[::ffff:127.0.0.1]`, `localhost.`. **Low deliberately** — the endpoint is typed by the user in settings and reachable from no remote input, so this is a guardrail with holes, not an attacker path. | [electron/security.ts:78-92](../../electron/security.ts#L78-L92) |
| F-20 | Browsing history and bookmarks are stored as plaintext JSON. `mode: 0o600` does not create an owner-only ACL on Windows, the only supported platform — the `SECURITY.md` phrase "where the operating system supports them" is carrying real weight. | [electron/state-store.ts:62-67](../../electron/state-store.ts#L62-L67) |
| F-21 | `cancel-in-progress: true` on the publishing workflow can kill a run between the R2 upload and D1 registration, orphaning a ~114 MB object. Unreachable, so cost and confusion rather than a security break. The deploy workflow already gets this right. | [.github/workflows/ci.yml:11-13](../../.github/workflows/ci.yml#L11-L13) |
| F-22 | `cloudflare/scripts/*.mjs` are covered by no tsconfig (`allowJs: false`) and no test, yet they run only against production. `render-config.mjs` uses `String.replace` with a string pattern — first occurrence only; correct today with one placeholder, silently wrong with two. | [tsconfig.json:19](../../tsconfig.json#L19), [render-config.mjs:9](../../cloudflare/scripts/render-config.mjs#L9) |
| F-23 | Two assertions that prove less than their test names claim: the repaired-state check passes for any truthy string, including an id absent from `repaired.tabs`; and the redaction test would pass for a function returning empty text with a high count — nothing asserts non-sensitive text survives. | [tests/security.test.ts:59](../../tests/security.test.ts#L59), [:78](../../tests/security.test.ts#L78) |
| F-24 | "Clear page context" clears the panel but cannot revoke the approval — no `revoke` channel exists, so the captured text and live token stay in the main process for the full five minutes. | [src/App.tsx:441](../../src/App.tsx#L441) |
| F-25 | Secrets typed into the chrome survive a failed submit: the API key, vault password and download token are cleared only on success, and collapsing the form hides the inputs without clearing state. Defence in depth — unreachable by any page. | [src/App.tsx:389](../../src/App.tsx#L389), [:392](../../src/App.tsx#L392) |
| F-26 | Both downgrade guards — the handler's check and the D1 trigger — compare `build_number` only and are blind to `version`. Since `build_number` is `GITHUB_RUN_NUMBER`, a commit that *lowers* the version publishes as a higher build and becomes "latest stable". Existing installs are protected by accident, because the client only ever moves forward. | [cloudflare/src/index.ts:176](../../cloudflare/src/index.ts#L176), [0002_prevent_downgrades.sql:6](../../cloudflare/migrations/0002_prevent_downgrades.sql#L6) |

---

## 4. Production probe (read-only)

| Check | Result |
|---|---|
| Worker `private-browser-downloads` | deployed, 2 deployments on 2026-09-10 (15:59, 16:20) |
| Secrets installed | `ADMIN_API_KEY`, `DOWNLOAD_ACCESS_TOKEN`, `SIGNING_SECRET` — **names only; no value was read** |
| D1 `private-browser-releases` | exists, `94bf4206-…`; migrations applied (`d1_migrations`, `releases` present) |
| R2 `private-browser-releases` | exists, created 2026-09-10T15:59:05Z |
| Active release | `stable-0.3.1-7` · v0.3.1 · build 7 · commit `5fcb148` · 113,832,271 bytes · 2026-09-10T17:08:19Z |
| Previous release | `stable-0.3.0-6` · commit `d0102bf` · correctly `is_active = 0` |
| Deployed vs audited commit | production runs `5fcb148`; audited `63e5ee8` is 2 **docs-only** commits ahead, unpushed |

**Verified positive:** exactly one active release per channel, with the prior build
correctly deactivated. The activation logic works in production, not just in tests.

### COULD NOT CHECK

- **`GET /health` against the live Worker.** The `workers.dev` hostname is not
  recorded in the repository (`wrangler.jsonc` declares no route or custom domain)
  and `PRIVATE_BROWSER_DOWNLOAD_URL` is a GitHub variable not present on this
  machine. This would have settled whether `secretsReady` passes at runtime and
  whether `releaseReady` is true — i.e. whether the R2 object behind build 7 is
  actually fetchable, rather than merely referenced by a D1 row.
- **Whether SQLite fires the `BEFORE INSERT` downgrade trigger on the
  `ON CONFLICT … DO UPDATE` path.** This decides whether the database-level guard
  backs up the handler on a republish of an existing id, or only on genuinely new
  rows. Settled by one local `sqlite3` session running the handler's exact upsert
  twice with a decreasing build number.

Neither gap was guessed at.

---

## 5. Candidates dropped or corrected — seven

An audit that drops nothing did not verify.

| Candidate | Why it was dropped |
|---|---|
| Decimal-IP bypass of the private-network guard (`https://2130706433/`) | **Wrong.** Node's URL parser normalises it to `127.0.0.1`; blocked. |
| Hex-IP bypass (`https://0x7f000001/`) | **Wrong.** Same normalisation; blocked. |
| `SECURITY.md` claims "No AI vendor, API key or automatic cloud transmission ships in this release" | **Fixed mid-audit** by `5fcb148`. That line is gone and the section is now accurate. |
| No `docs/systems/` per-subsystem documentation exists | **Fixed mid-audit** by `6268e71` — eight subsystem docs plus a guard and a pre-commit hook now exist. |
| Settings' version fallback has already drifted from `package.json` | **Wrong at HEAD.** `package.json` is now `0.3.1` and the literal matches. Reduced to the latent-drift half, F-18. |
| The manifest `sha256` is never verified anywhere | **Half wrong.** `verify-live-release.mjs` verifies it end-to-end in CI. Narrowed to the client side only — F-13. |
| The bundled token file could be committed | **Not a finding.** Correctly git-ignored and absent from the tree. |

---

## 6. Must-fix before release

| # | Finding | Why it blocks |
|---|---|---|
| ~~**F-01**~~ | ~~Clipboard never clears, three docs say it does~~ | **Corrected and downgraded to Medium — see the correction note on F-01. The `.then` claim was wrong; Electron 44's clipboard is asynchronous. The surviving defect (quitting abandoned the clear) is fixed.** |
| **F-02** | Shared download token inside every installer | The release cannot go past one trusted machine until this is rotated and removed. Nothing enforces the precondition the security document states. |
| **F-03** | No negative test on publish authorization | The single gate protecting "latest stable" is unverified. Two tests close it. |
| **F-04** | Version-only comparison + publish-on-every-push | A security fix can ship to storage and reach nobody. Also makes "0.3.1" stop identifying a build. |

F-05 through F-08 should follow immediately; they are the ones a user could hit
this week.

## 7. Suggested order of work

1. **F-01** — delete `.then`, drop `.unref()`, clear on `before-quit`. Then correct
   the three documents. Add a test.
2. **F-03** — two tests: no `x-api-key`, wrong `x-api-key`, both expecting 404 and
   no write.
3. **F-04** — add a `paths-ignore` for docs to the publish job, and fail it when
   `package.json`'s version equals the active release's version.
4. **F-02** — rotate the token; decide whether `extraResources` ships at all.
5. **F-05**, **F-14**, **F-16** — small, contained, user-visible.
6. **F-06**, **F-07**, **F-08** — the privacy-claim group; each needs a design call.
7. **F-09**, **F-23** — make the fakes assert what was bound; delete the unfailable
   assertion.
8. **F-10**, **F-11**, **F-12** — pipeline hardening.

## 8. Verdict

**Not ready to ship as a public release. Suitable to continue as a single-user
private build**, which is what the embedded shared token already assumes.

The engineering is markedly better than most code at this stage: the IPC surface is
sender-checked, remote pages get no preload, the Worker fails closed when its
secrets are missing, signed links are purpose-bound and expiring, the CI download
verification is genuinely thorough, and production shows exactly one active release
with the previous one correctly retired. Dependencies are clean in both production
and dev, and no test is skipped anywhere.

What holds it back is a specific and fixable pattern: **the documents and the
interface describe a product slightly safer than the code delivers.** The AI
approval card that says "shown above" while hiding 12,000 characters, the
"detected banking pages" claim that misses most Moroccan banks, and the hardcoded
green "Active" security badge are all the same shape. In a product whose entire
value proposition is a privacy guarantee, that gap is the thing to close first,
because a user who trusts a promise the code does not keep takes risks they would
otherwise have avoided.

**F-01 was itself an instance of the pattern, from the auditor's side.** It was
published as a High finding asserting the clipboard never clears, and that was
wrong — the claim came from Electron's older synchronous signature rather than
from the installed types. The real defect was narrower. It is corrected in place
above rather than quietly deleted, because an audit that edits away its own
mistakes is worth less than one that shows them.

Three must-fixes, none of them architectural. The heaviest is a policy decision
about the bundled token, not a rewrite.

---

*Findings are numbered `F-NN` and that numbering continues in any future audit —
renumbering would break every commit message that cites one. Sections `Status`,
`Found while fixing` and `What still needs a person` are deliberately absent; they
belong to whoever works this list.*
