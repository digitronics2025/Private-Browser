import { createHmac } from 'node:crypto';

function decodeBase32(value: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = value.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const char of cleaned) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error('Invalid authenticator secret');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
}

export function generateTotp(secret: string, epochSeconds = Math.floor(Date.now() / 1000)): string {
  const counter = Math.floor(epochSeconds / 30);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', decodeBase32(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, '0');
}
