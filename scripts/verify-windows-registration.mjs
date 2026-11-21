import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// The smoke install owns its whole Windows user profile on a disposable runner.
if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') process.exit(0);
if (!process.env.RUNNER_TEMP) throw new Error('The hosted runner temporary directory is unavailable');

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('Invalid installer version');
const smokeScript = String.raw`
$ErrorActionPreference = "Stop"
$installed = $env:PRIVATE_BROWSER_CI_INSTALL_ROOT
$setup = $env:PRIVATE_BROWSER_CI_INSTALLER
$registered = "HKCU:\Software\RegisteredApplications"
$client = "HKCU:\Software\Clients\StartMenuInternet\PrivateBrowser"
$handler = "HKCU:\Software\Classes\Digitronics.PrivateBrowser.Url"
$uninstaller = Join-Path $installed "Uninstall Private Browser.exe"
function ExistingChoice([string]$scheme) {
  $path = "HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\$scheme\UserChoice"
  (Get-ItemProperty -LiteralPath $path -Name "ProgId" -ErrorAction SilentlyContinue).ProgId
}
if ((Get-ItemProperty -LiteralPath $registered -Name "Private Browser" -ErrorAction SilentlyContinue) -or (Test-Path -LiteralPath $client) -or (Test-Path -LiteralPath $handler)) {
  throw "Installer registration smoke test requires a clean runner profile"
}
$httpBefore = ExistingChoice "http"
$httpsBefore = ExistingChoice "https"
try {
  $result = Start-Process -FilePath $setup -ArgumentList @("/S", "/currentuser", ("/D=" + $installed)) -WindowStyle Hidden -Wait -PassThru
  if ($result.ExitCode -ne 0) { throw "Installer failed on the disposable Windows runner" }
  $app = (Get-ItemProperty -LiteralPath $registered -Name "Private Browser")."Private Browser"
  if ($app -ne "Software\Clients\StartMenuInternet\PrivateBrowser\Capabilities") { throw "Private Browser is missing from Default Apps registration" }
  $protocols = Get-ItemProperty -LiteralPath "$client\Capabilities\URLAssociations"
  if ($protocols.http -ne "Digitronics.PrivateBrowser.Url" -or $protocols.https -ne "Digitronics.PrivateBrowser.Url") {
    throw "HTTP and HTTPS must both point at the Private Browser handler"
  }
  $open = (Get-Item -LiteralPath "$handler\shell\open\command").GetValue("")
  $exe = Join-Path $installed "Private Browser.exe"
  $quote = [string][char]34
  $expected = $quote + $exe + $quote + " " + $quote + "%1" + $quote
  if ($open -ne $expected -or -not (Test-Path -LiteralPath $exe)) { throw "The registered URL command does not reference the installed executable" }
  if ((ExistingChoice "http") -ne $httpBefore -or (ExistingChoice "https") -ne $httpsBefore) { throw "Installing changed a Windows default browser choice" }
} finally {
  if (Test-Path -LiteralPath $uninstaller) {
    $result = Start-Process -FilePath $uninstaller -ArgumentList "/S" -WindowStyle Hidden -Wait -PassThru
    if ($result.ExitCode -ne 0) { throw "The disposable installation could not be removed" }
  }
}
if ((Get-ItemProperty -LiteralPath $registered -Name "Private Browser" -ErrorAction SilentlyContinue) -or (Test-Path -LiteralPath $client) -or (Test-Path -LiteralPath $handler)) {
  throw "Uninstall left a stale Private Browser registration"
}
Write-Output "Verified installed HTTP and HTTPS registration and clean uninstall"
`;

execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', smokeScript], {
  env: {
    ...process.env,
    PRIVATE_BROWSER_CI_INSTALL_ROOT: mkdtempSync(join(process.env.RUNNER_TEMP, 'private-browser-registration-')),
    PRIVATE_BROWSER_CI_INSTALLER: resolve('release', 'Private-Browser-' + version + '-Setup.exe'),
  },
  stdio: 'inherit',
  timeout: 180_000,
  windowsHide: true,
});
