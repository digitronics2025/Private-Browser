import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

async function measure(path) {
  const sizeBytes = statSync(path).size;
  const hash = createHash('sha256');
  let streamed = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    streamed += chunk.length;
  }
  if (!sizeBytes || streamed !== sizeBytes) throw new Error('Installer size changed while reading the file');
  return { sizeBytes, sha256: hash.digest('hex') };
}

export async function verifyReleaseCandidate(installer, stagedFile) {
  const filename = basename(installer);
  const sums = readFileSync(join(dirname(installer), 'SHA256SUMS.txt'), 'utf8').replace(/^\uFEFF/, '').trim();
  const match = /^([a-fA-F0-9]{64})[ \t]+([^\r\n]+)$/.exec(sums);
  if (!match || match[2] !== filename) throw new Error('The Windows build checksum does not name this installer');
  const expected = await measure(installer);
  if (expected.sha256 !== match[1].toLowerCase()) throw new Error('Installer does not match the Windows build checksum');
  if (stagedFile) {
    const staged = await measure(stagedFile);
    if (staged.sizeBytes !== expected.sizeBytes || staged.sha256 !== expected.sha256) {
      throw new Error('The private R2 candidate differs from the verified Windows installer');
    }
  }
  return { filename, ...expected };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [installer, staged] = process.argv.slice(2);
  if (!installer) throw new Error('Pass the Windows installer and optional private candidate copy');
  process.stdout.write(JSON.stringify(await verifyReleaseCandidate(installer, staged)) + '\n');
}
