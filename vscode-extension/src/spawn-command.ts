import { spawn, spawnSync, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { join } from 'node:path';

/**
 * Characters that are inert inside a quoted `cmd.exe` argument. `%` and `!`
 * expand variables, `^ & | < > "` change the command itself — none may pass.
 */
const CMD_SAFE_PART = /^[A-Za-z0-9 _\-.:\\/@+=,()~]+$/;

export interface CommandInvocation { file: string; args: string[]; verbatim: boolean }

/**
 * How an approved command is started.
 *
 * Since CVE-2024-27980, Node refuses to spawn a `.cmd` or `.bat` file without a
 * shell (`EINVAL`), so `npm.cmd`, `gradlew.bat` and `wrangler.cmd` never started
 * on Windows (F-43). They run through `cmd.exe /d /s /c` instead — addressed by
 * absolute path, never through a browser-supplied string — and only when every
 * part is free of characters cmd would interpret; anything else is refused.
 */
export function commandInvocation(executable: string, args: readonly string[], platform: NodeJS.Platform = process.platform): CommandInvocation {
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(executable)) return { file: executable, args: [...args], verbatim: false };
  const parts = [executable, ...args];
  if (!parts.every((part) => CMD_SAFE_PART.test(part))) {
    throw new Error('This command contains characters a Windows command script cannot run safely');
  }
  const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
  return { file: shell, args: ['/d', '/s', '/c', `"${parts.map((part) => `"${part}"`).join(' ')}"`], verbatim: true };
}

/**
 * A bare script name (`npm.cmd`) is resolved to its full path first: cmd.exe
 * gives a script invoked by a quoted bare name the wrong `%~dp0`, and npm's own
 * shim then looks for its files in the current folder.
 */
export function resolveOnPath(executable: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32' || /[\\/]/.test(executable)) return executable;
  const found = spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe'), [executable], { encoding: 'utf8', windowsHide: true, shell: false });
  const first = found.status === 0 ? found.stdout.split(/\r?\n/).find(Boolean) : undefined;
  if (!first) throw new Error(`${executable} was not found on this computer`);
  return first.trim();
}

export function spawnCommand(executable: string, args: readonly string[], options: SpawnOptionsWithoutStdio): ChildProcessWithoutNullStreams {
  const invocation = commandInvocation(/\.(?:cmd|bat)$/i.test(executable) ? resolveOnPath(executable) : executable, args);
  return spawn(invocation.file, invocation.args, { ...options, shell: false, windowsVerbatimArguments: invocation.verbatim });
}
