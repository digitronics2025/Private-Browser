# Known follow-ups

Work that was **deliberately not done**, with the reason. Every entry was flagged
during a real change and would otherwise be buried in a dated note nobody finds
again. This is the index.

**Read this before starting work in an area.** If your task touches something
listed here, the note usually explains why the obvious fix is harder than it
looks — or tells you the groundwork is already done.

Each entry carries the date it was recorded and the symbol it concerns. The date
is when it was true, not a promise it still is. `/docs-systems audit` re-checks
every named symbol: if the symbol no longer exists, the entry is flagged
"may be closed — verify". Verify before acting; the code may have moved on.

Grouped by AREA, not by date. A chronological list of debt is a list nobody
reads. Engineering debt is separated from decisions that are the owner's call,
because they need different people.

For the full story behind an entry:

```sh
node scripts/docs-find.mjs --history "<term from the entry>"
```

---

## Local data at rest

- **Chrome import deliberately excludes cookies, live sessions, payment cards,
  extensions, account tokens, search engines and full autofill profiles.** The
  current app has no compatible storage/runtime for most of these, and copying
  authentication state would undermine per-workspace session isolation. Empty
  Chrome bookmark folders are also not persisted because bookmarks are stored as
  URL records with folder paths rather than folder nodes. Symbol:
  `readChromeProfile`. *(2026-09-12)*

- **`browser-state.json` (history, bookmarks, tab URLs, privacy log) is written
  as plaintext JSON, not encrypted.** Recorded 2026-09-10 against
  `StateStore.save` — audit finding F-20. The vault and the two credential
  stores use `safeStorage`; this file deliberately does not, because the app must
  still start when the OS keychain is unavailable, and a vault that refuses to
  open is an inconvenience while a browser that refuses to start is a broken
  product. `{ mode: 0o600 }` is applied on the temp file, but on Windows — the
  only supported platform — the POSIX mode is largely advisory, so it is not the
  protection it looks like.
  The obvious fix (encrypt-if-available, plaintext fallback) is not obviously
  right: it would silently lose every bookmark and all history the first time the
  keychain changed identity, which is a worse failure than the one it prevents.
  Doing it properly needs the same corrupt-detection and preserve-the-file
  recovery that `VaultStore` has. Until then the limitation is stated in
  [SECURITY.md](../SECURITY.md) so nobody has to read the code to find it out.

## Main-process structure

- **The three IPC facades were left inside `electron/main.ts` rather than
  extracted.** Roughly a third of that 762-line file is thin delegation to
  `VaultStore`, `AiProviderStore` and `UpdateServiceStore` — the AI approval
  protocol, the vault clipboard/autofill methods and the update polling. Moving
  them to `electron/ipc/ai.ts`, `electron/ipc/vault.ts` and
  `electron/ipc/updates.ts` would let each subsystem doc claim its own file in
  `sources:`, which is the one thing the current split cannot do: today a
  facade-only edit warns about `browser-shell.md` when the right doc was
  `ai-consent.md`, `vault.md` or `release-and-updates.md`. Deferred because it is
  a pure move with real regression risk and no user-visible gain. When it lands,
  the doc fix is a three-line frontmatter edit, not a reorganisation. Symbol:
  `prepareAiPreview`. *(2026-09-10)*

- **`browser-shell.md` cannot be split while `main.ts` is one file.** The
  `docs-systems split` procedure requires each child doc to inherit *narrowed*
  `sources`, and there is nothing to narrow to. Its byte budget is therefore held
  by prose discipline alone. If that doc passes ~30 KB, the fix is the facade
  extraction above, not splitting the doc. Symbol: `BrowserController`.
  *(2026-09-10)*

## Cross-boundary contracts

- **`ReleaseManifest` is declared twice and nothing compares the two.** Once in
  `electron/types.ts` and once in `cloudflare/src/protocol.ts`, under two
  separate tsconfigs. A Worker-side change to the manifest shape produces no
  compile error anywhere; the only thing that catches it is `validateManifest`
  on the desktop client, at runtime, in front of a user whose update then fails.
  A shared types package or a generated type would fix it; both are heavier than
  this repo currently needs. Symbol: `validateManifest`. *(2026-09-10)*

## Input handling

- **In-page shortcuts almost certainly fire twice per keypress.**
  `handleShortcut` is wired to `before-input-event` (main.ts:520), which Electron
  emits before *both* the keydown and the keyup dispatch, and the handler never
  inspects `input.type`. One Ctrl+T therefore runs `newTab()` twice, one Ctrl+W
  closes two tabs. This is a code-read finding plus Electron's documented event
  contract — it has not been reproduced in a running app, so confirm before
  fixing. The fix is one guard: return early unless `input.type === 'keyDown'`.
  Left undone here because this task was documentation, not behaviour changes.
  Symbol: `handleShortcut`. *(2026-09-10)*

