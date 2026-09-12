---
system: security-boundary
sources:
  - electron/security.ts
verified_at: 4df46c49
---

# Security Boundary

> Last verified: 2026-09-12

## Agent Brief

**Scope.** [electron/security.ts](../../electron/security.ts) is a dependency-free
set of URL, permission and download policy helpers. Every URL crossing from an untrusted source — typed
text, a popup, the state file on disk, a saved provider config — into a
navigation, a stored record or an outbound `fetch` passes one of them. They hold
no state and import nothing, which is why they are cheap to call twice.

**What this doc does NOT cover.** Runtime enforcement built on these predicates —
session partitions, permission handlers, sandboxing, the IPC surface — is
[browser-shell.md](browser-shell.md) and [ipc-contract.md](ipc-contract.md).
[SECURITY.md](../../SECURITY.md) is the trust-boundary narrative: it explains the
model, this doc explains the code. Do not restate either here.

**Neighbours.**

- **The browser shell** → [browser-shell.md](browser-shell.md). Owns
  `electron/main.ts`; calls five of these and enforces the rest.
- **Persisted state** → [workspaces-and-state.md](workspaces-and-state.md). Owns
  `electron/state-store.ts`, which re-filters everything read back from disk.
- **AI consent** → [ai-consent.md](ai-consent.md). Owns the protocol that
  redaction, page protection and origin-stripping serve.
### Invariants

1. **A URL is validated at every boundary it crosses, not once at the door.**
   `isAllowedRemoteUrl` runs on typed input, popups, `will-navigate`, commit,
   launch arguments, and every record read back from disk. Deleting a
   "redundant" call re-opens the boundary it was guarding. → **Consumers**
2. **Only `http:` and `https:` ever reach a view or a stored record.** Everything
   else — `file:`, `javascript:`, `data:` — fails closed.
   → **isAllowedRemoteUrl**
3. **A URL carrying embedded credentials is refused, not sanitised.**
   `normalizeNavigationInput` throws and `isAllowedRemoteUrl` returns false.
   → **normalizeNavigationInput**
4. **Redaction runs before anything leaves the device, and its count is shown to
   the user.** The number is the only signal the user gets that the preview
   differs from the page; dropping it silently weakens consent.
   → **redactSensitiveText**
5. **Outbound endpoints are re-validated on load, never trusted because they
   passed once.** `ai-provider.ts` and `update-service.ts` both re-run the
   predicate against the decrypted file, so tightening a rule retroactively
   invalidates a stored endpoint. → **isSafeAiEndpoint**
6. **The SSRF guard checks a URL, so redirects must be refused.** Both callers
   pass `redirect: 'error'`; without it a 302 relocates the request after the
   check has already passed. → **isSafeAiEndpoint**

### Where to look

<!-- routing:start -->

