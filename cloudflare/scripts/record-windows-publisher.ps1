[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Installer,
    [Parameter(Mandatory = $true)][string]$Sha256,
    [Parameter(Mandatory = $true)][string]$Destination,
    [switch]$SigningConfigured,
    [string]$ExpectedCertificateSha256
)

$ErrorActionPreference = 'Stop'
if ($Sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Installer checksum is invalid.' }
$signature = Get-AuthenticodeSignature -LiteralPath $Installer
$receipt = @{ schemaVersion = 1; sha256 = $Sha256 }
if ($SigningConfigured) {
    if ($ExpectedCertificateSha256 -notmatch '^[a-f0-9]{64}$') {
        throw 'Set the approved Windows publisher certificate SHA-256 before publishing a signed installer.'
    }
    if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate -or $signature.SignatureType -ne 'Authenticode') {
        throw 'The installer has no valid embedded Authenticode signature.'
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $certificateHash = [BitConverter]::ToString($sha.ComputeHash($signature.SignerCertificate.RawData)).Replace('-', '')
    } finally {
        $sha.Dispose()
    }
    if ($certificateHash -ine $ExpectedCertificateSha256) {
        throw 'The signer certificate differs from the approved Windows publisher certificate.'
    }
    $publisher = $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false).Trim()
    if (-not $publisher -or $publisher.Length -gt 160 -or $publisher -match '[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]') {
        throw 'The verified certificate has no display-safe publisher name.'
    }
    $receipt.status = 'verified'
    $receipt.publisher = $publisher
} else {
    if ($signature.Status -ne 'NotSigned') { throw 'The installer has an unexpected Windows signature status.' }
    $receipt.status = 'unsigned'
}
$receipt | ConvertTo-Json -Compress | Set-Content -LiteralPath $Destination -Encoding UTF8
Write-Output ('Windows installer publisher check: ' + $receipt.status)
