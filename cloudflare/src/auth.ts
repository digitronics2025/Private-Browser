const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

export async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([sha256(left), sha256(right)]);
  let mismatch = 0;
  for (let index = 0; index < leftDigest.length; index += 1) mismatch |= leftDigest[index] ^ rightDigest[index];
  return mismatch === 0;
}

export async function signValue(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))));
}

export async function verifySignedValue(secret: string, value: string, signature: string): Promise<boolean> {
  if (!signature || signature.length > 100) return false;
  return constantTimeEqual(await signValue(secret, value), signature);
}

export function futureExpiry(nowSeconds: number, ttlSeconds: number): number {
  return Math.floor(nowSeconds) + ttlSeconds;
}

export function isLiveExpiry(value: string | null, nowSeconds: number): value is string {
  if (!value || !/^\d{10}$/.test(value)) return false;
  const expires = Number(value);
  return Number.isSafeInteger(expires) && expires > Math.floor(nowSeconds) && expires <= Math.floor(nowSeconds) + 24 * 60 * 60;
}
