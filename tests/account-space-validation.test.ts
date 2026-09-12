import { describe, expect, it } from 'vitest';
import {
  isAccountSpaceId,
  requireAccountLabel,
  requireBoundedStringArray,
  requireExactWebOrigin,
  requireGoogleModules,
} from '../electron/account-space-validation';

describe('Account Space input validation', () => {
  it('accepts UUIDs and rejects identity-derived or malformed identifiers', () => {
    expect(isAccountSpaceId('122b503d-a1b3-497a-a610-e193af8d0702')).toBe(true);
    expect(isAccountSpaceId('sales@example.com')).toBe(false);
    expect(isAccountSpaceId('../personal')).toBe(false);
  });

  it('normalizes labels and rejects control characters or oversized values', () => {
    expect(requireAccountLabel('  Sales  ')).toBe('Sales');
    expect(() => requireAccountLabel('')).toThrow();
    expect(() => requireAccountLabel('bad\u0000label')).toThrow();
    expect(() => requireAccountLabel('x'.repeat(81))).toThrow();
  });

  it('deduplicates allowlisted Google modules and rejects unknown scopes', () => {
    expect(requireGoogleModules(['identity', 'identity', 'gmail-metadata'])).toEqual(['identity', 'gmail-metadata']);
    expect(() => requireGoogleModules(['drive.everything'])).toThrow();
  });

  it('requires a serialized exact origin', () => {
    expect(requireExactWebOrigin('https://meet.google.com')).toBe('https://meet.google.com');
    expect(requireExactWebOrigin('http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173');
    expect(() => requireExactWebOrigin('https://meet.google.com/path')).toThrow();
    expect(() => requireExactWebOrigin('http://meet.google.com')).toThrow();
  });

  it('caps string-array payloads', () => {
    expect(requireBoundedStringArray(['a', 'b'], 'recipients')).toEqual(['a', 'b']);
    expect(() => requireBoundedStringArray(Array.from({ length: 101 }, () => 'a'), 'recipients')).toThrow();
  });
});
