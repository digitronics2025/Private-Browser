# Windows publisher verification

The production workflow signs both the installed application and the final
installer. It checks the embedded Authenticode signature, the timestamp and the
SHA-256 fingerprint of the signing certificate. The approved fingerprint is
packaged into the application. Managed updates and the Downloads panel
verify it on Windows before opening a release installer.

Configure the GitHub environment named `production-release` with an approved
reviewer and a deployment policy restricted to protected `main`. Use these
environment secrets through the approved credential custody process.

| Secret | Scope |
|---|---|
| `PRODUCTION_WINDOWS_SIGNING_CERTIFICATE`, `PRODUCTION_WINDOWS_SIGNING_PASSWORD` | Approved base64 PKCS#12 bundle and password |
| `PRODUCTION_RELEASE_R2_ACCESS_KEY_ID`, `PRODUCTION_RELEASE_R2_SECRET_ACCESS_KEY`, `PRODUCTION_RELEASE_ACCOUNT_ID` | R2 S3 Object Read & Write for `private-browser-releases` only |
| `PRODUCTION_RELEASE_VERIFY_DEVICE` | Enrolled release verification device |
| `PRODUCTION_RELEASE_AUTOMATION_KEY` | Worker release registration and bounded recovery |

Configure the same release automation credential as the Worker’s
`RELEASE_AUTOMATION_KEY` secret. It must differ from `ADMIN_API_KEY` and has no
device or distribution administration privileges.

Set the public certificate SHA-256 as `WINDOWS_CODE_SIGNING_CERTIFICATE_SHA256`
in the protected environment and point `PRIVATE_BROWSER_DOWNLOAD_URL` at the
reviewed production Worker origin. The owner must still approve the exact main
commit in the `PRIVATE_BROWSER_AGENT_MODE_RELEASE_APPROVED` repository variable.
After approval, select **Verify and package** → **Run workflow**, choose `main`,
and enable **Sign and publish the owner-approved main commit**. The production
environment reviewer must approve the job before it can access credentials.
Ordinary Windows verification uses the default unchecked input.

The production signing step imports the bundle from memory into the Windows
user certificate store on the disposable runner. Packaging selects the approved
certificate by its public store thumbprint. The password stays in the import
step and the workflow removes the certificate and key after signing.

Before first use, deploy the approved Worker and apply migration 0005 through
the Cloudflare owner workflow. Verify installation and upgrade from 0.6.58 in
disposable Windows profiles. Distribute the expected publisher identity via a
trusted administrator or independently controlled owner channel. The older
unsigned client itself cannot enforce an independent publisher identity.

The workflow tests the exact signed installer. The staging step uses the
bucket-scoped S3 credential to write new objects conditionally and verify the
private R2 readback. A separate step uses the scoped Worker release key to
publish. Retain the `.publisher.json` object
alongside the installer. The verification checks include a download from the
active feed and byte-range resume. Failed live verification restores only an
eligible signed build. When no eligible predecessor exists, the workflow
suspends the failed release. A forward recovery must declare a higher version
than the suspended build before the owner approves its promotion.

Windows can independently verify the installer with PowerShell.

```powershell
Get-AuthenticodeSignature -LiteralPath .\Private-Browser-Setup.exe
Get-FileHash -LiteralPath .\Private-Browser-Setup.exe -Algorithm SHA256
```

For renewal, approve old and new certificate fingerprints in a transition
build signed with the old certificate before switching signers. The
packaged policy supports multiple fingerprints. Coordinate changes with
the release owner and verify both the upgrade and recovery paths.
[Microsoft Authenticode documentation](https://learn.microsoft.com/powershell/module/microsoft.powershell.security/get-authenticodesignature)
