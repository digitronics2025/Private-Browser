import { copyFile, mkdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const yauzl = require('yauzl');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extensionPkg = require(join(root, 'vscode-extension', 'package.json'));
const source = join(root, 'build', 'private-browser-bridge.vsix');
const target = join(root, 'release', `private-browser-bridge-${extensionPkg.version}.vsix`);

async function entries(path) {
  return await new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error ?? new Error('Unable to open VSIX'));
      const names = [];
      zip.on('entry', (entry) => { names.push(entry.fileName); zip.readEntry(); });
      zip.once('error', reject);
      zip.once('end', () => resolve(names));
      zip.readEntry();
    });
  });
}

const size = (await stat(source)).size;
if (size <= 0 || size > 10 * 1024 * 1024) throw new Error(`VSIX size is invalid: ${size}`);
const names = await entries(source);
for (const required of ['extension/package.json', 'extension/dist/extension.cjs', 'extension/dist/playwright-runner.cjs', 'extension/readme.md']) {
  if (!names.includes(required)) throw new Error(`VSIX is missing ${required}`);
}
const forbidden = names.find((name) => /(?:^|\/)(?:src|node_modules)(?:\/|$)|\.map$|(?:^|\/)\.env(?:\.|$)/i.test(name));
if (forbidden) throw new Error(`VSIX contains forbidden entry: ${forbidden}`);

if (!process.argv.includes('--validate-only')) {
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  process.stdout.write(`${target}\n`);
} else {
  process.stdout.write(`Validated ${names.length} VSIX entries (${size} bytes).\n`);
}
