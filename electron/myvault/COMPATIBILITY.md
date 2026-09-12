# MyVault compatibility contract

The files in this directory are a minimal reviewed port of MyVault's encrypted
envelope reader. They are pinned to MyVault commit `ccb64aba4a58ff7af2d4b7229fc2d663b95a14b6`.

- Envelope format: `myvault`, version 1
- Payload schema: version 2, with forward refusal
- Password encoding: Unicode NFKC followed by UTF-8
- KDF: Argon2id using the parameters stored in the envelope
- Cipher: AES-256-GCM with a 128-bit tag
- Wrapped-key AAD: `myvault:v1:<vaultId>:wrapped-key`
- Payload AAD: `myvault:v1:<vaultId>:payload`
- Base64: standard padded alphabet

`security/vectors.json` preserves the source JSON values unchanged from that commit. The browser's
compatibility suite runs every vector, including the production 64 MiB KDF case.
Do not regenerate the vectors to make a test pass; update all readers through a
coordinated protocol change instead.
