const SEARCH_ENDPOINT = 'https://duckduckgo.com/?q=';

const TRACKING_PARAMETERS = new Set([
  'dclid', 'fbclid', 'gclid', 'gbraid', 'mc_cid', 'mc_eid', 'msclkid',
  'twclid', 'wbraid', '_hsenc', '_hsmi', 'vero_conv', 'vero_id',
]);

export function normalizeNavigationInput(value: string): string {
  const input = value.trim();
  if (!input) return 'private://home';
  if (input === 'private://home') return input;

  let parsed: URL | undefined;
  try {
    parsed = new URL(input);
  } catch {
    // Continue to host/search detection.
  }
  if (parsed) {
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      if (parsed.username || parsed.password) throw new Error('URLs containing credentials are not allowed');
      return stripTrackingParameters(parsed.toString());
    }
  }

  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/.*)?$/i.test(input)) {
    return `http://${input}`;
  }
  if (/^[\w.-]+\.[a-z]{2,}(?::\d+)?(?:\/.*)?$/i.test(input)) {
    return new URL(`https://${input}`).toString();
  }
  return `${SEARCH_ENDPOINT}${encodeURIComponent(input)}`;
}

/** Remove common cross-site campaign identifiers before a URL is loaded or saved. */
export function stripTrackingParameters(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return value;
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_') || TRACKING_PARAMETERS.has(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }
    return url.toString();
  } catch {
    return value;
  }
}

/** Surface look-alike internationalised domains without blocking legitimate IDNs. */
export function navigationWarning(value: string): 'insecure' | 'idn' | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' && !isLocalDevelopmentHost(url.hostname)) return 'insecure';
    if (url.hostname.split('.').some((label) => label.startsWith('xn--'))) return 'idn';
    return undefined;
  } catch {
    return 'insecure';
  }
}

