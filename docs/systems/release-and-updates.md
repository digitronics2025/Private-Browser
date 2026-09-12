---
system: release-and-updates
sources:
  - cloudflare/src/**
  - cloudflare/migrations/**
  - cloudflare/wrangler.jsonc
  - cloudflare/scripts/**
  - .github/workflows/**
  - electron/update-service.ts
  - electron/update-bootstrap.ts
  - scripts/stage-vsix.mjs
  - vscode-extension/package.json
verified_at: eec0d54
---

# Release and Updates

> Last verified: 2026-09-12

## Agent Brief

**Scope.** The whole path from a commit on `main` to an installed update: CI
builds a Windows installer, uploads it to R2, registers its metadata in D1, and a
Cloudflare Worker hands the desktop app a signed, expiring manifest that the app
validates before it will show anyone a download link.

**This doc spans two deployables. Pick your half.**

- **The service** — the Worker, its D1 schema, its R2 bucket, and the two GitHub
  workflows that deploy and feed it. Sections: **Worker Routes** through
  **The Windows Installer**.
- **The desktop client** — one file, [update-service.ts](../../electron/update-service.ts),
  which fetches and validates a manifest and decides whether an update exists.
  Sections: **Desktop Update Client** through **Version Comparison and Polling**.

**Not covered here:** the Settings panel ([renderer-ui.md](renderer-ui.md)), the
`updates:*` channels ([ipc-contract.md](ipc-contract.md)), the window/tab/timer
plumbing in `electron/main.ts` ([browser-shell.md](browser-shell.md)), and
`isSafeUpdateEndpoint` / `safeStorage`
([security-boundary.md](security-boundary.md)).

### Invariants

1. **A rejected credential must return 404, never 401 or 403.** A wrong token
   and a route that does not exist must be indistinguishable, so the service
   cannot be probed. → **Worker Authentication**
2. **Missing or short secrets fail closed.** `secretsReady` gates every release
   route, including the public page because it must sign installer links; without
   all three secrets at 32+ characters the Worker serves 404 everywhere and 503
   on `/health`. Never add a route that skips it. → **Worker Authentication**
3. **An active release can never be replaced by a lower build number** inside one
   `app_id` + `channel`. This is enforced by database triggers, not by the
   handler. → **Database Tables**
4. **No real account id, database id or secret value goes into a tracked file or
   this doc.** Names only; the tracked `database_id` is a zero placeholder.
   → **Bindings and Configuration**
5. **The client accepts only `https` links on its own configured origin, at two
   exact paths.** Loosening this lets a compromised service point a user at any
   host. → **Manifest Validation**
6. **`ReleaseManifest` is declared in two files under two tsconfigs.** No
   compiler compares them; only runtime validation on a user's machine does.
   Change one, change the other. → **Gotchas**

### Where to look

<!-- routing:start -->

| You are changing… | Section |
| --- | --- |
| adding, removing or changing a URL the Worker answers | [Worker Routes](#worker-routes) |
| who may call a route, or what a rejection looks like | [Worker Authentication](#worker-authentication) |
| the expiring link, its lifetime, or what it signs | [Signed Download Links](#signed-download-links) |
| resumable downloads and partial-content responses | [Range Serving](#range-serving) |
| a column, index or trigger on the releases table | [Database Tables](#database-tables) |
| a binding, a var, or how deploy config is rendered | [Bindings and Configuration](#bindings-and-configuration) |
| a CI job, or how a build reaches R2 and D1 | [The Build and Publish Pipeline](#the-build-and-publish-pipeline) |
| the installer filename, target or packaged files | [The Windows Installer](#the-windows-installer) |
| how the app stores and uses its download credentials | [Desktop Update Client](#desktop-update-client) |
| a field the app will accept back from the service | [Manifest Validation](#manifest-validation) |
| when the app checks, and what counts as newer | [Version Comparison and Polling](#version-comparison-and-polling) |
| anything that has to be changed in two places at once | [Gotchas](#gotchas) |

<!-- routing:end -->

### Before you write

- Read [index.ts](../../cloudflare/src/index.ts) before adding a route; the
  security headers, the `secretsReady` gate and the 404-for-everything
  convention are applied per handler, not by middleware.
- Test both validators when you change a manifest field —
  `cloudflare/tests/worker.test.ts` and `tests/update-service.test.ts` are
  separate Vitest projects, both run by `npm run check`.
- Never widen a signed-URL rule to make a test pass; the tests that reject
  another origin and an unexpected path are the feature.
- D1 migrations are forward-only, applied `--remote` from CI, and must never
  weaken the downgrade triggers.
- Changing the electron-builder block in `package.json` means updating
  **The Windows Installer** by hand — that file is not in `sources`.

## Overview

Two deployables, one contract. The Worker
(`private-browser-downloads`) stores release metadata in D1 and installers in R2.
Its public landing page exposes the active stable release and five prior releases,
then creates a fresh HMAC-signed installer URL; R2 itself remains private. The
desktop app stores a separate client token encrypted at rest, calls `/update.json`
on a schedule, and refuses any manifest that does not match a strict
field-by-field contract. No release route is cacheable.

## Worker Routes

[index.ts](../../cloudflare/src/index.ts) routes on exact pathname. Anything
unmatched is 404; an unhandled throw logs `request_failed` with the path and
message and returns 500 `internal_error`.

| Route | Methods | Auth | Behaviour |
| --- | --- | --- | --- |
| `/health` | GET, HEAD | none | 503 `{status:'degraded'}` if `secretsReady` is false or the D1 query throws. Otherwise 200 `{status:'ok', service, database:'ok', releaseReady}`, where `releaseReady` is whether the newest active release's R2 object exists. `cache-control: no-store`. |
| `/` | GET, HEAD | none | `handlePublicDownloadPage`. Renders the canonical public page, current release, five previous stable releases and a freshly signed installer URL. |
| `/api/v1/releases/latest` | GET, HEAD | client bearer | `handleLatest`. 404 on bad token or no release. Returns the signed manifest; HEAD returns the headers with no body. |
| `/update.json` | GET, HEAD | client bearer | **The same handler.** This is the path the desktop client calls. |
| `/api/v1/admin/releases` | POST | admin `x-api-key` | `handlePublish`. Registers a release. See below. |
| `/download` | GET, HEAD | none | Alias of the canonical public page. Existing signed manifest URLs continue to work, but each page load creates a new installer signature rather than extending or reusing the query expiry. |
| `/download/<token>` | GET, HEAD | client token in path | `handleStableDownloadPage`. Permanent private entry page for a human browser; always shows the active release and mints a fresh signed installer link on each load. Wrong tokens return the generic 404. |
| `/download/latest.exe` | GET, HEAD | signed link | `handleBinary`. Streams the R2 object, with single-range support. |

`releaseHistory` reads only the same `app_id` and stable channel, excludes the
active row, orders by `published_at DESC` then build number, and returns at most
five records. The query is sequential after `latestRelease`; the Worker does not
run dependent D1 reads in parallel. History is informational and does not expose
download URLs for old installers.

[page.ts](../../cloudflare/src/page.ts) receives a typed page model: active
release, history, signed download URL, canonical origin, render timestamp and the
fixed public developer profile. It emits one script-free responsive document
with semantic headings, UTC-backed `<time>` values, release notes, source commit,
checksum, install steps and the developer profile link. Every D1 value is escaped
before interpolation.

`handlePublish` in order: 405 unless POST → 404 unless admin-authorised → 415
unless `content-type` starts with `application/json` → 400 `invalid_release` if
`validateReleaseInput` throws → 409 `r2_object_missing_or_size_mismatch` if
`RELEASES.head(objectKey)` is absent or its size differs from `sizeBytes` → 409
`release_downgrade_rejected` if the current active row has a higher build number,
or the same build number under a different id or version → 409
`release_version_not_bumped` if a *different* release is being published at a
version that is not higher than the active one (`compareSemver(input.version,
current.version) <= 0`) → otherwise a D1 `batch`
that upserts the row (`ON CONFLICT(id) DO UPDATE`) and flips every other row of
that `app_id` + `channel` to `is_active = 0`, then 201.

Default id when the caller omits one: `<channel>-<version>-<buildNumber>`.

**Response headers.** Every response passes through `responseHeaders`, which sets
`x-content-type-options: nosniff`, `referrer-policy: no-referrer`,
`x-frame-options: DENY` and a `permissions-policy` disabling camera, microphone,
geolocation, payment and USB. Everything except `/health` uses `cache-control:
private, no-store, max-age=0`; public visibility does not make expiring links
cacheable. Download pages add a script-blocking CSP (`default-src 'none';
style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; base-uri
'none'; form-action 'none'; frame-ancestors 'none'`). `/` and `/download` carry
`x-robots-tag: index, follow`; `/download/<token>` remains `noindex, nofollow,
noarchive`.

## Worker Authentication

Two distinct levels, and they never overlap.

| Level | Function | Credential | Header | Routes |
| --- | --- | --- | --- | --- |
| Client | `isClientAuthorized` | `DOWNLOAD_ACCESS_TOKEN` | `authorization: Bearer <token>` | `/api/v1/releases/latest`, `/update.json` |
| Install page | `handleStableDownloadPage` | `DOWNLOAD_ACCESS_TOKEN` | final `/download/<token>` path segment | Stable human-facing install page; token is compared in constant time and never rendered into the HTML. |
| Admin | `isAdminAuthorized` | `ADMIN_API_KEY` | `x-api-key` | `POST /api/v1/admin/releases` |

`/` and `/download` are intentionally public but still require `secretsReady`
because their installer CTA must be signed. `/download/latest.exe` is authorised
only by its signed link. `/download/<token>` is the persistent private entry point:
it validates `DOWNLOAD_ACCESS_TOKEN` directly, then creates a fresh signed
binary URL without echoing the token into the HTML. The tokenized URL remains
valid until that Worker secret is rotated, so it belongs in a private bookmark,
not messages, screenshots, logs or public documentation.

**Both failures return `notFound()` — a 404 identical to an unknown path.** A
caller cannot tell a wrong token from a route that does not exist, and
`cloudflare/tests/worker.test.ts` asserts exactly that.

**Constant-time compare.** `constantTimeEqual` in
[auth.ts](../../cloudflare/src/auth.ts) hashes both sides with SHA-256 and
XOR-accumulates the digest bytes, so the comparison takes the same time
regardless of how much of the secret matched, and leaks nothing through length.

**`secretsReady(env)`** requires all three of `DOWNLOAD_ACCESS_TOKEN`,
`SIGNING_SECRET` and `ADMIN_API_KEY` to be at least 32 characters. It is checked
inside both auth helpers and at the top of `/`, `/download`,
`/download/latest.exe` and `/health`. If any secret is absent or short, the
Worker serves 404 on every release route and 503 `degraded` on `/health` — it
never serves a release with a weak key, and it never explains why.

## Signed Download Links

`signedManifest` mints two HMAC-SHA-256 signatures over deliberately different
payloads, base64url-encoded without padding:

| Link | Signed payload | Path checked |
| --- | --- | --- |
| Download page | `page\n<expires>` | `/download` (wire compatibility; the page is now public) |
| Installer | `binary\n<release.id>\n<expires>` | `/download/latest.exe` |

Because the binary payload includes the release id, a link signed for one release
does not validate against another; because the two payloads are prefixed
differently, a page signature can never be replayed as a binary signature. The
origin is taken from the incoming request URL, so the manifest always points at
the host the client actually reached.

**TTL.** `LINK_TTL_SECONDS` is a plain var, `"900"` in
[wrangler.jsonc](../../cloudflare/wrangler.jsonc). `normalizeTtl` falls back to
`DEFAULT_LINK_TTL_SECONDS` (900) when the value is not a safe integer, then
clamps into `[60, MAX_LINK_TTL_SECONDS]` where the maximum is 86 400 seconds.
`expires` is `floor(now/1000) + ttl`; the manifest also carries it as ISO-8601
`expiresAt`.

**Verification is belt and braces.** `isLiveExpiry` requires the query `expires`
to be exactly ten digits, a safe integer, strictly in the future and no more than
24 hours ahead — so a signature forged with a far-future expiry is rejected before
the signature is even checked. `verifySignedValue` then rejects an empty
signature or one longer than 100 characters, and otherwise compares in constant
time.

The manifest retains a signed `/download` URL because existing desktop clients
validate that exact schema, origin and query shape. The route itself is public and
ignores the legacy page signature; every visit to `/` or `/download` mints a new
installer expiry and signature. `/download/<token>` does the same only after its
constant-time token check. Every actual R2 installer link therefore remains
short-lived even though the landing page is public and bookmarkable.

## Range Serving

`parseSingleRange` in [protocol.ts](../../cloudflare/src/protocol.ts) returns
three things, and the caller treats each differently:

| Return | Meaning | Response |
| --- | --- | --- |
| `undefined` | no `Range` header | 200, full body, `content-length: size` |
| a `ByteRange` | one satisfiable range | 206, `content-range: bytes start-end/size`, `content-length: length` |
| `null` | malformed or unsatisfiable | 416 with `content-range: bytes */size` |

Rejected as `null`: **any header containing a comma** — multi-range requests are
not supported at all, deliberately, rather than being partially honoured; a
header not starting `bytes=`; anything not matching `^bytes=(\d*)-(\d*)$`; both
halves empty; a suffix of zero or a suffix against a zero-length object; a start
at or beyond the object size; an end below the start. An end past the last byte
is clamped instead of rejected.

Before any of that, `handleBinary` calls `RELEASES.head(object_key)` and requires
the object to exist **and** its size to equal the D1 `size_bytes`. A metadata row
whose R2 object has drifted returns 404 rather than a truncated installer.

Binary responses always carry `accept-ranges: bytes`, the R2 `httpEtag`,
`x-checksum-sha256` from the D1 row, and `content-disposition: attachment` with
`"`, `\`, CR and LF stripped out of the filename. HEAD returns the same headers
and status with no body.