- **Keyboard shortcuts are implemented twice, and the two copies differ.**
  `handleShortcut` in `electron/main.ts` handles `before-input-event` (focus
  inside a page view) and includes Alt+Left/Right; the `window keydown` handler
  in `src/App.tsx` handles focus in the chrome and has no Alt handling.
  Ctrl+L/T/W/R exist in both. Adding a shortcut means editing both, and there is
  nothing that fails when you edit only one. Symbol: `handleShortcut`.
  *(2026-09-10)*

## Layout

- **Three sets of chrome-inset numbers live in two files.** `src/App.tsx` sends
  measured insets to the main process, `electron/main.ts` carries its own
  defaults for the pre-handshake frame, and `setLayout` clamps the top inset.
  They do not agree. The visible effect is a brief misplacement of the page view
  before the first handshake. Fixing it means deriving one set from the other,
  which is more invasive than the symptom warrants today. Symbol: `setLayout`.
  *(2026-09-10)*

## Security predicates

- **The private-address blocklist misses IPv4-mapped IPv6 addresses.**
  `isSafeAiEndpoint` blocks `https://127.0.0.1/`, and also the obfuscated forms
  (`2130706433`, `0177.0.0.1`, `127.1`) because WHATWG URL normalises those back
  to dotted-quad first. It does **not** block `https://[::ffff:127.0.0.1]/` or
  `https://[::ffff:10.0.0.1]/` — those normalise to `::ffff:7f00:1` style hosts,
  which match none of the string tests. Verified by running the compiled
  predicate, not by reading it. Impact is bounded: the operator has to configure
  the endpoint themselves, and it is their own machine — but it is a documented
  defence with a hole, and `isSafeUpdateEndpoint` inherits it. The fix is to
  decode an IPv4-mapped host to its dotted-quad form before the range tests.
  Symbol: `isSafeAiEndpoint`. *(2026-09-10)*

- **The card-number redaction pattern skips runs of 20 or more digits.**
  The pattern is bounded to a run of 13-19 digits, so a 16-digit number is
  redacted and a 20-digit run passes through untouched into an AI preview.
  Verified by running `redactSensitiveText`. Widening the range risks redacting
  ordinary long numbers, so this is a deliberate trade rather than an oversight —
  recorded so the next person does not rediscover it during an incident.
  Symbol: `redactSensitiveText`. *(2026-09-10)*

## Credential vault

- **Malformed authenticator secrets are accepted silently.** `add()` validates a
  TOTP secret by calling `generateTotp` and letting it throw — but it cannot
  throw. `decodeBase32` strips every character outside the base32 alphabet before
  the `if (index < 0) throw` line, so that line is unreachable, and an HMAC over
  an empty key succeeds. Verified: `"not a secret!!!"`, `"####"` and the empty
  string all return plausible six-digit codes. The user-visible effect is that a
  mistyped secret saves without complaint and then produces codes that never
  work, with nothing pointing at the cause. The fix is to reject in
  `decodeBase32` when stripping removed characters, or to require a minimum
  decoded length. Symbol: `decodeBase32`. *(2026-09-10)*

- **`system:copy` bypasses the clipboard auto-clear.** Sensitive copies go
  through `copySensitiveValue`, which schedules a clear; the generic
  `system:copy` channel writes up to 100,000 characters straight to the clipboard
  with no clear at all. Nothing stops a renderer panel from using the generic
  channel for something sensitive. Symbol: `copySensitiveValue`. *(2026-09-10)*
## Update integrity

- **The published SHA-256 is never compared against the bytes a user actually
  receives.** `validateManifest` checks that the manifest carries a well-formed
  64-character hex digest, and the download page displays it, but nothing in
  `electron/` ever hashes a file: there is no `createHash` call in the desktop
  code at all. `openUpdatePage` opens the signed download page in a tab and the
  user fetches the installer through the browser, so the digest is decoration.
  Integrity currently rests on TLS plus the expiring signed link. Closing this
  means the app downloading the installer itself and hashing it before offering
  to run it, which is a real feature rather than a patch. Symbol: `sha256`.
  *(2026-09-10)*

---

## Owner decisions — not engineering debt

Things that are deliberately open because they are a judgement call for the
person who owns the product, not work waiting on an engineer.

- **The Windows installer is not code-signed.** SmartScreen shows an
  unknown-publisher warning on every install, which is a real trust cost for a
  browser that holds credentials. A trusted code-signing certificate is an annual
  purchase and an identity-verification process. The workflow now signs
  automatically when `WINDOWS_CODE_SIGNING_CERTIFICATE` and
  `WINDOWS_CODE_SIGNING_PASSWORD` exist; obtaining them remains an owner decision.
  *(2026-09-10)*

- **Commercial threat-intelligence credentials are not configured.** Runtime
  hardening can block known tracker hosts and risky local file types, but a live
  phishing/malware interstitial requires a commercial reputation service. Use
  Google Web Risk or an equivalent business-licensed provider; the free Google
  Safe Browsing service is non-commercial. *(2026-09-10)*