| You are changing… | Section |
| --- | --- |
| what the address bar does with typed text | [normalizeNavigationInput](#normalizenavigationinput) |
| campaign identifiers or address warnings | [Tracking and runtime policy](#tracking-and-runtime-policy) |
| site permission or download risk policy | [Tracking and runtime policy](#tracking-and-runtime-policy) |
| which schemes may load, or be written to disk | [isAllowedRemoteUrl](#isallowedremoteurl) |
| a secret pattern, or the redaction count shown to the user | [redactSensitiveText](#redactsensitivetext) |
| adding a bank, or why a page refuses AI access | [isProtectedPage](#isprotectedpage) |
| how much of a URL a cloud provider is given | [urlOriginForSharing](#urloriginforsharing) |
| the private-range blocklist behind every outbound call | [isSafeAiEndpoint](#issafeaiendpoint) |
| the bare-origin rule for the download service | [isSafeUpdateEndpoint](#issafeupdateendpoint) |
| who calls a predicate, before changing its signature | [Consumers](#consumers) |
| a pattern that looks covered but is not | [Gotchas](#gotchas) |

<!-- routing:end -->

### Before you write

- Grep `from './security.js'` first: four importers plus the test file, and a
  signature change hits all of them.
- Add a case to [tests/security.test.ts](../../tests/security.test.ts) in the
  same change. All seven predicates are covered there today.
- Never make a predicate "helpful". Apart from scheme-prefixing in
  `normalizeNavigationInput`, these functions only allow or deny.
- Keep them pure — no `fs`, no `electron`, no network. Being runnable in plain
  vitest is what keeps them tested.
- Widening a deny-list is a security change. Say what it now lets through.

## Overview

The app treats every loaded website as hostile, so untrusted strings arrive from
several directions at once: the address bar, a page calling `window.open`, a
`will-navigate` from inside a sandboxed view, command-line arguments when the app
is the default browser, and the JSON state file on disk. Rather than scattering
scheme checks across those paths, all of them call the same small set of
predicates. Three more serve the AI path — deciding what may be read, what must
be scrubbed, and where a request may be sent.

## Tracking and runtime policy

`stripTrackingParameters` removes `utm_*` and common advertising click ids while
retaining functional parameters and fragments. It runs for typed URLs, popups,
navigations, redirects and stored URLs. `navigationWarning` marks public
cleartext HTTP and punycode (`xn--`) hosts; localhost and loopback HTTP remain
usable. `isAllowedSitePermission` permits only top-frame fullscreen and sanitized
clipboard writes from trustworthy origins, and denies every permission in
Banking. `downloadRisk` detects executable/script extensions and deceptive names
such as `invoice.pdf.exe` so the shell can refuse to open them.

## normalizeNavigationInput

`normalizeNavigationInput(value: string): string` — turns whatever the user typed
into exactly one of: the home sentinel, an `http(s)` URL, or a search URL.
([security.ts:3](../../electron/security.ts))

Order of decisions:

1. Trim. Empty input returns `private://home`.
2. The literal `private://home` is returned unchanged — the **sentinel** for the
   local new-tab page. It is never loaded as a URL: `main.ts` hides the tab's
   `WebContentsView` instead, and `sanitizeState` allow-lists it alongside real
   URLs. Remove the passthrough and the home tab becomes a web search.
3. If `new URL(input)` parses **and** the protocol is `http:` or `https:`: reject
   when `username` or `password` is set — it throws
   `URLs containing credentials are not allowed` — otherwise return
   `parsed.toString()`. A string that parses under any other scheme (`file:`,
   `javascript:`, `data:`) is *not* returned here; it falls through to steps 4-6
   and, having no bare-domain shape, ends up as a search.
4. `/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/.*)?$/i` → prefix `http://`.
   This is the **only** branch that produces cleartext http, and it exists for
   local dev servers. Broaden it to arbitrary hostnames and ordinary browsing
   silently downgrades to http.
5. `/^[\w.-]+\.[a-z]{2,}(?::\d+)?(?:\/.*)?$/i` → prefix `https://` and normalise
   through `new URL`. A bare domain, optional port, optional path.
6. Anything else → `https://duckduckgo.com/?q=` + `encodeURIComponent(input)`.

**What breaks if weakened.** Losing the credential check (3) puts
`user:pass@host` into history, bookmarks and the wire. Losing the search fallback
(6) turns every typo into a navigation to whatever domain someone registered for
it, and makes ordinary typed text throw instead of searching. Loosening the
bare-domain regex (5) lets scheme-like strings be prefixed with `https://` and
produce a navigation nobody asked for.

## isAllowedRemoteUrl

`isAllowedRemoteUrl(value: string): boolean` — true only for a parseable URL whose
protocol is `https:` or `http:` and which carries no `username` and no
`password`. Unparseable input returns false.
([security.ts:30](../../electron/security.ts))

This is the workhorse: the last gate before a URL is loaded into a view, turned
into a tab, or written into the state file. It is deliberately narrower than
"looks like a URL" — `file:///etc/passwd` and `javascript:alert(1)` are the two
cases the test file pins.

## redactSensitiveText

`redactSensitiveText(value: string): { text: string; redactions: number }` —
applies six patterns in order, replacing every match with `[REDACTED]` and
incrementing a counter once per match.
([security.ts:39](../../electron/security.ts))

| # | Pattern | Catches |
| --- | --- | --- |
| 1 | `\b(?:authorization\s*[:=]\s*)?bearer\s+[^\s,;]+` | Bearer tokens, with or without the `Authorization:` prefix |
| 2 | `\b(?:\d[ -]*?){13,19}\b` | 13-19 digit payment card numbers, tolerating spaces and hyphens |
| 3 | `\bauthorization\s*[:=]\s*[^\s,;]+` | Any remaining authorization header or assignment (Basic, opaque) |
| 4 | `\b(?:password\|passwd\|pwd\|secret\|api[_ -]?key\|token)\s*[:=]\s*[^\s,;]+` | Credential assignments |
| 5 | `\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b` | JWTs — three base64url segments beginning `eyJ` |
| 6 | `\b[A-Z2-7]{24,}\b` | Base32 authenticator (TOTP) secrets |

Order matters: pattern 1 runs before pattern 3 so `Authorization: Bearer abc` is
consumed as one match instead of leaving `Bearer abc` behind.

**The count is not decoration.** `redactions` is returned, summed across the page
body and the page title in `prepareAiPreview`, carried on `AiPagePreview`, written
into the privacy log, and rendered to the user beside the preview as
"*N* redacted" ([src/App.tsx:430](../../src/App.tsx)). It is the user's only
evidence that the text they are approving is not the text on screen. A change
that redacts correctly but stops counting has removed a consent signal.

## isProtectedPage

`isProtectedPage(urlValue: string): boolean` — true if **either** test matches;
false when the URL does not parse.
([security.ts:60](../../electron/security.ts))

Three tests, in order, against a lowercased hostname:

- **`PROTECTED_HOST_FRAGMENTS` — substring anywhere in the hostname.** Terms
  distinctive enough that a substring match will not catch ordinary words:
  `bank`, `banque`, `bancaire`, `bankofafrica`, `creditagricole`, `creditdumaroc`,
  `attijari`, `wafacash`, `wafasalaf`, `cihbank`, `bmce`, `bmci`, `sgmaroc`,
  `chaabi`, `baridbank`, `cashplus`, `paypal`, `revolut`, `mastercard`, `visa-`.
- **`PROTECTED_HOST_LABELS` — whole dot- or hyphen-separated label only.** Terms
  too short or common for a substring match: `credit`, `caisse`, `wise`,
  `stripe`, `cih`, `cdm`, `barid`, `pay`, `payments`, `billing`. Bounding these
  is what keeps `otherwise.org` and `credits.example.com` usable.
- **`PROTECTED_PATH_FRAGMENTS` — against host and path concatenated.**
  `banking|checkout|payment|paiement|wallet|billing|invoice|virement|transfer|carte-bancaire`,
  so `shop.example/checkout` is protected by its path alone.

The earlier version required a literal `bank.`/`paypal.`/`wise.`/`revolut.`
*label*, which meant `cfgbank.com`, `sgmaroc.com` and `creditagricole.ma` were
**not** protected — audit finding F-08. Both directions are now pinned by tests.

**This list can never be complete, and is not the guarantee.** No keyword set
covers every bank in the world. It errs towards refusing, because a false
positive costs one refused AI read while a false negative offers a banking page's
text for upload. The guarantee the product actually rests on is the Banking
workspace, which is protected by configuration rather than guesswork.

**What breaks if weakened.** This is the refusal that keeps banking pages out of
the AI path, and it is checked three separate times — before extraction, again at
approval, and again immediately before the request leaves. Shortening the list
makes a bank page extractable.

## isAutofillTarget

`isAutofillTarget(credentialUrl: string, pageUrl: string): boolean` — whether a
saved credential may be filled into the page currently open.
([security.ts:112](../../electron/security.ts))

Both URLs must be ordinary web pages (`isAllowedRemoteUrl`), and `hostname` and
`port` must match exactly — no subdomain matching, no suffix matching. The scheme
is checked **asymmetrically**:

| Credential saved for | Page open | Fills? |
| --- | --- | --- |
| `https` | `https` | yes |
| `https` | `http` | **no** — never a downgrade |
| `http` | `https` | yes — the page is safer than the credential |
| `http` | `http` | yes |

The downgrade rule is the point. `isAllowedRemoteUrl` permits `http:`, so before
this existed a password saved for a real site would fill into a plaintext page of
the same name on a hostile network — audit finding F-05. Refusing the upgrade
case instead would break anyone who saved a bare hostname, which normalises to
`https` only for public-looking names.

## urlOriginForSharing

`urlOriginForSharing(value: string): string` — `new URL(value).origin`, or `''`
when the URL does not parse. ([security.ts:70](../../electron/security.ts))

`prepareAiPreview` sets `preview.url` from this, so the only location a cloud
provider ever receives is `https://host`. Paths, query strings and fragments
routinely carry password-reset tokens, order ids and session ids; the test pins
`https://example.com/reset?token=secret#step` → `https://example.com`. Passing the
whole URL would leak a secret redaction never sees, because redaction runs on
page text, not on the URL.

## isSafeAiEndpoint

`isSafeAiEndpoint(value: string): boolean` — the SSRF guard.
([security.ts:78](../../electron/security.ts))

1. Must parse. Protocol must be exactly `https:` — no http, ever. No `username`,
   no `password`.
2. `hostname` is lowercased and the surrounding `[` `]` of an IPv6 literal are
   stripped.
3. A single trailing dot is stripped first (`localhost.` is the fully-qualified
   spelling of `localhost`), and every check below runs against that bare form.
4. Rejected by name: exactly `localhost`, `0.0.0.0`, `::1`, `::` (the all-zeros
   address, which routes to loopback on most stacks), any host ending `.local`,
   and anything starting `::ffff:` (the IPv4-mapped form — Node renders
   `::ffff:127.0.0.1` as `::ffff:7f00:1`, so matching the prefix is the only
   reliable test). The last three were all reachable before audit finding F-19.

   Decimal and hexadecimal IPv4 spellings (`https://2130706433/`,
   `https://0x7f000001/`) need no rule: the WHATWG URL parser normalises both to
   `127.0.0.1` before this function sees them. Verified, not assumed.
5. Rejected by IPv4 prefix: `127.` (loopback), `10.` (private class A),
   `192.168.` (private class C), `169.254.` (link-local — this is the cloud
   metadata range, `169.254.169.254`).
6. Rejected by IPv6 prefix: `/^(fc|fd|fe8|fe9|fea|feb)[0-9a-f]*:/i` — unique-local
   `fc00::/7` and link-local `fe80::/10`.
6. `172.16.0.0/12` is arithmetic, not a prefix string: the second octet is
   captured and range-checked `>= 16 && <= 31`, so `172.15.x` and `172.32.x`
   stay allowed as the public addresses they are.

The WHATWG `URL` parser normalises integer, octal and short-form IPv4 before this
code sees it — `https://2130706433/`, `https://0177.0.0.1/` and `https://127.1/`
all arrive as `127.0.0.1` and are blocked.

**What breaks if weakened.** This predicate is the whole of the outbound
allow-list. It runs when a provider is configured *and* again when the encrypted
file is loaded. Weaken it and a "cloud AI endpoint" can be the loopback
interface, the office LAN, or the cloud metadata service — with the app's own
credentials attached.

## isSafeUpdateEndpoint

`isSafeUpdateEndpoint(value: string): boolean` — `isSafeAiEndpoint` first, then
requires `pathname` to be `''` or `/`, with no `search` and no `hash`.
([security.ts:94](../../electron/security.ts))

Bare origin only. The update service appends `/update.json` and the download
paths itself, and `validateManifest` later requires the manifest's signed URLs to
sit on that same origin with those exact paths. Allowing a path or a query here
would let a manifest be served from an attacker-chosen location on an otherwise
trusted host, and would undermine that origin comparison.

## Consumers

Four modules import from this file. Trace them before changing a signature.

- **[electron/main.ts](../../electron/main.ts)** (owned by
  [browser-shell.md](browser-shell.md)) imports `isAllowedRemoteUrl`,
  `isProtectedPage`, `normalizeNavigationInput`, `redactSensitiveText` and
  `urlOriginForSharing`. Calls: `navigate()` normalises then re-checks
  (`main.ts:165`, `:178`); `prepareAiPreview` refuses protected pages, redacts and
  origin-strips (`:294`, `:301-304`); `approveAiPreview` re-checks protection
  (`:316`); `askAi` re-checks again (`:347`); `addVaultItem` normalises the saved
  site URL (`:360-361`); the window-open handler and `will-navigate` filter
  (`:501`, `:505`); tab restore (`:568`); `commitNavigation` (`:607`); and
  command-line launch arguments (`:671`, `:678`, `:684`).
- **[electron/state-store.ts](../../electron/state-store.ts)** (owned by
  [workspaces-and-state.md](workspaces-and-state.md)) imports
  `isAllowedRemoteUrl` and applies it in `sanitizeState` to every restored tab
  (alongside the `private://home` sentinel), bookmark and history entry. The
  state file is on disk and is therefore untrusted input.
- **[electron/ai-provider.ts](../../electron/ai-provider.ts)** (owned by
  [ai-consent.md](ai-consent.md)) imports `isSafeAiEndpoint` and calls it in
  `configure()` and again in `load()`.
- **[electron/update-service.ts](../../electron/update-service.ts)** (owned by
  [release-and-updates.md](release-and-updates.md)) imports
  `isSafeUpdateEndpoint` and calls it in `configure()` and again in `load()`.

[tests/security.test.ts](../../tests/security.test.ts) exercises all seven.

## Related Systems

- [SECURITY.md](../../SECURITY.md) — the trust-boundary model these predicates
  implement. Read it for *why*; read this for *what the code does*.
- [ai-consent.md](ai-consent.md) — redaction, page protection and
  origin-stripping inside the consent protocol.
- [vault.md](vault.md) — `normalizeNavigationInput` also normalises the URL saved
  on a vault entry, which is what makes same-hostname autofill matching possible.

## Gotchas

- **A digit run longer than 19 escapes the card pattern entirely.** Pattern 2 is
  word-boundary anchored and capped at 19 repetitions, so `4242424242424242`
  redacts but `12345678901234567890` passes through untouched.
- **The base32 pattern is uppercase-only and boundary-anchored.** A lowercase
  TOTP secret is not redacted, and neither is one glued to a word character —
  `prefix_ABCDEFGHIJKLMNOPQRSTUVWX` survives because `_` is a word character.
- **Pattern 4 needs a `:` or `=`.** `password: hunter2` redacts;
  `password hunter2` does not.
- **`isProtectedPage` ignores the query string and fragment.** Only `hostname`
  and `pathname` are tested.
- **`isSafeAiEndpoint` blocks literal private addresses, not private
  destinations.** A public hostname whose DNS resolves to a private address, an
  IPv4-mapped IPv6 literal (`https://[::ffff:127.0.0.1]/` normalises to
  `[::ffff:7f00:1]` and passes), the CGNAT range `100.64.0.0/10`, and single-label
  or `.internal` intranet names are all accepted. `redirect: 'error'` on both
  callers narrows the window but does not close this gap.
- **`normalizeNavigationInput` throws where the others return false.** The
  credential case is an exception, not a boolean; callers must let it propagate
  or handle it. `navigate()` lets it reach the IPC caller as a rejected promise.
