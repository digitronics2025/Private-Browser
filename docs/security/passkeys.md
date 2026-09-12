# MyVault passkeys in Private Browser

Status: **release gate disabled** (2026-09-12).

Private Browser contains the reviewed portable MyVault passkey record, ES256, CBOR/COSE, client-data, authenticator-data, immutable append, and fail-closed origin code. The browser-specific provider is an internal CDP document-start controller; it does not load the Chrome extension, expose a preload to remote pages, or trust page-supplied origin/frame identity.

The provider is globally disabled and therefore the operating-system WebAuthn implementation remains unchanged. Enabling it would additionally require explicit global, workspace, and exact-site opt-ins. Banking and Development remain disabled by policy, and an attached DevTools controller forces OS fallback.

## Failing release gate

The repository does not yet have an automated Electron Playwright harness that proves the CDP shim executes before a page's first inline script in the packaged app. Unit tests cover the cryptographic ceremony, exact-origin subset, iframe/opaque refusal, immutable record behavior, cancellation/fallback source, and opt-in/provider-conflict rules, but those tests cannot prove real Chromium document-start ordering. The approved release rule says this uncertainty must leave the provider disabled.

Before changing `PASSKEY_RELEASE_GATE.enabled`, add a packaged-Electron test that proves first-inline-script interception, Electron-derived origin/RP binding, iframe and opaque-origin refusal, navigation/replay cancellation, concurrent provider conflict, DevTools conflict, and original OS fallback.
