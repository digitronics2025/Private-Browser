// The credential guard behind `npm run secrets:check` and .githooks/pre-commit.
//
// Two things are worth testing and nothing else is: that a real credential is
// refused, and that the ordinary shapes in this repo are not. A guard that cries
// wolf gets bypassed with --no-verify, which is the same as having no guard.
//
// Fixtures live in a temp dir, driven through the script's `scan` mode as a
// subprocess — the same shape as tests/docs-guard.test.ts, and it keeps the
// TypeScript build free of an untyped .mjs import.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'secret-guard-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Returns the guard's report, or '' when it found nothing. */
function scan(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  try {
    execFileSync('node', ['scripts/secret-guard.mjs', 'scan', path], { encoding: 'utf8' });
    return '';
  } catch (err) {
    return String((err as { stderr?: string }).stderr || err);
  }
}

const ALLOW = `secret-guard${':'}allow`;

describe('secret-guard blocks credentials', () => {
  it.each([
    ['a private key block', 'a.txt', '-----BEGIN RSA PRIVATE KEY-----'],
    ['an AWS access key id', 'b.txt', 'const id = "AKIAIOSFODNN7EXAMPLE";'],
    ['a GitHub token', 'c.txt', 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'],
    ['a Slack token', 'd.txt', 'xoxb-123456789012-abcdefghijkl'],
    ['a URL with an embedded password', 'e.txt', 'https://admin:hunter2xyz@internal.example'],
    ['a hard-coded password', 'f.ts', "const password = 'Tr0ub4dor&3xK';"],
    ['a hard-coded api key', 'g.ts', "apiKey: 'c9f2a7e41b8d6503fe27a9c4b1d80e6f'"],
  ])('refuses %s', (_label, name, body) => {
    expect(scan(name, body)).not.toBe('');
  });

  it('refuses a credential file by its name alone, whatever it holds', () => {
    expect(scan('.env', 'nothing incriminating here')).toContain('credential file');
    expect(scan('signing.pem', 'placeholder')).toContain('credential file');
  });

  it('names the file and the line so the fix is obvious', () => {
    const report = scan('h.ts', ['const a = 1;', "const secret = 'Zx91Kq7Lm4Pv2Bn8';"].join('\n'));
    expect(report).toContain('h.ts:2');
    expect(report).toContain('hard-coded secret');
  });
});

describe('secret-guard leaves ordinary code alone', () => {
  it.each([
    ['a value read from the environment', 'i.ts', 'const token = process.env.API_TOKEN;'],
    ['a template placeholder', 'j.ts', 'const apiKey = `${config.apiKey}`;'],
    ['a documented example value', 'k.md', 'Set `API_KEY=your-key-here` before starting.'],
    ['an empty example file', '.env.example', 'API_KEY=\nUPDATE_ENDPOINT='],
    ['a header name that reads like a secret', 'l.ts', "headers['authorization'] = bearer;"],
    ['a redacted value', 'm.txt', 'password = "REDACTED"'],
  ])('passes %s', (_label, name, body) => {
    expect(scan(name, body)).toBe('');
  });

  it('honours an explicit allow marker on a fixture line', () => {
    expect(scan('n.ts', "const password = 'Tr0ub4dor&3xK';")).not.toBe('');
    expect(scan('o.ts', `const password = 'Tr0ub4dor&3xK'; // ${ALLOW}`)).toBe('');
  });
});

// Regression block. On 2026-09-10 a real set of production credentials was pasted
// into .gitignore and this guard reported the tree clean. Two rules were at fault:
// the value had to be quoted, and `\b` never matched a name like
// PRIVATE_BROWSER_ADMIN_API_KEY because `_` is a word character. Every case below
// is a shape that was live at the time and went unseen. Values are synthetic.
describe('secret-guard reads dotenv lines', () => {
  it.each([
    ['a prefixed key name', 'PRIVATE_BROWSER_ADMIN_API_KEY=40EtqwY8Hh6d8qmrjtCBQGJ90x9XjO1Qu4tOX4m24ce'],
    ['a prefixed secret name', 'PRIVATE_BROWSER_SIGNING_SECRET=Qz-4TfNbWmR_8HkLp-VaXcYd31Ee7GgHh2Ii5JjKk'],
    ['a prefixed token name', 'CLOUDFLARE_API_TOKEN=cfut_9QwErTyUiOpAsDfGhJkLzXcVbNm4321'],
    ['an exported assignment', 'export ACCESS_TOKEN=qbu1ZDMDKa3M8iBj6kotRlXPBtS7q8vbewsrvEZKgC4'],
    ['a quoted dotenv value', 'API_KEY="9f2a7e41b8d6503fe27a9c4b1d80e6f3"'],
  ])('refuses %s', (_label, body) => {
    expect(scan('env-' + Math.random().toString(36).slice(2) + '.txt', body)).not.toBe('');
  });

  it('catches it inside .gitignore itself, the file that started this', () => {
    const body = ['node_modules/', '*.log', 'D1_TOKEN=Qz4TfNbWmR8HkLpVaXcYd31Ee7Gg'].join('\n');
    expect(scan('gitignore-fixture.txt', body)).toContain(':3');
  });

  it('still ignores a line that only mentions a credential name', () => {
    expect(scan('p.ts', 'const token = randomUUID();')).toBe('');
    expect(scan('q.ts', 'this.config = { apiKey: input.apiKey.trim() };')).toBe('');
    expect(scan('r.tsx', '<input type="password" placeholder="Download access token" />')).toBe('');
  });

  it('treats zero-entropy filler as the fixture it is', () => {
    expect(scan('s.ts', "const accessToken = 'download-token-abcdefghijklmnopqrstuvwxyz012345';")).toBe('');
    expect(scan('t.ts', "const accessToken = 'test-token-that-is-long-enough-for-bootstrap';")).toBe('');
  });
});

describe('the repository itself', () => {
  it('carries no credentials in any tracked file', () => {
    let output = '';
    let failed = false;
    try {
      execFileSync('node', ['scripts/secret-guard.mjs'], { encoding: 'utf8' });
    } catch (err) {
      failed = true;
      const e = err as { stdout?: string; stderr?: string };
      output = String(e.stderr || e.stdout || err);
    }
    expect(failed ? output : '', output).toBe('');
  });
});
