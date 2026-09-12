/**
 * A passkey MyVault holds on the user's behalf.
 *
 * **This record is immutable after creation, and that is a load-bearing
 * property rather than a convention.**
 *
 * `src/sync/mergeVaults.ts` merges timestamp-less arrays by union with local
 * winning any id collision, because there is nothing to compare. That rule is
 * only safe for records that never change — and it is the rule this array uses.
 * So nothing here may become mutable without giving the record a timestamp and
 * changing the merge, which is a schema change. In particular there is
 * deliberately no `lastUsedAt`: it would mean a vault write on every sign-in,
 * which is exactly the operation that manufactures sync conflicts.
 *
 * The same reasoning is why the signature counter is not stored. It is always
 * zero. See `authenticator.ts`.
 *
 * Everything here rides inside `VaultPayload`, which means inside the AES-256-GCM
 * `payload` field of the envelope. The Worker never sees any of it.
 */
export interface PasskeyCredential {
  /** Base64url credential ID. 32 random bytes, and the array's merge key. */
  id: string;
  /**
   * The validated RP ID this credential belongs to. An assertion hashes *this*
   * into its authenticator data, never the RP ID a page asked for, so a
   * credential can only ever sign for the site it was created under.
   */
  rpId: string;
  /** The relying party's own name, for the approval prompt. Display only. */
  rpName: string;
  /**
   * The full origin the credential was registered from, kept for the audit trail
   * the user sees. Never used as an authorization input — `rpId` is.
   */
  createdAtOrigin: string;
  /** Base64url user handle (`user.id`), returned on an assertion. */
  userHandle: string;
  /** The account name the site displays, so a picker can show something real. */
  userName: string;
  userDisplayName: string;
  /** COSE algorithm identifier. Always -7 (ES256) in this version. */
  algorithm: number;
  /**
   * The private key, PKCS#8, base64.
   *
   * The one piece of key material in MyVault that its own code can read while
   * unlocked — everywhere else a key is a non-extractable `CryptoKey`. It cannot
   * be otherwise: a key the browser will not export cannot travel to the user's
   * other machine, which is the whole feature. Recorded in the threat model.
   */
  privateKeyPkcs8: string;
  /** The public half, SPKI, base64. Stored so a key can be re-derived for display. */
  publicKeySpki: string;
  createdAt: string;
}
/** Whether a stored record is well-formed enough to sign with. */
export function isPasskeyCredential(value: unknown): value is PasskeyCredential {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<PasskeyCredential>;
  return (
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    typeof record.rpId === 'string' &&
    record.rpId.length > 0 &&
    typeof record.userHandle === 'string' &&
    typeof record.privateKeyPkcs8 === 'string' &&
    record.privateKeyPkcs8.length > 0 &&
    typeof record.algorithm === 'number'
  );
}
