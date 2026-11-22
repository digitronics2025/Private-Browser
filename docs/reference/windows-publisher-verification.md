# Windows publisher verification

The Windows job records Authenticode status against the installer SHA-256.
Signed builds require a valid embedded signature that matches the owner-approved
public certificate fingerprint in the `WINDOWS_CODE_SIGNING_CERTIFICATE_SHA256`
repository variable. The expected value is the 64-character SHA-256 of the
encoded signing certificate. Certificate and password secrets stay in the
existing build step. An unsigned build receives an explicit unsigned result.

The publish job verifies the receipt against the exact candidate bytes and reads
its private R2 copy back. Retain each `.publisher.json` object alongside its
installer. The public and private download pages show publisher verification,
the installer checksum and the signed download link separately. Older releases
show that publisher verification is unavailable.

Deploy the download Worker before publishing the first installer that requires
the receipt. The release workflow verifies the receipt appears on both pages. If
the live test fails, the workflow restores the preceding active installer.

Windows can also check the downloaded file using PowerShell.

```powershell
Get-AuthenticodeSignature -LiteralPath .\Private-Browser-Setup.exe
Get-FileHash -LiteralPath .\Private-Browser-Setup.exe -Algorithm SHA256
```

[Microsoft’s Authenticode documentation](https://learn.microsoft.com/powershell/module/microsoft.powershell.security/get-authenticodesignature)
