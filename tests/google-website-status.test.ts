import { describe, expect, it } from 'vitest';
import { googleWebsiteStatus, isKnownGoogleWebHost } from '../electron/google-website-status';

describe('Google website status', () => {
  it('never equates cookie presence with authenticated identity', () => {
    expect(googleWebsiteStatus('Inbox', true)).toBe('session-data-present');
    expect(googleWebsiteStatus('Sign in', false)).toBe('unknown');
  });

  it('detects known embedded sign-in rejection states locally', () => {
    expect(googleWebsiteStatus('This browser or app may not be secure', true)).toBe('sign-in-blocked');
  });

  it('limits inspection to known exact Google web hosts', () => {
    expect(isKnownGoogleWebHost('https://mail.google.com/mail/u/0/')).toBe(true);
    expect(isKnownGoogleWebHost('https://mail.google.com.evil.example/')).toBe(false);
  });
});
