import { randomBytes, scrypt } from 'node:crypto';
import { open } from 'node:fs/promises';
import { decryptBackupEnvelope, encryptBackupPayload, type AccountBackupPayload, type EncryptedBackupEnvelope } from './account-backup.js';

const format = 'private-browser-portable-browsing-v1';
const maxArchiveBytes = 12 * 1024 * 1024;
const maxPayloadBytes = 8 * 1024 * 1024;

export function deriveRecoveryKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  if (passphrase.length < 16 || passphrase.length > 1_024) throw new Error('Use a recovery passphrase of at least 16 characters.');
  const text = Buffer.from(passphrase, 'utf8');
  return new Promise((resolve, reject) => {
    scrypt(text, salt, 32, { N: 65_536, r: 8, p: 1, maxmem: 96 * 1024 * 1024 }, (error, key) => {
      text.fill(0);
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function sealBrowsingArchive(payload: AccountBackupPayload, passphrase: string): Promise<Buffer> {
  if (Buffer.byteLength(JSON.stringify(payload)) > maxPayloadBytes) throw new Error('This Account Space exceeds the recovery archive size limit.');
  const salt = randomBytes(32);
  const key = await deriveRecoveryKey(passphrase, salt);
  try {
    const bytes = Buffer.from(JSON.stringify({ format, salt: salt.toString('base64url'), body: encryptBackupPayload(payload, key) }), 'utf8');
    if (bytes.length > maxArchiveBytes) throw new Error('This Account Space exceeds the recovery archive size limit.');
    return bytes;
  } finally { key.fill(0); }
}

export async function unsealBrowsingArchive(path: string, passphrase: string): Promise<AccountBackupPayload> {
  const handle = await open(path, 'r');
  let archive: { format?: unknown; salt?: unknown; body?: EncryptedBackupEnvelope };
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > maxArchiveBytes) throw new Error('This recovery archive has an invalid size.');
    const bytes = Buffer.alloc(info.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== info.size) throw new Error('The recovery archive changed while opening it.');
    try { archive = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')); }
    catch { throw new Error('This recovery archive is not readable.'); }
  } finally { await handle.close(); }
  if (archive?.format !== format || typeof archive.salt !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(archive.salt) || !archive.body) {
    throw new Error('This file is not a Private Browser recovery archive.');
  }
  const key = await deriveRecoveryKey(passphrase, Buffer.from(archive.salt, 'base64url'));
  try { return decryptBackupEnvelope(archive.body, key); }
  catch { throw new Error('The recovery passphrase is incorrect or the file has changed.'); }
  finally { key.fill(0); }
}
