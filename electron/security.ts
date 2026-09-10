const SEARCH_ENDPOINT = 'https://duckduckgo.com/?q=';

export function normalizeNavigationInput(value: string): string {
  const input = value.trim();
  if (!input) return 'private://home';
  if (input === 'private://home') return input;

  try {
    const parsed = new URL(input);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
  } catch {
    // Continue to host/search detection.
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
    return url.protocol === 'https:' || url.protocol === 'http:';
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
      /(banking|checkout|payment|wallet)/i.test(`${hostname}${pathname}`);
  } catch {
    return false;
  }
}
