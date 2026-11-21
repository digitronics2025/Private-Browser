import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { AgentError } from './agent-policy.js';
import { isSecretPath, resolveInsideWorkspace } from '@private-browser/bridge-protocol/workspace-path';

const UPLOAD_BYTES = 25 * 1024 * 1024;
const reservedDevice = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/iu;
const browserDirectories = /(?:^|[\\/])(?:Private Browser|Private Browser Agents|Partitions|IndexedDB|Local State|Local Storage|Web Data|MyVault)(?:[\\/]|$)/i;
const blocked = (value: string) => isSecretPath(value) || browserDirectories.test(value);
const denied = () => new AgentError('UPLOAD_PATH_DENIED', 'Choose an ordinary file in the approved upload folder.');

const inside = (parent: string, child: string) => {
  const entry = relative(parent, child);
  return entry === '' || !isAbsolute(entry) && entry !== '..' && !entry.startsWith(`..${sep}`);
};

export async function verifyUploadFolder(value: string, agentData: string): Promise<string> {
  if (!isAbsolute(value) || value.startsWith('\\\\') || blocked(value)) throw denied();
  const folder = await realpath(value);
  const userData = dirname(agentData);
  if (folder.startsWith('\\\\') || folder === parse(folder).root || blocked(folder)
    || inside(folder, homedir()) || inside(folder, userData) || inside(userData, folder)
    || !(await lstat(folder)).isDirectory()) throw denied();
  return folder;
}

export async function stageAgentUpload(folder: string, value: string, data: string): Promise<{ path: string; clean(): Promise<void> }> {
  const noDrive = value.replace(/^[a-z]:[\\/]/i, '');
  if (!value || value.startsWith('\\\\') || value.includes('\0') || noDrive.includes(':')
    || noDrive.split(/[\\/]/).some((part) => part === '..' || /[. ]$/.test(part) || reservedDevice.test(part))) throw denied();
  if (folder !== await verifyUploadFolder(folder, data)) throw denied();
  const candidate = isAbsolute(value) ? resolve(value) : resolve(folder, value);
  if (!inside(folder, candidate) || blocked(candidate)) throw denied();
  const canonical = await resolveInsideWorkspace(folder, candidate).catch(() => { throw denied(); });
  if (blocked(canonical) || relative(canonical, candidate) !== '') throw denied();
  const metadata = await lstat(canonical);
  if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > UPLOAD_BYTES) throw denied();
  const handle = await open(canonical, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    const opened = await handle.stat();
    if (relative(canonical, await realpath(candidate)) !== '') throw denied();
    if (opened.dev !== metadata.dev || opened.ino !== metadata.ino || !opened.isFile() || opened.nlink !== 1 || opened.size > UPLOAD_BYTES) throw denied();
    const bytes = Buffer.alloc(opened.size + 1);
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
      if (offset !== opened.size) throw denied();
      const root = join(data, 'uploads');
      await mkdir(root, { recursive: true, mode: 0o700 });
      const temporary = await mkdtemp(join(root, 'file-'));
      const path = join(temporary, basename(canonical));
      const clean = async () => { await unlink(path).catch(() => undefined); await rmdir(temporary).catch(() => undefined); };
      try { await writeFile(path, bytes.subarray(0, offset), { flag: 'wx', mode: 0o600 }); }
      catch (error) { await clean(); throw error; }
      return { path, clean };
    } finally { bytes.fill(0); }
  } finally { await handle.close(); }
}
