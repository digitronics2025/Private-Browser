import type { GoogleModule } from './types.js';

export const GOOGLE_SCOPE_BY_MODULE: Readonly<Record<GoogleModule, readonly string[]>> = {
  identity: ['openid', 'email', 'profile'],
  'gmail-metadata': ['https://www.googleapis.com/auth/gmail.metadata'],
  'gmail-read': ['https://www.googleapis.com/auth/gmail.readonly'],
  'gmail-send': ['https://www.googleapis.com/auth/gmail.send'],
  'drive-files': ['https://www.googleapis.com/auth/drive.file'],
  'drive-metadata': ['https://www.googleapis.com/auth/drive.metadata.readonly'],
  'drive-read': ['https://www.googleapis.com/auth/drive.readonly'],
  'calendar-read': ['https://www.googleapis.com/auth/calendar.events.readonly'],
  'calendar-write': ['https://www.googleapis.com/auth/calendar.events.owned'],
  'contacts-read': ['https://www.googleapis.com/auth/contacts.readonly'],
  'encrypted-backup': ['https://www.googleapis.com/auth/drive.appdata'],
};

export const HIGH_RISK_GOOGLE_MODULES = new Set<GoogleModule>(['gmail-read', 'drive-metadata', 'drive-read']);

export function scopesForModules(modules: GoogleModule[]): string[] {
  const complete = modules.includes('identity') ? modules : ['identity' as const, ...modules];
  return [...new Set(complete.flatMap((module) => GOOGLE_SCOPE_BY_MODULE[module]))];
}

export function hasAllScopes(granted: string[], required: string[]): boolean {
  const actual = new Set(granted);
  return required.every((scope) => actual.has(scope));
}
