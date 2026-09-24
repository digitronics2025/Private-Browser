import { spawn } from 'node:child_process';
import { join } from 'node:path';

/**
 * Windows Hello as a key-release gate for MyVault.
 *
 * Hello does not hand out secrets; it signs. `KeyCredentialManager` keeps an
 * RSA-2048 key in the TPM-backed Hello container and signs only after the user
 * passes face, fingerprint or PIN. RSASSA-PKCS1-v1_5 is deterministic, so the
 * signature over a fixed random challenge is a stable secret that exists only
 * when this Windows account, on this device, completes the gesture. The broker
 * stretches it into the key that wraps the vault data key a second time.
 *
 * The WinRT call runs in a short-lived Windows PowerShell child: the release
 * ships no native module, and PowerShell 5.1 is part of every Windows 10/11
 * install. The executable is addressed by absolute path so a planted
 * `powershell.exe` earlier on PATH is never run, and the challenge travels on
 * stdin, not the command line.
 */

export type PlatformUnlockStatus =
  | 'UserCanceled'
  | 'NotFound'
  | 'UserPrefersPassword'
  | 'SecurityDeviceLocked'
  | 'Unsupported'
  | 'Timeout'
  | 'Error';

export class PlatformUnlockError extends Error {
  /** `detail` is the raw Windows message for logs; it never carries key material. */
  constructor(readonly status: PlatformUnlockStatus, readonly detail?: string) {
    super(platformUnlockMessage(status));
    this.name = 'PlatformUnlockError';
  }
}

function platformUnlockMessage(status: PlatformUnlockStatus): string {
  if (status === 'UserCanceled') return 'Windows Hello was cancelled.';
  if (status === 'NotFound') return 'The Windows Hello key for MyVault is gone. Unlock with the master password and turn Windows Hello on again.';
  if (status === 'UserPrefersPassword') return 'Unlock with the master password instead.';
  if (status === 'SecurityDeviceLocked') return 'Windows Hello is locked after too many attempts. Unlock with the master password.';
  if (status === 'Unsupported') return 'Windows Hello is not set up on this computer.';
  if (status === 'Timeout') return 'Windows Hello did not answer in time.';
  return 'Windows Hello could not complete the request.';
}

/** What the broker needs from the platform. Tests substitute a deterministic signer. */
export interface PlatformUnlockSigner {
  isAvailable(): Promise<boolean>;
  /** Creates (or replaces) the named key, then signs. Raises the Hello prompt. */
  enroll(keyName: string, challenge: Uint8Array): Promise<Uint8Array>;
  /** Signs with the existing key. Raises the Hello prompt. */
  sign(keyName: string, challenge: Uint8Array): Promise<Uint8Array>;
  remove(keyName: string): Promise<void>;
}

const KEY_NAME_PATTERN = /^PrivateBrowser-MyVault-[A-Za-z0-9_-]{16,128}$/;
const STATUSES = new Set<PlatformUnlockStatus>(['UserCanceled', 'NotFound', 'UserPrefersPassword', 'SecurityDeviceLocked', 'Unsupported', 'Timeout', 'Error']);

/** One Hello key per vault identity, so a replaced vault never reuses an old key. */
export function platformUnlockKeyName(vaultId: string): string {
  const name = `PrivateBrowser-MyVault-${vaultId}`;
  if (!KEY_NAME_PATTERN.test(name)) throw new Error('This vault identity cannot name a Windows Hello key');
  return name;
}

/**
 * Everything is inside one try so any failure prints a status line rather than
 * a PowerShell error record. The foreground step matters: the Hello dialog
 * belongs to a system host, and without it the prompt can open behind the
 * browser. A process started by the foreground app is allowed to hand focus
 * over, which is exactly this child's position.
 */
