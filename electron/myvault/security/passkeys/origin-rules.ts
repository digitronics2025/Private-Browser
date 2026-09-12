export interface PasskeyContext { origin: string; topOrigin: string; frameId: string; isMainFrame: boolean; rpId?: string }
export type PasskeyOriginVerdict = { allowed: true; origin: string; rpId: string } | { allowed: false; reason: string };

export function validatePasskeyOrigin(context: PasskeyContext): PasskeyOriginVerdict {
  if (!context.origin) return { allowed: false, reason: 'no-origin' };
  if (context.origin === 'null') return { allowed: false, reason: 'opaque-origin' };
  if (!context.isMainFrame || context.frameId !== 'main' || context.origin !== context.topOrigin) return { allowed: false, reason: 'cross-origin-frame' };
  let url: URL;
  try { url = new URL(context.origin); } catch { return { allowed: false, reason: 'invalid-origin' }; }
  const localhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(localhost && url.protocol === 'http:')) return { allowed: false, reason: 'insecure-origin' };
  const rpId = (context.rpId ?? url.hostname).toLocaleLowerCase('en-US').replace(/\.$/, '');
  // Electron exposes no stable live PSL oracle. Exact host is the fail-closed subset;
  // parent-domain RP IDs keep the provider gate disabled until a PSL-backed test exists.
  if (rpId !== url.hostname.toLocaleLowerCase('en-US')) return { allowed: false, reason: 'rp-id-needs-psl' };
  return { allowed: true, origin: url.origin, rpId };
}
