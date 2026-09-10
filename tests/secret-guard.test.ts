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
