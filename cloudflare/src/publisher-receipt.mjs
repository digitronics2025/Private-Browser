export const MAX_PUBLISHER_RECEIPT_BYTES = 4096;

export function parsePublisherReceipt(value, sha256) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(sha256) || value.sha256 !== sha256) return undefined;
  if (value.status === 'unsigned') return { status: 'unsigned' };
  const name = typeof value.publisher === 'string' ? value.publisher.trim() : '';
  if (value.status !== 'verified' || !name || name.length > 160 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(name)) return undefined;
  const signerSha256 = typeof value.signerSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.signerSha256) && value.timestamped === true
    ? value.signerSha256 : undefined;
  return { status: 'verified', name, ...(signerSha256 ? { signerSha256 } : {}) };
}
