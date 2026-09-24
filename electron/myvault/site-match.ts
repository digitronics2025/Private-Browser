import { getDomain } from 'tldts';
import { isAllowedRemoteUrl, isAutofillTarget } from '../security.js';

// Main-process only: tldts carries the whole Public Suffix List, and
// electron/security.ts is also bundled into the renderer's preview API.

/**
 * The site a host belongs to, as Chrome groups saved passwords: its registrable
 * domain per the Public Suffix List (`admin.digitronics.ma` -> `digitronics.ma`,
 * but `a.co.ma` stays apart from `b.co.ma`). Undefined for IP addresses, hosts
 * with no public suffix (`localhost`) and punycode, which only ever match exactly.
 */
export function registrableSite(hostname: string): string | undefined {
  const host = hostname.toLowerCase();
  if (!host || host.includes('xn--') || host.startsWith('[') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return undefined;
  return getDomain(host, { allowPrivateDomains: true }) ?? undefined;
}

/**
 * Whether a saved credential may be OFFERED in the login picker on this page:
 * the exact origin, or another address of the same site (same registrable
 * domain, same effective port). The scheme rule is `isAutofillTarget`'s: never an
 * https credential into an http page. Automatic fill and the side panel's Fill do
 * not use this; they stay exact-origin via `isAutofillTarget`.
 */
export function isSameSiteFillCandidate(credentialUrl: string, pageUrl: string): boolean {
  if (isAutofillTarget(credentialUrl, pageUrl)) return true;
  try {
    const credential = new URL(credentialUrl);
    const page = new URL(pageUrl);
    if (!isAllowedRemoteUrl(credentialUrl) || !isAllowedRemoteUrl(pageUrl)) return false;
    if (page.protocol !== 'https:' && credential.protocol !== page.protocol) return false;
    const effectivePort = (url: URL) => url.port || (url.protocol === 'https:' ? '443' : '80');
    if (effectivePort(credential) !== effectivePort(page)) return false;
    const credentialSite = registrableSite(credential.hostname);
    return Boolean(credentialSite) && credentialSite === registrableSite(page.hostname);
  } catch {
    return false;
  }
}
