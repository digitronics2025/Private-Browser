# 2026-09-12 — Secure Google Account Spaces

Private Browser moved from one browser partition per fixed workspace to dynamic
Account Spaces beneath each workspace. The reason was isolation, not cosmetic
account switching: cookies, storage, Google grants, tabs, bookmarks, history and
permissions must never be reused between Google identities while Banking and
Development keep their existing policy.

The implementation preserved every legacy workspace partition, added an atomic
and idempotent state migration, independently encrypted account records, secure
Desktop OAuth with PKCE, narrow Google service clients, exact-origin permission
prompts, account-bound AI consent and ciphertext-only Drive app-data backup.

Chrome Sync/import and bookmark hierarchy work were deliberately excluded because
they do not exist in this repository. Live Google claims were also withheld until
an operator privately configures a real Desktop client and consent screen.
