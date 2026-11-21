import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateIdentity, type DeviceIdentity } from '@private-browser/bridge-protocol';
import { z } from 'zod';

const identitySchema = z.object({
  id: z.string().uuid(),
  identity: z.object({ publicKey: z.string().min(40).max(200), privateKey: z.string().min(40).max(200) }).strict(),
  browserFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type StoredAgentIdentity = z.infer<typeof identitySchema>;

const powerShell = {
  protect: `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String([Console]::In.ReadToEnd()), $null, 'CurrentUser'))`,
  unprotect: `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String([Console]::In.ReadToEnd()), $null, 'CurrentUser'))`,
};

function runStore(executable: string, args: string[], input = ''): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], timeout: 12_000 });
    let output = '';
    const error = () => reject(new Error('The operating-system key store is unavailable.'));
    child.once('error', error);
    child.stdin.on('error', error);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 16_384) { child.kill(); error(); }
    });
    child.once('close', (code) => code === 0 ? resolve(output.trim()) : error());
    child.stdin.end(input);
  });
}

function dpapi(mode: keyof typeof powerShell, input: string) {
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return runStore(executable, ['-NoProfile', '-NonInteractive', '-Command', powerShell[mode]], input);
}

export function createAgentIdentity(): { id: string; identity: DeviceIdentity } {
  return { id: randomUUID(), identity: generateIdentity() };
}

export async function loadAgentIdentity(root: string, client: string): Promise<StoredAgentIdentity | undefined> {
  const path = join(root, `${client}.enc`);
  try {
    const file = await lstat(path);
    if (!file.isFile() || file.size > 16_384) throw new Error('Invalid Agent pairing file.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const stored = await readFile(path, 'utf8');
  if (process.platform === 'win32') {
    const value = await dpapi('unprotect', stored);
    return identitySchema.parse(JSON.parse(Buffer.from(value, 'base64').toString('utf8')));
  }
  if (process.platform === 'linux') {
    if (!z.string().uuid().safeParse(stored).success) throw new Error('Invalid Agent keyring reference.');
    const value = await runStore('secret-tool', ['lookup', 'application', 'private-browser-mcp', 'device', stored]);
    return identitySchema.parse(JSON.parse(value));
  }
  throw new Error('Agent pairing needs Windows DPAPI or Linux Secret Service.');
}

export async function saveAgentIdentity(root: string, client: string, value: StoredAgentIdentity): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, `${client}.enc`);
  const tmp = `${path}.${randomUUID()}.tmp`;
  const json = JSON.stringify(value);
  let contents: string;
  if (process.platform === 'win32') {
    contents = await dpapi('protect', Buffer.from(json).toString('base64'));
    if (!contents) throw new Error('Windows could not protect the Agent identity.');
  } else if (process.platform === 'linux') {
    await runStore('secret-tool', ['store', '--label=Private Browser coding agent', 'application', 'private-browser-mcp', 'device', value.id], json);
    contents = value.id;
  } else {
    throw new Error('Agent pairing needs Windows DPAPI or Linux Secret Service.');
  }
  await writeFile(tmp, contents, { flag: 'wx', mode: 0o600 });
  try { await rename(tmp, path); } finally { await rm(tmp, { force: true }); }
}
