# Browsing privacy

In a regular Account Space, open **Settings → Browsing privacy**. **Enable browsing
encryption** protects browser-managed tabs, bookmarks, history, and account display
settings on this device. New Windows profiles use browsing encryption when OS key storage is available.
Existing profiles can enable it in Settings. Recognized sign-in, reset and
invitation URLs are excluded from automatic history. Restored tabs fall back to
their site origin for those URLs. Existing browser-managed files are minimized
on load and rewritten atomically when possible. After a successful conversion, new writes use authenticated
encryption with a key wrapped by Windows. If a write is interrupted, restart or
choose **Retry encryption** to finish converting the current files.

Use **Export recovery file** for each Account Space before moving to a new device
or Windows profile. Choose a long passphrase and keep it separately from the file.
In an unlocked Account Space in the same workspace, choose **Restore recovery
file**, enter the passphrase, and review the merge counts. Restore merges bookmarks,
folders and retained history. Cookies, credentials, tabs and existing Vault
contents stay outside the portable file. Archives over the 12 MiB limit are refused.

Keep the last verified file until you have tested a newer one. Windows encryption
keys travel with the original Windows user profile. If a key becomes unavailable,
Private Browser preserves the unreadable files and shows a locked recovery tab. Use
an intact profile or a clean installation to open the portable file.

Choose a history retention period to remove older browser-managed history across
Account Spaces. **No time limit** uses the existing browser storage limit. The
minimal privacy log keeps the event type and minute and drops descriptions from
current and future entries. Older backups, Chrome import sources, website cache,
cookies, and deleted disk blocks may still contain traces.
