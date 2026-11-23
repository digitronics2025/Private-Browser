# Recover a Private Browser release

The download page identifies the current stable build and shows up to five
earlier publications. **Promoted** means the normal release workflow made the
build available. **Restored** includes the last time the release service
activated that build again. The restore marker starts when the release history
migration is applied. The history links lead to documentation and CI evidence.
The usual download and update routes serve the current build.

## Maintainer recovery

1. Use the release registry and its signed CI receipts to identify an eligible, known-good
   stable release ID, build, source revision, file size and SHA-256. Verify its
   retained installer against that checksum. Record the currently active ID as
   well, so it can be reinstated if necessary.
2. Read the intervening release notes and check whether the older browser can
   read profiles already used by the newer build. Exercise the older installer
   on a disposable Windows profile. If a data format changed, recover with a
   forward fix or a separately verified pre-upgrade backup. A server rollback
   changes which installer is offered and leaves installed profiles alone.
3. Obtain the owner's approval for the exact release and use the established
   release credentials workflow. Run `node cloudflare/scripts/activate-release.mjs <stable-release-id>`
   with the approved service URL and admin credential available to that command.
   The script requests the existing admin-only activation route. Keep keys out
   of command history, files and output.
4. Verify the active ID and source revision through the live manifest. Check
   health, the full delivered SHA-256 and an HTTP range response. Check that the
   download page shows **Current stable build** and **Restored** for that version.
   The desktop updater still compares versions. An older installer requires a
   deliberate manual install after reviewing profile compatibility.

The automated release pipeline uses the same activation route when its live
verification fails. An eligible signed release or an explicitly unsigned release
with digest-bound publisher evidence can be restored. If no eligible release can
be restored, it suspends the exact failed build. Prepare a higher-version forward
fix in that case. The history keeps direct links to retained installer objects
private.
