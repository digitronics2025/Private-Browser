import { randomUUID } from 'node:crypto';

export interface WordPressLoginFlow {
  kind: 'signin' | 'password-change';
  origin: string;
  prefix: string;
  formPath: string;
}

export const MAX_WORDPRESS_SAVE_ORIGINS = 100;

export function wordPressSaveOrigins(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const origins = new Set<string>();
  for (const item of value.slice(0, MAX_WORDPRESS_SAVE_ORIGINS)) {
    if (typeof item !== 'string' || item.length > 512) continue;
    try {
      const url = new URL(item);
      if (url.protocol === 'https:' && url.origin === item) origins.add(item);
    } catch { /* Skip an invalid stored preference. */ }
  }
  return origins.size ? [...origins] : undefined;
}

export function wordPressLoginFlow(url: string): WordPressLoginFlow | undefined {
  try {
    const value = new URL(url);
    if (value.protocol !== 'https:' || value.username || value.password || value.hash) return undefined;
    const signIn = /^(\/(?:[\w-]+\/)*)wp-login\.php$/.exec(value.pathname);
    if (signIn && [...value.searchParams].every(([key, setting]) => key === 'action' && setting === 'login')) {
      return { kind: 'signin', origin: value.origin, prefix: signIn[1], formPath: value.pathname };
    }
    const profile = /^(\/(?:[\w-]+\/)*)wp-admin\/profile\.php$/.exec(value.pathname);
    if (profile && [...value.searchParams].every(([key, setting]) => key === 'updated' && (setting === 'true' || setting === '1'))) {
      return { kind: 'password-change', origin: value.origin, prefix: profile[1], formPath: value.pathname };
    }
  } catch { /* Unsupported page address. */ }
  return undefined;
}

type ResponseProof = { url: string; method: string; statusCode: number; responseHeaders?: Record<string, string[]> };

function freshAuthCookie(header: string, hostname: string): 'signed-in' | 'secure-auth' | undefined {
  const match = /^(wordpress_(logged_in|sec)_[a-f0-9]{32})=[^;]+;(.*)$/i.exec(header);
  if (!match) return undefined;
  const attributes = match[3].split(';').map((value) => value.trim().toLowerCase());
  if (!attributes.includes('secure') || !attributes.includes('httponly')) return undefined;
  const maxAge = attributes.find((value) => value.startsWith('max-age='));
  const expires = attributes.find((value) => value.startsWith('expires='));
  const domain = attributes.find((value) => value.startsWith('domain='));
  if ((maxAge && Number(maxAge.slice(8)) <= 0) || (expires && Date.parse(expires.slice(8)) <= Date.now())
    || (domain && domain.slice(7).replace(/^\./, '') !== hostname)) return undefined;
  return match[2].toLowerCase() === 'logged_in' ? 'signed-in' : 'secure-auth';
}

/** Accept only the server's successful classic form redirect and fresh secure WordPress session cookies. */
export function verifiedWordPressRedirect(flow: WordPressLoginFlow, details: ResponseProof): string | undefined {
  if (details.method !== 'POST' || ![302, 303].includes(details.statusCode)) return undefined;
  try {
    const source = new URL(details.url);
    if (source.origin !== flow.origin || source.pathname !== flow.formPath || source.username || source.password) return undefined;
    const headers = Object.fromEntries(Object.entries(details.responseHeaders ?? {}).map(([key, values]) => [key.toLowerCase(), values]));
    const locations = headers.location;
    if (locations?.length !== 1) return undefined;
    const target = new URL(locations[0], source);
    if (target.origin !== flow.origin || target.username || target.password || target.hash) return undefined;
    const cookies = (headers['set-cookie'] ?? []).map((cookie) => freshAuthCookie(cookie, target.hostname));
    if (!cookies.includes('signed-in') || !cookies.includes('secure-auth')) return undefined;
    if (flow.kind === 'password-change') {
      const updated = target.searchParams.get('updated');
      if (target.pathname !== flow.formPath || (updated !== 'true' && updated !== '1')) return undefined;
    } else if (!target.pathname.startsWith(flow.prefix + 'wp-admin/')) return undefined;
    return target.href;
  } catch { return undefined; }
}

interface LoginAttempt {
  nonce: string;
  flow: WordPressLoginFlow;
  username?: string;
  password?: Buffer;
  redirect?: string;
  expires: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** One foreground document and one short-lived candidate. Nothing is written or exposed to browser chrome. */
export class WordPressLoginAttempt {
  private current?: LoginAttempt;

  arm(flow: WordPressLoginFlow): string {
    this.clear();
    const nonce = randomUUID();
    this.current = { nonce, flow, expires: Date.now() + 30 * 60_000 };
    return nonce;
  }

  submit(nonce: unknown, username: unknown, password: unknown): boolean {
    const attempt = this.current;
    if (!attempt || attempt.nonce !== nonce || attempt.expires <= Date.now() || attempt.password
      || typeof username !== 'string' || !username.trim() || username.length > 500 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(username)
      || typeof password !== 'string' || !password || password.length > 5000) return false;
    attempt.username = username.trim();
    attempt.password = Buffer.from(password, 'utf8');
    attempt.expires = Date.now() + 15_000;
    attempt.timer = setTimeout(() => this.clear(), 15_000);
    attempt.timer.unref();
    return true;
  }

  response(details: ResponseProof): void {
    const attempt = this.current;
    if (!attempt?.password || attempt.expires <= Date.now() || attempt.redirect) return;
    attempt.redirect = verifiedWordPressRedirect(attempt.flow, details);
  }

  commit(url: string, status: number): { username: string; password: Buffer; origin: string } | undefined {
    const attempt = this.current;
    if (!attempt?.password || !attempt.username || attempt.redirect !== url || attempt.expires <= Date.now() || status < 200 || status >= 300) {
      this.clear();
      return undefined;
    }
    const candidate = { username: attempt.username, password: attempt.password, origin: attempt.flow.origin };
    attempt.password = undefined;
    this.clear();
    return candidate;
  }

  clear(): void {
    if (this.current?.timer) clearTimeout(this.current.timer);
    this.current?.password?.fill(0);
    this.current = undefined;
  }
}