## Database Tables

Migrations live in [cloudflare/migrations](../../cloudflare/migrations) and are
applied `--remote` by the deploy workflow.

**`releases`** ([0001_releases.sql](../../cloudflare/migrations/0001_releases.sql))
— one row per published build, global (there is no tenant concept).

| Column | Type and constraint |
| --- | --- |
| `id` | TEXT PRIMARY KEY |
| `app_id` | TEXT NOT NULL — always `private-browser` (the `APP_ID` const) |
| `version` | TEXT NOT NULL |
| `build_number` | INTEGER NOT NULL, CHECK > 0 |
| `channel` | TEXT NOT NULL, CHECK IN (`stable`, `beta`) |
| `object_key` | TEXT NOT NULL **UNIQUE** — the R2 key |
| `filename` | TEXT NOT NULL |
| `content_type` | TEXT NOT NULL |
| `size_bytes` | INTEGER NOT NULL, CHECK > 0 |
| `sha256` | TEXT NOT NULL, CHECK length = 64 |
| `commit_sha` | TEXT NOT NULL |
| `release_notes` | TEXT NOT NULL DEFAULT `''` |
| `published_at` | TEXT NOT NULL |
| `is_active` | INTEGER NOT NULL DEFAULT 0, CHECK IN (0, 1) |
| `created_at` | TEXT NOT NULL DEFAULT `strftime('%Y-%m-%dT%H:%M:%fZ','now')` |

