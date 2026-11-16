# Project safeguards

Project-specific safety and product constraints below remain binding. Current
authority, execution, verification classification and release procedures are in
[the authored contract](agent-contract.md), which resolves any old process wording.
Past approvals are not permission; verify dated claims against current code.
Read relevant sections before changing their subsystem.

## Trust boundary

[SECURITY.md](../SECURITY.md) is a contract, not a description. Every loaded site
is hostile: no Node and no preload in remote views, one typed preload bridge for
the trusted chrome, per-workspace session partitions, `safeStorage` for the
vault and update config, AI extraction refused in Banking. Read it before
changing `electron/security.ts`, `electron/vault.ts`, `electron/preload.cts`, or
anything that widens what a remote page can reach.

