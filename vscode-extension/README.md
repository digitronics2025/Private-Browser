# Private Browser Agent Bridge

This local-only companion connects a trusted VS Code workspace to the Private
Browser Development workspace. It shares the active file, selected text,
Problems, Git summary and named VS Code tasks. It can open a source location,
save files and run an existing task when Private Browser asks.

## Pair

1. In Private Browser, open **Development → Agent** and choose **Pair VS Code**.
2. In VS Code, run **Private Browser: Pair with Developer Cockpit**.
3. Enter the eight-digit code shown by Private Browser.

The reusable credential is kept in VS Code SecretStorage. The browser stores
only its SHA-256 digest. Communication stays on a local operating-system pipe;
websites cannot call the extension.
