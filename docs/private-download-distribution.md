# Private download distribution

The release owner chooses **Public** or **Private**. Public provides the release
page and stable feed. Private requires an enrolled device for the feed and every
installer request, including HEAD and byte ranges. Revocation takes effect on
the next request. Installers built by CI carry the same neutral bootstrap.

The download service owner uses the authenticated admin API. Keep the admin key
in approved secret storage and submit it as the `x-api-key` header. **POST
`/api/v1/admin/download-devices`** with a device label to issue a one-time code.
Open **Settings → App updates → Enroll this device** on the target PC and enter
that code in the isolated window. The code expires after 15 minutes. Windows
encrypts the generated device credential. Check for updates to verify the device.

**GET `/api/v1/admin/download-devices`** lists labels, enrollment, last use and
revocation. **POST `/api/v1/admin/download-devices/{id}/revoke`** removes the
device's future access. Keep a verified offline installer and a second device
available for recovery. If a device is lost, revoke it and issue a code for
its replacement.

Before a live rollout, apply the approved D1 migration, deploy the exact Worker,
and verify enrollment while Public is active. Enroll a separate CI verification
device, save its credential through the approved secret custody workflow, and
configure `PRIVATE_BROWSER_RELEASE_VERIFY_DEVICE` in GitHub Actions. The release
workflow checks the active feed before uploading a new installer and verifies
full bytes and resumed ranges with that identity. The existing exact desktop
publication approval still applies.

With the owner's policy approval, use **POST `/api/v1/admin/distribution`** with
`mode: private` and `confirm: SWITCH_TO_PRIVATE` after verifying the device.
Confirm the public routes return 404 and the enrolled app can check and download.
To restore public access, use `mode: public` and `confirm: SWITCH_TO_PUBLIC`.
**GET `/api/v1/distribution`** reports the active policy.
