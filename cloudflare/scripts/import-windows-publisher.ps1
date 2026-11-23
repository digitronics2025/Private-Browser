$ErrorActionPreference = 'Stop'
$approved = @($env:EXPECTED_CERTIFICATE_SHA256 -split '\s+' | Where-Object { $_ })
$signingValues = @($env:WINDOWS_SIGNING_PFX, $env:WINDOWS_SIGNING_PASSWORD, ($approved -join ' '))
$signingConfigured = @($signingValues | Where-Object { $_ }).Count -gt 0
if (-not $signingConfigured) {
    "configured=false" | Out-File -FilePath $env:GITHUB_OUTPUT -Append -Encoding utf8
    Write-Output 'No Windows signing identity is configured; stable installer will be explicitly unsigned.'
    exit 0
}
if (!$env:WINDOWS_SIGNING_PFX -or !$env:WINDOWS_SIGNING_PASSWORD -or !$approved.Count -or
    ($approved | Where-Object { $_ -notmatch '^[a-f0-9]{64}$' })) {
    throw 'Windows signing is partially configured; provide the complete approved certificate set or clear it for an unsigned release.'
}

$certificates = [Security.Cryptography.X509Certificates.X509Certificate2Collection]::new()
try {
    $pfx = [Convert]::FromBase64String($env:WINDOWS_SIGNING_PFX)
    $certificates.Import($pfx, $env:WINDOWS_SIGNING_PASSWORD, 'UserKeySet, PersistKeySet')
} catch {
    throw 'Could not load the production signing certificate into the Windows user key store.'
} finally {
    if ($pfx) { [Array]::Clear($pfx, 0, $pfx.Length) }
}

$signers = @($certificates | Where-Object {
    $_.HasPrivateKey -and
    $approved -contains $_.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256)
})
if ($signers.Count -ne 1) { throw 'The signing bundle must contain exactly one approved certificate with a private key.' }

$store = [Security.Cryptography.X509Certificates.X509Store]::new('My', 'CurrentUser')
try {
    $store.Open('ReadWrite')
    $store.Add($signers[0])
    "thumbprint=$($signers[0].Thumbprint)" | Out-File -FilePath $env:GITHUB_OUTPUT -Append -Encoding utf8
    "configured=true" | Out-File -FilePath $env:GITHUB_OUTPUT -Append -Encoding utf8
} finally {
    $store.Dispose()
    $certificates | ForEach-Object { $_.Dispose() }
}
