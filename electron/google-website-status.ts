import type { GoogleWebsiteStatus } from './types.js';

const GOOGLE_WEB_HOSTS = new Set([
  'accounts.google.com',
  'mail.google.com',
  'drive.google.com',
  'docs.google.com',
  'calendar.google.com',
  'contacts.google.com',
  'meet.google.com',
]);

const EMBEDDED_REJECTION_MARKERS = [
  'this browser or app may not be secure',
  'couldn’t sign you in',
  "couldn't sign you in",
  'browser is not supported',
];

export function isKnownGoogleWebHost(urlValue: string): boolean {
  try { return GOOGLE_WEB_HOSTS.has(new URL(urlValue).hostname.toLowerCase()); } catch { return false; }
}

export function googleWebsiteStatus(pageText: string, hasGoogleSessionData: boolean): GoogleWebsiteStatus {
  const normalized = pageText.toLowerCase().replace(/\s+/g, ' ').slice(0, 20_000);
  if (EMBEDDED_REJECTION_MARKERS.some((marker) => normalized.includes(marker))) return 'sign-in-blocked';
  return hasGoogleSessionData ? 'session-data-present' : 'unknown';
}
