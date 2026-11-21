import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

if (process.platform !== 'win32') throw new Error('Stage the Windows Agent CLI on the Windows build runner.');
const destination = 'build/private-browser-agent';
await mkdir(destination, { recursive: true });
await build({
  entryPoints: ['packages/agent-mcp/dist/cli.js'],
  outfile: join(destination, 'cli.cjs'),
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  bundle: true,
});
await copyFile(process.execPath, join(destination, 'node.exe'));
const nodeLicense = await readFile(join(dirname(process.execPath), 'LICENSE'), 'utf8').catch(async () => {
  const license = await fetch(`https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`, {
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (!license.ok) throw new Error('Could not obtain the Node.js runtime license.');
  return license.text();
});
if (nodeLicense.length < 1_000 || !nodeLicense.includes('Node.js')) throw new Error('The Node.js runtime license is invalid.');
await writeFile(join(destination, 'LICENSE.node.txt'), nodeLicense);
await writeFile(join(destination, 'private-browser-mcp.cmd'),
  '@echo off\r\nsetlocal\r\nset "NODE_OPTIONS="\r\n"%~dp0node.exe" "%~dp0cli.cjs" %*\r\nexit /b %errorlevel%\r\n');
