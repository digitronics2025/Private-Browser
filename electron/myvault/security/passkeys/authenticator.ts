import { cborBytes, cborInt, cborMap, cborText, concatBytes } from './cbor.js';
import type { PasskeyCredential } from './types.js';
import { asBufferSource } from '../vault-crypto.js';

export const COSE_ALG_ES256 = -7;
const encoder = new TextEncoder();

export function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}
export function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

export function coseKeyFromRawPublicKey(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('ES256 public key must be uncompressed P-256');
  return cborMap([
    [cborInt(1), cborInt(2)], [cborInt(3), cborInt(COSE_ALG_ES256)], [cborInt(-1), cborInt(1)],
    [cborInt(-2), cborBytes(raw.subarray(1, 33))], [cborInt(-3), cborBytes(raw.subarray(33, 65))],
  ]);
}

async function digest(value: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', asBufferSource(value)));
}

export function clientDataJson(type: 'webauthn.create' | 'webauthn.get', challenge: Uint8Array, origin: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify({ type, challenge: base64UrlEncode(challenge), origin, crossOrigin: false }));
}

export async function authenticatorData(rpId: string, userVerified: boolean, attested?: { credentialId: Uint8Array; coseKey: Uint8Array }): Promise<Uint8Array<ArrayBuffer>> {
  const rpIdHash = await digest(encoder.encode(rpId));
  const flags = 0x01 | (userVerified ? 0x04 : 0) | (attested ? 0x40 : 0);
  const base = concatBytes([rpIdHash, Uint8Array.of(flags), new Uint8Array(4)]);
  if (!attested) return base;
  if (attested.credentialId.length > 1024) throw new Error('Credential id is too large');
  const length = Uint8Array.of(attested.credentialId.length >>> 8, attested.credentialId.length & 0xff);
  return concatBytes([base, new Uint8Array(16), length, attested.credentialId, attested.coseKey]);
}

export async function createCredential(input: { rpId: string; rpName: string; origin: string; challenge: Uint8Array; userHandle: Uint8Array; userName: string; userDisplayName: string }) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  if (!jwk.x || !jwk.y) throw new Error('ES256 public key export failed');
  const raw = concatBytes([Uint8Array.of(4), base64UrlDecode(jwk.x), base64UrlDecode(jwk.y)]);
  const credentialId = crypto.getRandomValues(new Uint8Array(32));
  const authData = await authenticatorData(input.rpId, true, { credentialId, coseKey: coseKeyFromRawPublicKey(raw) });
  const client = clientDataJson('webauthn.create', input.challenge, input.origin);
  const privateKeyPkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
  const publicKeySpki = new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey));
  const record: PasskeyCredential = {
    id: base64UrlEncode(credentialId), rpId: input.rpId, rpName: input.rpName, createdAtOrigin: input.origin,
    userHandle: base64UrlEncode(input.userHandle), userName: input.userName, userDisplayName: input.userDisplayName,
    algorithm: COSE_ALG_ES256, privateKeyPkcs8: Buffer.from(privateKeyPkcs8).toString('base64'), publicKeySpki: Buffer.from(publicKeySpki).toString('base64'), createdAt: new Date().toISOString(),
  };
  return { record, clientDataJson: client, authenticatorData: authData, attestationObject: cborMap([[cborText('fmt'), cborText('none')], [cborText('attStmt'), cborMap([])], [cborText('authData'), cborBytes(authData)]]) };
}

export async function signAssertion(record: PasskeyCredential, challenge: Uint8Array, origin: string) {
  const privateKey = await crypto.subtle.importKey('pkcs8', Buffer.from(record.privateKeyPkcs8, 'base64'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const client = clientDataJson('webauthn.get', challenge, origin);
  const authData = await authenticatorData(record.rpId, true);
  const signatureBase = concatBytes([authData, await digest(client)]);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, signatureBase));
  return { clientDataJson: client, authenticatorData: authData, signature, userHandle: base64UrlDecode(record.userHandle) };
}
