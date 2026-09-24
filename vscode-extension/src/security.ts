import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const SECRET_NAME = /(^|[\\/])(?:\.env(?:\..*)?|credentials?(?:\.json)?|secrets?(?:\.json)?|id_(?:rsa|dsa|ecdsa|ed25519)|\.npmrc|\.netrc|_netrc|\.git-credentials|\.pypirc|\.dockercfg|[^\\/]*\.(?:pem|key|p12|pfx|jks|keystore)|private\.key)(?:$|[\\/])/i;
const PROFILE_NAME = /(^|[\\/])(?:User Data|Browser|Chrome|Edge|Firefox|Profiles?|Cookies|Login Data)(?:$|[\\/])/i;
const SENSITIVE_OUTPUT = [
  /\b(?:authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]+/gi,
  /\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*['"]?[^\s'";,]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
];

/**
 * Windows opens "name.env:stream", "name.env." and "name.env " as the same file
 * as "name.env", so every path segment is judged in that normalised form.
 */
function windowsNormalised(value: string): string {
  return value.replaceAll('/', sep).split(/[\\/]/)
    .map((segment, index) => (index === 0 && /^[A-Za-z]:$/.test(segment) ? segment : segment.replace(/:.*$/, '').replace(/[. ]+$/, '')))
    .join(sep);
}

export function isSecretPath(value: string): boolean {
  const normalised = windowsNormalised(value);
  return SECRET_NAME.test(normalised) || PROFILE_NAME.test(normalised);
}

export async function resolveInsideWorkspace(rootValue: string, targetValue: string, allowCreate = false): Promise<string> {
  if (!rootValue || !targetValue || targetValue.includes('\0')) throw new Error('Malformed workspace path');
  if (targetValue.startsWith('\\\\')) throw new Error('UNC paths are not supported');
  const root = await realpath(rootValue);
  const candidate = isAbsolute(targetValue) ? resolve(targetValue) : resolve(root, targetValue);
  if (isSecretPath(candidate)) throw new Error('Secret and browser-profile files are blocked');
  const lexical = relative(root, candidate);
  if (lexical === '..' || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) throw new Error('Path escapes the approved workspace');
  let canonical: string | undefined;
  try { canonical = await realpath(candidate); }
  catch (error) {
    if (!allowCreate) throw error;
    let ancestor = dirname(candidate);
    while (ancestor !== dirname(ancestor)) {
      try {
        const canonicalAncestor = await realpath(ancestor);
        canonical = resolve(canonicalAncestor, relative(ancestor, candidate));
        break;
      } catch { ancestor = dirname(ancestor); }
    }
    if (!canonical) throw new Error('No existing workspace ancestor was found');
  }
  if (!canonical) throw new Error('Unable to resolve workspace path');
  // The typed path was checked above; the file it really resolves to (through a
  // link, a junction or an 8.3 short name) must pass the same rule (F-73).
  if (isSecretPath(canonical)) throw new Error('Secret and browser-profile files are blocked');
  const rel = relative(root, canonical);
  if (!rel || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) {
    if ((await stat(root)).isDirectory()) return canonical;
  }
  throw new Error('Path escapes the approved workspace');
}

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