`idx_releases_latest` on `(app_id, channel, is_active, build_number DESC,
published_at DESC)` — the exact shape of the `latestRelease` query, which is run
on every authorised request.

**The downgrade invariant**
([0002_prevent_downgrades.sql](../../cloudflare/migrations/0002_prevent_downgrades.sql))
— two `BEFORE` triggers, both ending in `SELECT RAISE(ABORT, 'release downgrade
rejected')`:

| Trigger | Fires on | Condition |
| --- | --- | --- |
| `prevent_active_release_insert_downgrade` | BEFORE INSERT | `NEW.is_active = 1` and an active row with the same `app_id` + `channel` has a higher `build_number` |
| `prevent_active_release_update_downgrade` | BEFORE UPDATE OF `build_number`, `is_active` | the same, excluding the row being updated by `id` |

State this plainly: **within one `app_id` and `channel`, a newer build number can
never be superseded by an older one.** The database refuses it. The Worker's
409 in `handlePublish` checks the same thing first, but that check is a courtesy
that returns a clean error — the trigger is the guarantee, and it holds against a
hand-run `wrangler d1 execute`, a bug in the handler, or any future second
writer.

## Bindings and Configuration

[wrangler.jsonc](../../cloudflare/wrangler.jsonc):

| Setting | Value |
| --- | --- |
| Worker name | `private-browser-downloads` |
| `main` | `src/index.ts` |
| `compatibility_date` | `2026-09-01` |
| `compatibility_flags` | `nodejs_compat` |
| D1 binding | `DB` → database `private-browser-releases`, `migrations_dir: migrations` |
| R2 binding | `RELEASES` → bucket `private-browser-releases` |
| `vars` | `LINK_TTL_SECONDS: "900"` |
| `observability` | enabled, `head_sampling_rate: 1` (every request sampled) |

