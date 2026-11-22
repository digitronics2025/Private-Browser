import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { open, writeFile } from 'node:fs/promises';
import { requireWorkspaceId } from './account-space-validation.js';
import { deriveRecoveryKey } from './browsing-recovery.js';
import type { BookmarkPairing } from './bookmark-sync.js';
import { isDriveFileId } from './google-backup-transport.js';

const format = 'private-browser-bookmark-pairing-v1';

export async function writeBookmarkPairing(path: string, pairing: BookmarkPairing, passphrase: string, current: () => void): Promise<void> {
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const key = await deriveRecoveryKey(passphrase, salt);
  const clear = Buffer.from(JSON.stringify(pairing));
  try {
    current();
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(format));
    const ciphertext = Buffer.concat([cipher.update(clear), cipher.final()]);
    const packed = { format, salt: salt.toString('base64url'), iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
    try { await writeFile(path, JSON.stringify(packed), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Choose a new name to preserve the existing pairing file.');
      throw new Error('The encrypted pairing file could not be saved.');
    }
  } finally { key.fill(0); clear.fill(0); }
}

export async function readBookmarkPairing(path: string, passphrase: string): Promise<BookmarkPairing> {
  let raw: Buffer;
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > 8192) throw new Error('Invalid bookmark pairing file.');
    raw = Buffer.alloc(info.size + 1);
    const { bytesRead } = await handle.read(raw, 0, raw.length, 0);
    if (bytesRead !== info.size) throw new Error('The pairing file changed while opening it.');
    raw = raw.subarray(0, bytesRead);
  } finally { await handle.close(); }
  try {
    const packed = JSON.parse(raw.toString('utf8')) as { format: string; salt: string; iv: string; ciphertext: string; tag: string };
    if (packed.format !== format) throw new Error('Invalid format');
    const salt = Buffer.from(packed.salt, 'base64url');
    const iv = Buffer.from(packed.iv, 'base64url');
    const tag = Buffer.from(packed.tag, 'base64url');
    if (salt.length !== 32 || iv.length !== 12 || tag.length !== 16) throw new Error('Invalid envelope');
    const key = await deriveRecoveryKey(passphrase, salt);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(Buffer.from(format));
      decipher.setAuthTag(tag);
      const pending = decipher.update(Buffer.from(packed.ciphertext, 'base64url'));
      try {
        const clear = Buffer.concat([pending, decipher.final()]);
        try {
          const pair = JSON.parse(clear.toString('utf8')) as BookmarkPairing;
          if (!isDriveFileId(pair.fileId) || !/^[A-Za-z0-9_-]{43}$/.test(pair.key)) throw new Error('Invalid pairing');
          return { fileId: pair.fileId, key: pair.key, workspaceId: requireWorkspaceId(pair.workspaceId) };
        } finally { clear.fill(0); }
      } finally { pending.fill(0); }
    } finally { key.fill(0); }
  } catch { throw new Error('The pairing file or its passphrase could not be verified.'); }
}
