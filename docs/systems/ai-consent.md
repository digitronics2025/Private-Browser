---
system: ai-consent
sources:
  - electron/ai-provider.ts
verified_at: 59dc3a6
---

# AI Consent

> Last verified: 2026-09-12

## Agent Brief

**Scope.** How page text reaches a cloud model, and everything that has to happen
first. [electron/ai-provider.ts](../../electron/ai-provider.ts) is
`AiProviderStore`: the encrypted endpoint/model/key, and the single outbound
request. The consent protocol that decides whether that request is ever allowed —
`prepareAiPreview`, `approveAiPreview`, `askAi`, `pruneAiCapabilities` — lives in
`electron/main.ts`, which [browser-shell.md](browser-shell.md) owns for
source-glob purposes; it is documented here in full because it is the heart of
this subsystem and is meaningless split across two files.

**What this doc does NOT cover.** The redaction patterns and the protected-page
test themselves — those are [security-boundary.md](security-boundary.md). The
`ai:*` channel shapes are [ipc-contract.md](ipc-contract.md). The panel that
renders the preview is [renderer-ui.md](renderer-ui.md).

**Neighbours.**

- **Security predicates** → [security-boundary.md](security-boundary.md). Owns
  `isSafeAiEndpoint`, `redactSensitiveText`, `isProtectedPage`,
  `urlOriginForSharing`.
- **The browser shell** → [browser-shell.md](browser-shell.md). Owns
  `electron/main.ts`, the privacy log, and the tab whose text is read.
- **Vault** → [vault.md](vault.md). The other `safeStorage` store; same atomic
  write, same corrupt-file handling.

### Invariants

1. **Nothing leaves the device without an approval for that specific request.**
   Three separate IPC calls — prepare, approve, ask — and one approval buys one
   question. → **The Consent Protocol**
2. **Capabilities are single-use and burned on read.** Both `approveAiPreview`
   and `askAi` delete the map entry *before* validating it, so a failed or replayed
   attempt consumes the capability instead of allowing a retry.
   → **The Consent Protocol**
3. **Redaction happens before the preview exists, and nothing is re-read after
   approval.** The exact bytes the user saw are the bytes that are sent; there is
   no second extraction between approval and request.
   → **The Consent Protocol**
4. **A protected or banking page is refused three times, not once** — at
   extraction, at approval, and immediately before the request leaves. Each check
   is there because the page can change between steps.
   → **The Consent Protocol**
5. **`redirect: 'error'` is a security control, not a style choice.**
   `isSafeAiEndpoint` validates a URL; a 302 would move the request to somewhere
   that URL never named, after the private-range check has already passed.
   → **The Outbound Request**
6. **The API key never crosses to the renderer.** `status()` returns
   `configured`, `endpoint` and `model` — nothing else, on any path.
   → **Provider Configuration**

### Where to look

<!-- routing:start -->