Secrets, **by name only** — the values live in GitHub repository settings and in
the Worker, never in this repo.

| Worker secret | Installed from | Used for |
| --- | --- | --- |
| `DOWNLOAD_ACCESS_TOKEN` | `secrets.PRIVATE_BROWSER_DOWNLOAD_TOKEN` | the desktop client's bearer token |
| `SIGNING_SECRET` | `secrets.PRIVATE_BROWSER_SIGNING_SECRET` | HMAC for the expiring links |
| `ADMIN_API_KEY` | `secrets.PRIVATE_BROWSER_ADMIN_API_KEY` | `x-api-key` on the publish route |

The workflows additionally read `secrets.CLOUDFLARE_API_TOKEN`,
`secrets.CLOUDFLARE_ACCOUNT_ID`, `secrets.CLOUDFLARE_D1_DATABASE_ID` (deploy
only) and `vars.PRIVATE_BROWSER_DOWNLOAD_URL` — a repository **variable**, not a
secret, because it is just the Worker's public URL.

**The `database_id` in the tracked file is a placeholder of all zeros.** It is
not the real database. [render-config.mjs](../../cloudflare/scripts/render-config.mjs)
reads `CLOUDFLARE_D1_DATABASE_ID` from the environment, checks it against
`/^[a-f0-9-]{36}$/i`, substitutes the placeholder string, and writes
`cloudflare/wrangler.deploy.jsonc` with file mode `0600`. That rendered file is
gitignored and every deploy command is pointed at it with `--config`. Local
`worker:dev` and `worker:build` use the placeholder file and never touch the real
database. Do not write a real account id, database id or secret value into any
tracked file or into this doc.

### Local Cloudflare Authentication and Live Verification

Wrangler loads the repository-root `.env` itself. PowerShell does not import
that file into its parent process, so `$env:CLOUDFLARE_API_TOKEN` can be empty
while the repository-pinned CLI is fully authenticated. **Do not treat an empty
PowerShell variable as proof that Cloudflare is unreachable.** Ask Wrangler:

```powershell
npx wrangler whoami
npx wrangler deployments status --config cloudflare/wrangler.jsonc
npx wrangler d1 list --json
npx wrangler r2 bucket list
npx wrangler secret list --config cloudflare/wrangler.jsonc
```

Use `npx wrangler`, not a globally installed copy, so the checked CLI version is
the version pinned by this repository. `r2 bucket list` has no `--json` option.
Secret-list commands are for **names only**; never print, echo, source, or call
`wrangler auth token` in an agent transcript. If the CLI really cannot
authenticate, the operator must retrieve or rotate the credential through
MyVault and enter it by hand.

The public Worker origin is the GitHub repository variable
`PRIVATE_BROWSER_DOWNLOAD_URL`, not a secret and not a value tracked in this
repository. Retrieve it at check time and probe the unauthenticated health route:

```powershell
$url = gh variable get PRIVATE_BROWSER_DOWNLOAD_URL
$response = Invoke-WebRequest -Uri ($url.TrimEnd('/') + '/health') `
  -UseBasicParsing -TimeoutSec 20
