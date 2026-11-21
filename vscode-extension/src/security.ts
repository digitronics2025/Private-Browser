import { createHash } from 'node:crypto';
export { isSecretPath, resolveInsideWorkspace } from '@private-browser/bridge-protocol/workspace-path';

const SENSITIVE_OUTPUT = [
  /\b(?:authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]+/gi,
  /\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*['"]?[^\s'";,]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
];

export function sanitizeOutput(value: string, limit = 1024 * 1024): string {
  let clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  for (const pattern of SENSITIVE_OUTPUT) clean = clean.replace(pattern, (match) => `${match.split(/[:=\s]/, 1)[0]}=[REDACTED]`);
  if (Buffer.byteLength(clean) <= limit) return clean;
  const half = Math.floor(limit / 2);
  return `${clean.slice(0, half)}\n… [output truncated] …\n${clean.slice(-half)}`;
}

export function stableFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function safeLiveOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('Live testing requires HTTPS');
  if (url.username || url.password) throw new Error('Credentials in URLs are blocked');
  if (/(?:bank|banque|payment|checkout|billing|paypal|stripe)/i.test(`${url.hostname}${url.pathname}`)) throw new Error('Banking, payment, and checkout targets are blocked');
  return url.origin;
}