const HELLO_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
function Emit($value) { [Console]::Out.Write(($value | ConvertTo-Json -Compress)) }
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTaskOperation = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation${'`'}1' } | Select-Object -First 1
  $asTaskAction = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1
  [void][Windows.Security.Credentials.KeyCredentialManager, Windows.Security.Credentials, ContentType = WindowsRuntime]
  $focus = $false
  if ($request.op -eq 'enroll' -or $request.op -eq 'sign') { try {
    Add-Type -Namespace PrivateBrowser -Name HelloWindow -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string className, string windowName); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);'
    $focus = $true
  } catch {} }
  function Await($operation, [Type]$resultType) {
    $task = $asTaskOperation.MakeGenericMethod($resultType).Invoke($null, @($operation))
    for ($attempt = 0; $focus -and $attempt -lt 50 -and -not $task.IsCompleted; $attempt++) {
      $handle = [PrivateBrowser.HelloWindow]::FindWindow('Credential Dialog Xaml Host', $null)
      if ($handle -ne [IntPtr]::Zero) { [void][PrivateBrowser.HelloWindow]::SetForegroundWindow($handle); break }
      Start-Sleep -Milliseconds 100
    }
    $task.Wait() | Out-Null
    $task.Result
  }
  $manager = [Windows.Security.Credentials.KeyCredentialManager]
  if ($request.op -eq 'available') {
    Emit @{ ok = $true; available = [bool](Await ($manager::IsSupportedAsync()) ([bool])) }
    return
  }
  if ($request.op -eq 'remove') {
    $task = $asTaskAction.Invoke($null, @($manager::DeleteAsync($request.keyName)))
    try { $task.Wait() | Out-Null } catch {}
    Emit @{ ok = $true }
    return
  }
  if (-not (Await ($manager::IsSupportedAsync()) ([bool]))) { Emit @{ ok = $false; status = 'Unsupported' }; return }
  if ($request.op -eq 'enroll') {
    $retrieval = Await ($manager::RequestCreateAsync($request.keyName, [Windows.Security.Credentials.KeyCredentialCreationOption]::ReplaceExisting)) ([Windows.Security.Credentials.KeyCredentialRetrievalResult])
  } else {
    $retrieval = Await ($manager::OpenAsync($request.keyName)) ([Windows.Security.Credentials.KeyCredentialRetrievalResult])
  }
  if ($retrieval.Status -ne 'Success') { Emit @{ ok = $false; status = [string]$retrieval.Status }; return }
  # PowerShell 5.1 cannot hand a native IBuffer back to a WinRT method, so bytes cross
  # the boundary as managed buffers: AsBuffer going in, ToArray (via reflection) coming out.
  $bufferExtensions = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]
  $challenge = $bufferExtensions::AsBuffer([Convert]::FromBase64String($request.challenge))
  $signed = Await ($retrieval.Credential.RequestSignAsync($challenge)) ([Windows.Security.Credentials.KeyCredentialOperationResult])
  if ($signed.Status -ne 'Success') { Emit @{ ok = $false; status = [string]$signed.Status }; return }
  $toArray = $bufferExtensions.GetMethod('ToArray', [Type[]]@([Windows.Storage.Streams.IBuffer]))
  Emit @{ ok = $true; signature = [Convert]::ToBase64String($toArray.Invoke($null, @($signed.Result))) }
} catch {
  Emit @{ ok = $false; status = 'Error'; detail = [string]$_.Exception.Message }
}
`;

interface HelloRequest { op: 'available' | 'enroll' | 'sign' | 'remove'; keyName?: string; challenge?: string }
interface HelloReply { ok?: unknown; available?: unknown; signature?: unknown; status?: unknown; detail?: unknown }

export type HelloRunner = (request: HelloRequest) => Promise<HelloReply>;

function powershellPath(): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** A Hello prompt waits on a person; two minutes matches the secure dialog timeout. */
const HELLO_TIMEOUT_MS = 120_000;

export const runHelloScript: HelloRunner = (request) => new Promise((resolve, reject) => {
  const child = spawn(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(HELLO_SCRIPT, 'utf16le').toString('base64')], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let output = '';
  let settled = false;
  const finish = (callback: () => void) => { if (!settled) { settled = true; clearTimeout(timer); callback(); } };
  const timer = setTimeout(() => finish(() => { child.kill(); reject(new PlatformUnlockError('Timeout')); }), HELLO_TIMEOUT_MS);
  timer.unref();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { if (output.length < 16_384) output += chunk; });
  child.on('error', () => finish(() => reject(new PlatformUnlockError('Unsupported'))));
  child.on('close', () => finish(() => {
    try { resolve(JSON.parse(output) as HelloReply); }
    catch { reject(new PlatformUnlockError('Error')); }
  }));
  child.stdin.end(JSON.stringify(request));
});

function signatureFrom(reply: HelloReply): Uint8Array {
  if (reply.ok === true && typeof reply.signature === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(reply.signature)) {
    const signature = Buffer.from(reply.signature, 'base64');
    if (signature.length >= 128) return new Uint8Array(signature);
  }
  const status = typeof reply.status === 'string' && STATUSES.has(reply.status as PlatformUnlockStatus) ? reply.status as PlatformUnlockStatus : 'Error';
  throw new PlatformUnlockError(status, typeof reply.detail === 'string' ? reply.detail.slice(0, 500) : undefined);
}

export class WindowsHelloSigner implements PlatformUnlockSigner {
  constructor(private readonly run: HelloRunner = runHelloScript, private readonly platform: NodeJS.Platform = process.platform) {}

  async isAvailable(): Promise<boolean> {
    if (this.platform !== 'win32') return false;
    try {
      const reply = await this.run({ op: 'available' });
      return reply.ok === true && reply.available === true;
    } catch {
      return false;
    }
  }

  async enroll(keyName: string, challenge: Uint8Array): Promise<Uint8Array> {
    return signatureFrom(await this.request('enroll', keyName, challenge));
  }

  async sign(keyName: string, challenge: Uint8Array): Promise<Uint8Array> {
    return signatureFrom(await this.request('sign', keyName, challenge));
  }

  async remove(keyName: string): Promise<void> {
    if (this.platform !== 'win32' || !KEY_NAME_PATTERN.test(keyName)) return;
    await this.run({ op: 'remove', keyName }).catch(() => undefined);
  }

  private request(op: 'enroll' | 'sign', keyName: string, challenge: Uint8Array): Promise<HelloReply> {
    if (this.platform !== 'win32') throw new PlatformUnlockError('Unsupported');
    if (!KEY_NAME_PATTERN.test(keyName)) throw new Error('Invalid Windows Hello key name');
    return this.run({ op, keyName, challenge: Buffer.from(challenge).toString('base64') });
  }
}