$response.StatusCode
$response.Content
```

Healthy production returns HTTP 200 with `status: "ok"`, `database: "ok"`, and
`releaseReady: true`. This verifies more than a deployment listing: it proves
the Worker can query D1 and can find the active release object in R2. Keep `.env`
ignored and untracked; do not copy its credential into tracked configuration or
documentation merely to make a raw shell-variable check pass.

## The Build and Publish Pipeline

Account Spaces adds two CI gates before publication. Ubuntu installs Playwright
Chromium and runs credential-free renderer E2E as part of `npm run check`;
`scripts/run-electron-tests.mjs` wraps the Electron suite in `xvfb-run` on Linux.
The Windows installer job also runs the real Electron suite before packaging, so
the published artifact is gated by actual partition-isolation and workspace-policy
checks in addition to unit and Worker tests.

### ci.yml

[ci.yml](../../.github/workflows/ci.yml) — on every push to `main` and every pull
request. `permissions: contents: read`; concurrency per ref with
`cancel-in-progress: true`. Node 22 with npm cache in all three jobs.

**No job declares secrets.** Every credential is attached to the one step that
uses it, so `npm ci` and the test suite never run with production values in their
environment where a dependency's install script could read them (audit finding
F-11). `publish-cloudflare-release` overrides the workflow concurrency with its
own group and `cancel-in-progress: false`: the ref-level group could otherwise
kill it between the R2 upload and the D1 registration and strand a ~114 MB object
nothing references (F-21).

**A documentation-only push publishes nothing.** The publish job checks out at
`fetch-depth: 0`, diffs against `github.event.before` (falling back to `HEAD~1`
when that ref is absent or all-zeros), and skips when every changed path is under
`docs/` or a top-level `.md`. Before this, every push to `main` minted a new
active release — including docs commits (F-04).

**Application releases are versioned automatically.** On a `main` push,
`prepare-release-version.mjs` reads the authenticated active manifest. It keeps
a manually raised stable version from `package.json`, or increments the active
patch version when the declared version is not higher. The Windows job patches
both package files only in its runner, builds that version and adds `VERSION.txt`
to the artifact. The publish job restores that exact version before writing R2
and D1, so the installer filename, object key and manifest cannot disagree.

| Job | Runs on | Does |
| --- | --- | --- |
| `verify` | ubuntu, 15 min | `npm ci`, `npm audit --audit-level=high`, `npm run check` (typecheck → worker typecheck → both Vitest projects → Vite/Electron build → `wrangler deploy --dry-run`) |
| `windows-installer` | windows, 25 min, needs `verify` | Runs the Electron MyVault boundary and Windows named-pipe journeys, selects the stable version on `main`, writes the bundled update bootstrap, runs `npm run dist`, writes checksum, version and CycloneDX SBOM artifacts, smoke-installs the VSIX in an isolated profile, and uploads both private artifacts for 30 days |
| `publish-cloudflare-release` | ubuntu, 15 min, needs `windows-installer`, push-to-`main` only | Restores the artifact's recorded version, skips documentation-only pushes, otherwise uploads the exe to R2, registers metadata in D1, then re-downloads it through the live authenticated route to prove the whole path works ([verify-live-release.mjs](../../cloudflare/scripts/verify-live-release.mjs)) |

### codeql.yml

[codeql.yml](../../.github/workflows/codeql.yml) runs GitHub CodeQL's
`security-extended` JavaScript/TypeScript queries on pushes to `main`, pull
requests, and every Monday. It has read-only repository access plus the minimum
`security-events: write` permission required to publish findings.

The publish job validates `VERSION.txt`, applies it to its local package files
with npm's same-version mode enabled (the selected stable version may already be
declared), then uploads with
`wrangler r2 object put private-browser-releases/releases/<version>/<run-number>/<basename> --file <exe> --content-type application/vnd.microsoft.portable-executable --remote`,
then runs
[publish-release.mjs](../../cloudflare/scripts/publish-release.mjs), which reads
the version from `package.json`, takes `buildNumber` from `GITHUB_RUN_NUMBER` and
`commitSha` from `GITHUB_SHA`, computes the installer's SHA-256 and size locally,
and POSTs the metadata to `<PRIVATE_BROWSER_DOWNLOAD_URL>/api/v1/admin/releases`
with `redirect: 'error'` and a 30-second timeout, throwing with the first 500
characters of the body on any non-2xx.

**Both Cloudflare jobs no-op gracefully.** A "Detect … configuration" step writes
`ready=true` to `$GITHUB_OUTPUT` only when every required credential is present
— including `PRIVATE_BROWSER_DOWNLOAD_TOKEN` at 32 characters or more —
and each subsequent step is gated on it. With no secrets the job prints
"Cloudflare release publishing is not configured; the verified GitHub artifact
remains available" and **succeeds** — a fork or a fresh clone gets a green build
and a downloadable installer, not a wall of failures.

### deploy-cloudflare.yml

[deploy-cloudflare.yml](../../.github/workflows/deploy-cloudflare.yml) —
`workflow_dispatch`, plus pushes to `main` that touch `cloudflare/**`,
`package.json`, `package-lock.json` or the workflow file itself. Concurrency
group `private-browser-cloudflare-production` with **`cancel-in-progress:
false`** — a production deploy is never cancelled mid-flight by a following push.

**It runs the whole gate before touching production.** `npm run check` runs
before the migration and deploy steps. It previously ran `worker:typecheck`
alone, while the tests lived in a separate workflow with no dependency between
them, so a push touching `cloudflare/**` could deploy with failing tests and
`workflow_dispatch` was gated by nothing at all (F-10).

Its gate is stricter than the publish job's: ready only when the API token,
account id and D1 database id are all non-empty **and** all three Worker secrets
are at least 32 characters — the same threshold `secretsReady` enforces at
runtime, so a deploy that would fail closed never happens.

Push runs fetch both sides of the push and compare the Cloudflare tree plus the
root package manifests. A workflow-only repair therefore completes without
redeploying an unchanged Worker; manual dispatches remain an explicit request to
release. When the production target did change, CI installs Playwright Chromium
before `npm run check`, because that full gate includes the renderer E2E suite.

Steps, in order, all gated:

1. `npx playwright install --with-deps chromium`
2. `npm run check`
3. `node cloudflare/scripts/render-config.mjs` — writes `wrangler.deploy.jsonc`
4. `wrangler d1 migrations apply DB --remote --config cloudflare/wrangler.deploy.jsonc`
5. `wrangler deploy --config cloudflare/wrangler.deploy.jsonc --keep-vars`
6. `wrangler secret bulk` fed a JSON object of the three secrets on stdin

Migrations run before the deploy; secrets are installed after it.

### The release scripts

`cloudflare/scripts/*.mjs` run only against production, on a push to `main`, so a
mistake in them used to surface live. They are now type-checked by
`npm run scripts:typecheck`
([tsconfig.scripts.json](../../cloudflare/tsconfig.scripts.json), `checkJs` with
`strictNullChecks` on and `noImplicitAny` off) inside the gate — F-22.

Both scripts that carry a credential call `requireHttpsEndpoint`
([require-https-endpoint.mjs](../../cloudflare/scripts/require-https-endpoint.mjs))
before their first request: a bare public HTTPS origin, no embedded credentials,
no path, no query, no private host. `PRIVATE_BROWSER_DOWNLOAD_URL` is a GitHub
*variable*, not a secret — unmasked in logs, edited through a weaker part of the
settings UI than the admin key it addresses — and was used unvalidated, so
editing one field could redirect that key to another host or downgrade it to
plain HTTP (F-12).

`render-config.mjs` replaces every occurrence of the database-id placeholder and
throws unless there is exactly one; a string-pattern `replace` substitutes only
the first, so a second binding added later would silently keep the placeholder.

## The Windows Installer

The electron-builder configuration lives **inline in `package.json`**, in the
`build` block. In prose, because that file is not one of this doc's `sources`:

- `appId` `ma.digitronics.privatebrowser`, `productName` "Private Browser",
  `asar: true`, output directory `release`, packaged files `dist/**`,
  `dist-electron/**` and `package.json`.
- Windows target `nsis`, x64, icon `build/icon.ico`, artifact name
  `Private-Browser-${version}-Setup.${ext}` — which is what makes the produced
  filename match both the Worker's and the client's `.exe` filename rules.
- NSIS: not one-click, the install directory can be changed, desktop and Start
  Menu shortcuts are created.
- `npm run dist` builds the extension and app, runs electron-builder with `--publish
  never`, then performs the versioned VSIX staging step. `--publish never` is
  deliberate: electron-builder uploads nothing, and the Cloudflare job is the
  only installer publisher.
- The versioned `release/private-browser-bridge-*.vsix` is generated by `@vscode/vsce`.
  Its standalone filename is derived from the extension manifest version, not
  the independently versioned desktop browser, so browser 0.5.x releases still
  publish `private-browser-bridge-0.4.0.vsix` while the extension remains 0.4.0.
  It is validated for its manifest and forbidden contents, installed into a fresh
  `--user-data-dir`/`--extensions-dir` profile in Windows CI, and uploaded as a
  private Actions artifact. The smoke test resolves the standard system and
  per-user `code.cmd` locations and provisions VS Code with Chocolatey only when
  neither location exists. It is never submitted to the Marketplace. The same
  validated VSIX is copied into the packaged application's resources so the
  Developer panel installs a fixed artifact rather than downloading executable
  extension code.
- CI signs when both `WINDOWS_CODE_SIGNING_CERTIFICATE` and
  `WINDOWS_CODE_SIGNING_PASSWORD` exist. Without that pair the build remains
  verifiable but Windows shows an unknown-publisher warning.
- `loadBrowserProcessSpecificV8Snapshot` stays disabled: enabling it without a
  matching packaged browser-process snapshot makes Electron fail before startup.
  This is a compatibility fuse, not a privilege boundary; the other sandbox,
  cookie, Node/inspection and ASAR-integrity fuses remain on.
- `electronDist` points at the pinned `node_modules/electron/dist`. Windows uses
  the lockfile-installed, checksum-verified distribution directly; this avoids a
  second extraction/rename pass that antivirus scanners can lock mid-build.

**Why `package.json` is not in `sources`.** 2 of the 7 commits in this repository
are pure dependency bumps touching only `package.json` and `package-lock.json`.
The pre-commit hook (`node scripts/docs-guard.mjs hook`) matches staged paths
against each doc's `sources:` globs, so claiming `package.json` here would make
the hook demand an edit to this doc on every dependency bump — noise that trains
people to ignore the hook. The trade is that a change to the `build` block will
not be flagged: update this section by hand when you make one.

## Desktop Update Client

[update-service.ts](../../electron/update-service.ts). `UpdateServiceStore` is
constructed in `electron/main.ts` against
`join(app.getPath('userData'), 'update-service.enc')`.

**Encrypted at rest.** The stored shape is `{ version: 1, endpoint, accessToken
}`, JSON-stringified, passed through `safeStorage.encryptString` (OS credential
protection), base64-encoded, written to `<file>.tmp` with mode `0600` and then
`renameSync`d over the real path — an atomic replace, so a crash mid-write cannot
leave a half-written config.

| Method | Behaviour |
| --- | --- |
| `configure(input, currentVersion)` | Throws unless `safeStorage.isEncryptionAvailable()`. Normalises the endpoint, requires `isSafeUpdateEndpoint` (public HTTPS, root path, no query or hash), requires the token to be **32-1000 characters**, saves, returns status. |
| `status(currentVersion)` | `configuration-corrupt` if the stored file could not be read, `os-encryption-unavailable` if the OS cannot encrypt, else `{configured, currentVersion, endpoint}`. **Never returns the access token.** |
| `bootstrap(input, currentVersion)` | First-run seeding from the installer. Returns `true` (nothing to do) if already configured, corrupt, or `<file>.disabled` exists; `false` if the OS cannot encrypt; otherwise delegates to `configure()`, so every validation above still applies and an invalid bundled endpoint throws. |
| `clear(currentVersion)` | Forgets the config, deletes the file, **and writes `<file>.disabled` (mode `0600`)** so the next launch does not silently re-seed from the installer. `configure()` deletes that sentinel again. |
| `check(currentVersion)` | See below. |

`normalizeEndpoint` trims, strips trailing slashes from the path, clears the
query and fragment, and drops a trailing `/`, so the stored value is a bare
origin and `${endpoint}/update.json` is always well-formed.

`load()` treats **any** failure — encryption unavailable, decrypt failure, wrong
`version`, an endpoint that no longer passes `isSafeUpdateEndpoint`, a token
under 32 characters — as corruption: it sets `corrupt = true` and returns
undefined while **leaving the file on disk**. The Settings panel then offers to
overwrite it rather than silently losing a configuration that a different machine
or a repaired OS keychain might still read.

### Bundled Bootstrap

A packaged installer can arrive already knowing where its update service is.
[update-bootstrap.ts](../../electron/update-bootstrap.ts) reads
`private-browser-update.json` from `process.resourcesPath` — placed there by
electron-builder's `extraResources` filter, written during CI by
[write-update-bootstrap.mjs](../../cloudflare/scripts/write-update-bootstrap.mjs)
from `PRIVATE_BROWSER_DOWNLOAD_URL` and `PRIVATE_BROWSER_DOWNLOAD_TOKEN`.

**Bundling is opt-in and off by default.** The script writes nothing unless
`PRIVATE_BROWSER_BUNDLE_UPDATE_TOKEN` is exactly `true`, so the default installer
carries no credential and the `extraResources` filter finds nothing to copy. When
it is set, the build prints a warning: the token is shared by every client, not
issued per device, and anyone holding the installer can extract it (F-02). Rotate
`PRIVATE_BROWSER_DOWNLOAD_TOKEN` before such an installer leaves the machine it
was built for.

Whatever the outcome — stored, invalid, or refused because `safeStorage` is
unavailable — the file is deleted in a `finally`. It used to be removed only on
success, leaving the shared token readable on exactly the machines least able to
protect it (F-15).

`readUpdateBootstrap` refuses a file over **4,096 bytes**, refuses invalid JSON,
and requires `version === 1` plus string `endpoint` and `accessToken`. It does
**not** check the endpoint is safe — `bootstrap()` hands it to `configure()`,
which applies `isSafeUpdateEndpoint` and the token-length rule, so a bad bundled
endpoint throws rather than being stored.

At startup `electron/main.ts` reads the file, calls `updates.bootstrap(...)`, and
on success calls `removeUpdateBootstrap` to delete it. The whole block is wrapped
in a `try/catch` that logs `update_bootstrap_invalid` and continues — a malformed
bundled config never stops the app launching, and the file is left in place.

**The bundled file contains the download token in plain text** until first run
deletes it. That is the trade for an installer that works without the user
pasting a token. Two consequences worth knowing: `removeUpdateBootstrap` returns
`false` if deletion fails and **main.ts ignores that return**, so a locked or
read-only resources directory leaves the plaintext token on disk silently; and
`.gitignore` excludes `build/private-browser-update.json` so it is never
committed.

### check()

1. Throws if not configured.
2. `fetch(`${endpoint}/update.json`)` with `authorization: Bearer <token>`,
   `accept: application/json`, **`redirect: 'error'`** — a redirect is a failure,
   not a hop, so the bearer token can never be replayed to another origin — and
   `signal: AbortSignal.timeout(15_000)`.
3. 404 → "The download service rejected the access token or has no release"
   (one message for both, because the Worker deliberately conflates them). Any
   other non-2xx → "The download service returned `<status>`".
4. **The 100 KB cap is checked twice.** First `content-length`, as an early exit
   before the body is read; then `Buffer.byteLength(text, 'utf8')` after reading.
   The second check is the one that actually holds — an absent or lying
   `content-length` defeats the first.
5. `JSON.parse` failure → "The download service returned invalid JSON".
6. `validateManifest(value, endpoint)`, then
   `compareVersions(manifest.version, currentVersion) > 0` decides
   `available` vs `up-to-date`. **`buildNumber` is deliberately not consulted**:
   the client cannot know its own build number, so the invariant is enforced on
   the publishing side instead — `handlePublish` refuses a release whose version
   is not higher than the active one (`release_version_not_bumped`). Every
   published release therefore has a distinct, increasing version, which is
   exactly what this comparison assumes. Weaken that guard and the service can
   publish builds no client will ever be offered.
7. Returns `{ state, currentVersion, latest, checkedAt }`.

## Manifest Validation

`validateManifest(value, endpoint)` is a strict contract validator, and it is the
**only** thing standing between a drifted or hostile service and the user. Every
check, in order:

| Check | Rule | Error |
| --- | --- | --- |
| Required strings | `version`, `channel`, `publishedAt`, `filename`, `sha256`, `commitSha`, `releaseNotes`, `downloadUrl`, `downloadPageUrl`, `expiresAt` must each be a string | `Invalid update manifest: <field>` |
| Identity | `schemaVersion === 1` and `appId === 'private-browser'` | belongs to another application |
| Version | `/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/` | Invalid update version |
| Channel | `stable` or `beta` | Invalid update channel |
| Integers | `buildNumber` and `sizeBytes` are safe integers; `sizeBytes >= 1` | Invalid update metadata |
| Checksum | `/^[a-f0-9]{64}$/` — 64 **lower-case** hex characters | Invalid update checksum |
| Filename | `/^[A-Za-z0-9][A-Za-z0-9._ -]*\.exe$/i` **and** must not contain `..` | Invalid update filename |
| Commit and notes | `commitSha` is `/^[a-f0-9]{7,64}$/i`; `releaseNotes.length <= 10_000` | Invalid release details |
| Publication date | `Date.parse(publishedAt)` is finite | Invalid publication date |
| Signed URLs | For **both** `downloadUrl` and `downloadPageUrl`: `protocol === 'https:'`, `origin === new URL(endpoint).origin`, an `expires` param, a `signature` param, and `pathname` exactly `/download/latest.exe` or `/download` respectively | Invalid signed update URL |
| Expiry | `expiresAt` parses and is **strictly in the future** | The update links are already expired |

The same-origin rule is why a compromised service cannot hand the client a
download URL on someone else's host, and the exact-path rule is why it cannot
point at an arbitrary route on the right host. Both matter because
`openUpdatePage()` opens `downloadPageUrl` in a real browser tab.

The already-expired rejection means a stale cached manifest is thrown away rather
than shown to a user who would then click a dead link.

## Version Comparison and Polling

`compareVersions(left, right)` takes the part before the first `-`, splits on
`.`, and compares position by position with missing positions treated as `0`,
returning the sign of the first difference. If the numeric parts tie, a version
carrying a prerelease suffix loses to one without it, so `0.3.0-beta` < `0.3.0`.
Two prereleases with equal numeric parts compare **equal** — the suffixes
themselves are never compared, so `0.3.0-beta.2` does not beat `0.3.0-beta.1`.

**The poll schedule lives in `electron/main.ts`**, which belongs to
[browser-shell.md](browser-shell.md) and is not one of this doc's sources:

- `setTimeout(… , 10_000).unref()` — one check ten seconds after the window is
  created.
- `setInterval(… , 24 * 60 * 60_000).unref()` — every 24 hours after that.
- Both are `.unref()`ed, so neither keeps the Node event loop alive at shutdown.

`checkForUpdatesInBackground` returns early if the service is unconfigured or the
window is destroyed, swallows every error, and sends `updates:available` to the
renderer only when the state is `available`. The explicit "Check now" button in
Settings uses `checkForUpdates` instead, so a user who asks sees the real error.
`openUpdatePage()` runs a **fresh** `check()` before opening the tab, because the
signed link inside an older result may already have expired.

## Related Systems

- [browser-shell.md](browser-shell.md) — the timers above, and the tab
  `openUpdatePage` opens.
- [renderer-ui.md](renderer-ui.md) — the Settings panel that configures, checks
  and disconnects the service.
- [ipc-contract.md](ipc-contract.md) — the `updates:*` channels.
- [security-boundary.md](security-boundary.md) — `isSafeUpdateEndpoint` and the
  `safeStorage` rules this system relies on.

## Gotchas

- **`ReleaseManifest` is declared TWICE.** Once in
  [types.ts](../../electron/types.ts) and once in
  [protocol.ts](../../cloudflare/src/protocol.ts). They are structurally
  identical today and they compile under two separate tsconfigs —
  `tsconfig.electron.json` (rootDir `electron`) and `cloudflare/tsconfig.json`
  (include `src/**`, `tests/**`) — and no file ever assigns one to the other. **No
  compiler ever compares them.** The only thing that catches a drift is
  `validateManifest` on the client, at runtime, in front of a user, where it
  surfaces as "Invalid update manifest". Change one, change the other, and add
  the case to `tests/update-service.test.ts`.
- **The two validators duplicate rules by hand.** `validateReleaseInput` on the
  Worker and `validateManifest` on the client both encode the semver regex, the
  `.exe` filename regex with its `..` check, the 64-hex checksum, the 7-64 hex
  commit sha and the 10 000-character notes cap. Two copies, no shared module,
  and they run in different runtimes.
- **`build_number` is `GITHUB_RUN_NUMBER`.** It is not derived from the version.
  Because the D1 triggers key on it, resetting or lowering the Actions run
  counter permanently locks that channel — nothing with a lower number can ever
  become active again.
- **`--keep-vars` is not optional.** Without it a `wrangler deploy` drops the
  secrets installed by the previous run's `secret bulk` step, `secretsReady`
  turns false, and the Worker starts answering 404 to everything with no error
  anywhere except a 503 on `/health`.
- **The download page is built by string concatenation.** Every D1-sourced value
  in [page.ts](../../cloudflare/src/page.ts) goes through `escapeHtml` by hand;
  there is no template engine. A new field added to that page must be escaped
  explicitly, and `cloudflare/tests/worker.test.ts` has a case for it.
- **Nothing verifies the downloaded file's checksum.** The manifest carries
  `sha256`, the page displays it, the binary response echoes it as
  `x-checksum-sha256`, and the client validates that it is 64 hex characters —
  but the app opens the download page in a tab rather than downloading and
  installing itself, so no code ever hashes the received bytes and compares. The
  integrity story currently ends at "HTTPS plus a signed link".
- **A weak secret produces silence, not an error.** Deploying with a 20-character
  `SIGNING_SECRET` succeeds; the Worker then returns 404 for every route. Check
  `/health` first when a working service goes dark.