export function isAllowedSitePermission(permission: string, requestingUrl: string, protectedWorkspace: boolean, isMainFrame: boolean): boolean {
  if (protectedWorkspace || !isMainFrame) return false;
  try {
    const url = new URL(requestingUrl);
    const trustworthy = url.protocol === 'https:' || (url.protocol === 'http:' && isLocalDevelopmentHost(url.hostname));
    return trustworthy && (permission === 'fullscreen' || permission === 'clipboard-sanitized-write');
  } catch {
    return false;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Keep the HTTP User-Agent aligned with Chromium's User-Agent Client Hints.
 * Electron inserts both its own product token and the packaged application
 * name. Leaving either token behind makes the legacy UA disagree with
 * `navigator.userAgentData`, which breaks strict browser-integrity checks.
 */
export function browserCompatibleUserAgent(userAgent: string, applicationNames: readonly string[]): string {
  let result = userAgent.replace(/(^|\s)Electron\/\S+/gi, '$1');
  for (const applicationName of applicationNames) {
    const name = applicationName.trim();
    if (!name) continue;
    const flexibleName = name.split(/[\s_-]+/).map(escapeRegExp).join('[\\s_-]+');
    result = result.replace(new RegExp(`(^|\\s)${flexibleName}\\/\\S+`, 'gi'), '$1');
  }
  return result.replace(/\s+/g, ' ').trim();
}

export function downloadRisk(filename: string): 'ordinary' | 'dangerous' | 'deceptive' {
  const parts = filename.toLowerCase().trim().split('.').filter(Boolean);
  if (parts.length < 2) return 'ordinary';
  const dangerous = new Set(['bat', 'chm', 'cmd', 'com', 'cpl', 'exe', 'hta', 'img', 'iso', 'jar', 'js', 'jse', 'lnk', 'msi', 'msp', 'pif', 'ps1', 'reg', 'scr', 'vbs', 'vbe', 'wsf']);
  const last = parts.at(-1)!;
  if (!dangerous.has(last)) return 'ordinary';
  const disguise = new Set(['doc', 'docx', 'gif', 'jpeg', 'jpg', 'pdf', 'png', 'ppt', 'pptx', 'txt', 'xls', 'xlsx', 'zip']);
  return parts.length >= 3 && disguise.has(parts.at(-2)!) ? 'deceptive' : 'dangerous';
}

function isLocalDevelopmentHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

export function isAllowedRemoteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

const SENSITIVE_PATTERNS: RegExp[] = [
  /\b(?:authorization\s*[:=]\s*)?bearer\s+[^\s,;]+/gi,
  /\b(?:\d[ -]*?){13,19}\b/g,
  /\bauthorization\s*[:=]\s*[^\s,;]+/gi,
  /\b(?:password|passwd|pwd|secret|api[_ -]?key|token)\s*[:=]\s*[^\s,;]+/gi,
  /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g,
  /\b[A-Z2-7]{24,}\b/g,
];

export function redactSensitiveText(value: string): { text: string; redactions: number } {
  let text = value;
  let redactions = 0;
  for (const pattern of SENSITIVE_PATTERNS) {
    text = text.replace(pattern, () => {
      redactions += 1;
      return '[REDACTED]';
    });
  }
  return { text, redactions };
}

/**
 * Distinctive enough to match anywhere in a hostname without catching ordinary
 * words — `cfgbank.com`, `attijariwafabank.com`, `sgmaroc.com`.
 */
const PROTECTED_HOST_FRAGMENTS = [
  'bank', 'banque', 'bancaire', 'bankofafrica', 'creditagricole', 'creditdumaroc',
  'attijari', 'wafacash', 'wafasalaf', 'cihbank', 'bmce', 'bmci', 'sgmaroc',
  'chaabi', 'baridbank', 'cashplus', 'paypal', 'revolut', 'mastercard', 'visa-',
];

/**
 * Too short or too common for a substring match — `credit` would otherwise hit
 * `credits.example.com` and `wise` would hit `otherwise.org`. These must be a
 * whole dot- or hyphen-separated label.
 */
const PROTECTED_HOST_LABELS = new Set([
  'credit', 'caisse', 'wise', 'stripe', 'cih', 'cdm', 'barid', 'pay', 'payments', 'billing',
]);

const PROTECTED_PATH_FRAGMENTS = /(banking|checkout|payment|paiement|wallet|billing|invoice|virement|transfer|carte-bancaire)/i;

/**
 * Whether a page is treated as too sensitive to extract text from.
 *
 * This is **best effort and deliberately over-inclusive**: a false positive only
 * refuses an AI read, while a false negative would let a banking page's text be
 * offered for upload. It cannot be complete — no keyword list covers every bank
 * in the world — so the guarantee the product actually rests on is the Banking
 * workspace, which is protected by configuration rather than by guesswork.
 */
export function isProtectedPage(urlValue: string): boolean {
  try {
    const { hostname, pathname } = new URL(urlValue);
    const host = hostname.toLowerCase();
    if (PROTECTED_HOST_FRAGMENTS.some((fragment) => host.includes(fragment))) return true;
    if (host.split(/[.-]/).some((label) => PROTECTED_HOST_LABELS.has(label))) return true;
    return PROTECTED_PATH_FRAGMENTS.test(`${host}${pathname}`);
  } catch {
    return false;
  }
}

/**
 * Whether a saved credential may be filled into the page currently open.
 *
 * Hostname and port must match exactly — no subdomain or suffix matching. The
 * scheme is checked separately and asymmetrically: filling an `https` page is
 * always allowed, because that is the same or better protection than the
 * credential was saved under, but a credential saved for `https` is never filled
 * into `http`. Without that rule a password saved for a real site could be typed
 * into a plaintext page of the same name on a hostile network.
 */
export function isAutofillTarget(credentialUrl: string, pageUrl: string): boolean {
  try {
    const credential = new URL(credentialUrl);
    const page = new URL(pageUrl);
    if (!isAllowedRemoteUrl(credentialUrl) || !isAllowedRemoteUrl(pageUrl)) return false;
    if (credential.hostname !== page.hostname || credential.port !== page.port) return false;
    if (page.protocol === 'https:') return true;
    return credential.protocol === page.protocol;
  } catch {
    return false;
  }
}

export function urlOriginForSharing(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

export function isSafeAiEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    // '::' is the all-zeros address and '::ffff:127.0.0.1' the IPv4-mapped form of
    // loopback; a trailing dot is the fully-qualified spelling of a hostname.
    const bare = host.replace(/\.$/, '');
    if (bare === 'localhost' || bare === '0.0.0.0' || bare === '::1' || bare === '::' || bare.endsWith('.local')) return false;
    if (/^::ffff:/i.test(bare)) return false;
    if (/^127\./.test(bare) || /^10\./.test(bare) || /^192\.168\./.test(bare) || /^169\.254\./.test(bare)) return false;
    if (/^(fc|fd|fe8|fe9|fea|feb)[0-9a-f]*:/i.test(bare)) return false;
    const match = bare.match(/^172\.(\d{1,3})\./);
    if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return false;
    return true;
  } catch {
    return false;
  }
}

export function isSafeUpdateEndpoint(value: string): boolean {
  if (!isSafeAiEndpoint(value)) return false;
  try {
    const url = new URL(value);
    return (url.pathname === '' || url.pathname === '/') && !url.search && !url.hash;
  } catch {
    return false;
  }
}