| You are changing… | Section |
| --- | --- |
| the prepare / approve / ask steps, tokens, or expiry | [The Consent Protocol](#the-consent-protocol) |
| the stored endpoint, model or key, and what status reveals | [Provider Configuration](#provider-configuration) |
| the request shape, headers, timeout or redirect policy | [The Outbound Request](#the-outbound-request) |
| limits that are not where you would expect them | [Gotchas](#gotchas) |

<!-- routing:end -->

### Before you write

- Do not add a step that re-reads the page after approval. Approval is over a
  snapshot; re-reading breaks invariant 3 silently.
- Do not make a capability reusable "for convenience". The delete-before-validate
  order is deliberate.
- Any new outbound `fetch` in this subsystem needs `redirect: 'error'`, an
  `AbortSignal.timeout`, and a size bound on what it parses.
- Never log, return or persist the API key. Grep for `apiKey` before finishing.
- If you add a provider field, decide explicitly whether `status()` exposes it —
  the default answer is no.

## Overview

The app ships with no AI vendor configured. A user who wants one supplies an
OpenAI-compatible base URL, a model name and an API key; all three are encrypted
at rest. Even then, no page text is transmitted automatically. Reading the page
is local, redaction is local, and the user approves one sanitised snapshot for
one question at a time. The design goal is that a person can answer "what did
this app send, and when did I agree to it?" from the privacy log alone.

## The Consent Protocol

Implemented in `electron/main.ts` (owned by
[browser-shell.md](browser-shell.md)). Three IPC calls in order —
`ai:prepare-preview`, `ai:approve-preview`, `ai:ask` — with two short-lived
in-memory maps between them, `pendingAiPreviews` and `aiApprovals`
(`main.ts:63-64`).

### 1. Local extraction — `prepareAiPreview()` (`main.ts:289-307`)

1. `pruneAiCapabilities()` runs first, so expired entries are cleared before
   anything new is created.
2. **The banking refusal.** If the active tab's workspace is `protected` — the
   Banking workspace is the one marked so in
   [workspaces-and-state.md](workspaces-and-state.md) — or `isProtectedPage(tab.url)`
   is true, it writes a `blocked` privacy event and throws
   `AI access is disabled for protected and banking pages`. Nothing is read.
3. A tab must be open and not the home page, otherwise `Open a webpage first`.
4. **Extraction is local and shallow.** It evaluates
   `document.body ? document.body.innerText.slice(0, 20000) : ''` in the page.
   `innerText` is rendered text only: no input values, no `value` attributes, no
   cookies, no storage, no headers, no markup.
5. **Redaction runs immediately**, on the extracted text and separately on the tab
   title, via `redactSensitiveText`. A `local-read` privacy event records the
   title and the redaction count *before* any approval exists — the log shows the
   read even if the user never approves.
6. The preview is assembled: a fresh `randomUUID` id, the redacted title, the
   URL reduced to its **origin** by `urlOriginForSharing`, the redacted text cut
   to the first **12,000 characters**, the summed redaction count from body and
   title, and `protectedPage: false`.
7. It is stored as `{ preview, sourceUrl: tab.url, expiresAt: now + 5 minutes }`
   and returned to the renderer, which shows the text alongside "*N* redacted"
   ([src/App.tsx:430](../../src/App.tsx)).

### 2. Approval — `approveAiPreview(previewId)` (`main.ts:309-321`)

1. The pending entry is fetched and **deleted immediately**, before any check. A
   preview id is good for exactly one approval attempt; a failed attempt does not
   leave it usable.
2. Missing or past `expiresAt` → `The page preview expired; read the page again`.
3. The active tab is re-read: if `tab.url !== pending.sourceUrl`, or the page is
   now protected, it throws `The page changed or is protected`. This is what stops
   a navigation between preview and approval from silently re-pointing the
   approval at a different page.
4. A **capability token** — a fresh `randomUUID` — is minted and stored as
   `{ preview, sourceUrl, expiresAt: now + 5 minutes }`.
5. A `cloud-approved` privacy event records the title and redaction count.
6. `{ token, preview }` goes back to the renderer, which switches the panel to
   "Approved for one request".

Note what is *not* here: no re-extraction. The approved preview object is the one
built in step 1, and it is what will be sent verbatim.

### 3. The single request — `askAi(token, question)` (`main.ts:339-351`)

1. The approval is fetched and **deleted immediately**, again before validation.
   The token is single-use whatever happens next.
2. Missing or expired → `AI approval expired; approve the page again`.
3. The question is trimmed and must be non-empty and ≤2,000 characters (the
   renderer's textarea carries the same `maxLength`).
4. The active tab is checked against `sourceUrl` and `isProtectedPage` **again** —
   the third protection check, covering the window between approval and send.
5. `aiProvider.ask(approval.preview, question)` performs the one outbound call.
6. A second `cloud-approved` event records that the request completed.

Asking again requires approving again, which requires reading the page again.

### Expiry and pruning — `pruneAiCapabilities()` (`main.ts:638-644`)

Deletes entries past `expiresAt` from both maps, then evicts oldest-first while
either map exceeds **20** entries (`Map` preserves insertion order). It is called
from `prepareAiPreview` only — expiry itself is enforced at the point of use by
the checks above, so pruning is about bounding memory, not about correctness.
Both maps are in-process only: quitting the app revokes every outstanding
capability.

## Provider Configuration

`AiProviderStore` ([electron/ai-provider.ts](../../electron/ai-provider.ts)),
constructed once at startup over `userData/ai-provider.enc`
(`electron/main.ts:705`). The stored shape is
`{ version: 1, endpoint, model, apiKey }`.

**At rest.** `save()` mirrors the vault exactly: `safeStorage.encryptString` of
the JSON, written base64 to `${filePath}.tmp` with `{ mode: 0o600 }`, then
`renameSync` over the real file — atomic, so an interrupted write cannot leave a
half-written config. `load()` reverses it and then **re-validates**: it requires
`version === 1`, a non-empty `model`, and `isSafeAiEndpoint(parsed.endpoint)`
to still pass. Tightening that predicate later therefore invalidates a
previously-stored endpoint at the next launch rather than grandfathering it.

**`configure(input)`** ([ai-provider.ts:27](../../electron/ai-provider.ts)):

- Throws `OS encryption is unavailable` when `safeStorage` cannot encrypt — there
  is no plaintext fallback.
- Throws when `corrupt` is set: *The AI provider file is corrupt; clear it before
  configuring again.*
- The endpoint is trimmed and has **one** trailing slash stripped
  (`replace(/\/$/, '')`), so `ask` can append `/chat/completions` cleanly.
- `isSafeAiEndpoint(endpoint)` must pass, otherwise *Use a public HTTPS AI
  endpoint without embedded credentials*. This is the SSRF guard described in
  [security-boundary.md](security-boundary.md).
- `model` must be non-empty and ≤200 characters; `apiKey` must be ≤1,000
  characters. An **empty** API key is accepted — the request then carries no
  `authorization` header, which is what makes a local-network-free, keyless
  gateway usable.
- Saves and returns `status()`.

**`status()`** ([ai-provider.ts:19](../../electron/ai-provider.ts)) is the only
thing the renderer ever sees: `{ configured: false, error: 'provider-corrupt' }`
when the file failed to decrypt, `{ configured: false, error:
'os-encryption-unavailable' }` when `safeStorage` is unavailable, otherwise
`{ configured: true, endpoint, model }` or `{ configured: false }`. **The API key
is never returned, on any path.**

**`clear()`** drops the in-memory config, resets `corrupt`, and unlinks the file.
It is the only way out of the corrupt state.

The controller wrappers (`main.ts:323-337`) add a privacy-log entry for configure
and for clear; the configure entry records the endpoint, never the key.

## The Outbound Request

`ask(context, question)` ([ai-provider.ts:46](../../electron/ai-provider.ts)) —
one `fetch`, no retries, no streaming.

- `POST {endpoint}/chat/completions` — an OpenAI-compatible chat completion.
- Headers: `content-type: application/json`, plus
  `authorization: Bearer {apiKey}` only when a key is stored.
- Body: `{ model, temperature: 0.2, messages: [system, user] }`. The low
  temperature is deliberate — this is extraction from a supplied context, not
  creative writing.
- The system prompt, verbatim: *"Answer only from the user-approved webpage
  context. Clearly say when the context is insufficient. Never request or expose
  credentials."*
- The text prompt is assembled as `Page: {title}` / `URL: {url}` / `Approved
  context:` + text / optional `Approved structural DOM` / `Question:
  {question}`. The Developer Bridge may add structural DOM metadata or a
  compressed screenshot only when the user selected that option before viewing
  and approving the exact preview. DOM contains bounded element structure, not
  text or values; form controls are masked during screenshot capture. Without an
  approved screenshot, `content` remains the original plain string. With one,
  it becomes the provider's text-plus-`image_url` content array.
- **`redirect: 'error'`.** `isSafeAiEndpoint` validated a URL, and a redirect
  would move the request off that URL after the check. Without this flag a
  permissive or compromised host could 302 the request — carrying the API key and
  the approved page text — to a private address the guard exists to forbid.
  Treat it as load-bearing.
- `signal: AbortSignal.timeout(60_000)` — a 60-second ceiling, so a hung provider
  cannot pin the request open indefinitely.
- A non-2xx response throws `AI provider returned {status}`.
- The answer is `data.choices[0].message.content` trimmed; empty or missing throws
  `AI provider returned an empty response`. The returned string is capped at
  **30,000 characters** before it crosses back to the renderer.

## Related Systems

- [security-boundary.md](security-boundary.md) — `isSafeAiEndpoint`,
  `redactSensitiveText`, `isProtectedPage`, `urlOriginForSharing`.
- [SECURITY.md](../../SECURITY.md) — the AI data-control claims this subsystem
  implements.
- [vault.md](vault.md) — the same `safeStorage` at-rest pattern.
- [browser-shell.md](browser-shell.md) — the privacy log every step writes to.

## Gotchas

- **The redaction count can exceed what the preview shows.** Extraction caps the
  raw text at 20,000 characters, redaction runs over all of it, and only the first
  12,000 characters survive into the preview. Matches found in the discarded tail
  are counted but neither displayed nor sent.
- **The approval is checked against the *active* tab, not the tab it came from.**
  Switching tabs between approving and asking fails the `sourceUrl` comparison. It
  fails closed, which is right, but the error says the page changed.
- **The provider response is parsed without a size bound.** `response.json()` is
  called on whatever arrives; the 30,000-character cap is applied to the answer
  *after* parsing. Contrast `update-service.ts`, which refuses a body over
  100,000 bytes before parsing it.
- **Only one trailing slash is stripped from the endpoint.** A pasted
  `https://api.example.com//` becomes `https://api.example.com/` and the request
  path ends up as `//chat/completions`.
- **`corrupt` also means "no longer allowed".** `load()` marks the file corrupt
  when the stored endpoint fails `isSafeAiEndpoint`, so tightening that predicate
  surfaces to the user as a corrupt provider file rather than a rejected endpoint.
  `clear()` then reconfigure is the fix either way.
- **The `apiKey` length check runs on the untrimmed input** while the trimmed
  value is what gets stored — a key padded past 1,000 characters with whitespace
  is rejected rather than trimmed and accepted.
- **Capabilities are pruned only when a new preview is prepared.** An unused
  approval sits in memory until then, bounded by the 20-entry cap and by process
  lifetime. It is still unusable once expired.
