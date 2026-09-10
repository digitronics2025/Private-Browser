const SEARCH_ENDPOINT = 'https://duckduckgo.com/?q=';

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
      return parsed.toString();
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

export function isProtectedPage(urlValue: string): boolean {
  try {
    const { hostname, pathname } = new URL(urlValue);
    return /(^|\.)(bank|paypal|wise|revolut)\./i.test(hostname) ||
      /(banking|checkout|payment|wallet|attijari|wafacash|cihbank|bankofafrica|bmce|chaabi|baridbank|cashplus)/i.test(`${hostname}${pathname}`);
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
    if (host === 'localhost' || host === '0.0.0.0' || host === '::1' || host.endsWith('.local')) return false;
    if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return false;
    if (/^(fc|fd|fe8|fe9|fea|feb)[0-9a-f]*:/i.test(host)) return false;
    const match = host.match(/^172\.(\d{1,3})\./);
    if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return false;
    return true;
  } catch {
    return false;
  }
}
