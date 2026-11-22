# Review and recover a MyVault conflict

When MyVault reports a sync conflict, choose **Review versions**. The panel
shows when each copy changed, the number of entries, and differences in the
visible entry metadata. The review includes passkeys by site and account label.
Passwords, authenticator secrets and private keys stay inside MyVault.

**Keep local copy** publishes the reviewed copy only if the cloud version
still matches. **Keep cloud copy** applies the reviewed cloud copy to this
computer. Before either choice takes effect, Private Browser writes and verifies
encrypted `local.myvault` and `cloud.myvault` files in a dated recovery folder.
If the reviewed versions change, reload the review and choose again.

**Choose entries individually** appears when both compatible vaults agree on
passkeys, security keys, authenticator tokens and preferences. Choose one side
for every differing entry. Choosing an absent version removes that entry from
the merged copy. Private Browser keeps both original encrypted files before
writing the selection against the exact reviewed cloud version.

After resolving and unlocking, use **Show conflict recovery files** to locate
the archives. A `.myvault` archive can be opened with the original vault's
master password. MyVault's encrypted backup import accepts this format.
Open an archive first in a separate local MyVault profile with sync disconnected.
Importing replaces the vault on the chosen device. Review the recovered entries
before deciding how to return them to your working vault.
