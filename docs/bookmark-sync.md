# Encrypted bookmark sync

Open **Bookmarks → Encrypted bookmark sync** in a regular Account Space. Connect
Google and enable **Encrypted backup** access. **Start pairing** creates a separate
encrypted bookmark file in Google Drive app data. **Save pairing file** creates
an encrypted `.pbpair` file for your other device. Use a long passphrase and
transfer it separately. On the second device, choose the same workspace and
Google account and select **Open pairing file**.

Use **Review sync** before sharing changes. The first sync combines the two
libraries. Later reviews compare each device with their last shared version.
An edit against a deletion is a conflict. Choose which version to keep for the
listed conflicts. **Apply bookmark sync** checks that the exact reviewed versions
still match, then updates the encrypted library and local bookmarks. The panel
shows the last successful sync. Drive uses a reserved file ID to keep setup
retries on the same library. [Drive file IDs](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/generateIds)

The shared copy contains bookmarks and their folders. Links with recognized
sign-in token parameters stay local. The paired library supports up to 3.5 MB
before encryption. **Disconnect this device** keeps its local bookmarks and
removes the saved pairing. Keep a verified pairing file for recovery or
reconnecting another Windows profile.
