import type { GoogleModule, GoogleOverviewService } from './types.js';

export const GOOGLE_OVERVIEW_SERVICES = ['gmail', 'drive', 'calendar'] as const;
export const GOOGLE_OVERVIEW_PAGE_SIZE = 10;
export const GOOGLE_OVERVIEW_MAX_PAGES = 5;

const OVERVIEW_MODULES: Record<GoogleOverviewService, readonly GoogleModule[]> = {
  gmail: ['gmail-metadata', 'gmail-read'],
  drive: ['drive-metadata', 'drive-read', 'drive-files'],
  calendar: ['calendar-read', 'calendar-write'],
};

export function googleOverviewModule(service: GoogleOverviewService, enabled: readonly GoogleModule[]): GoogleModule | undefined {
  return OVERVIEW_MODULES[service].find((module) => enabled.includes(module));
}

export function boundedGoogleCursor(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(value)
    ? value : undefined;
}

export function calendarOriginal(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const allowed = url.hostname === 'calendar.google.com' || url.hostname === 'www.google.com' && url.pathname.startsWith('/calendar/');
    const id = url.searchParams.get('eid');
    if (!allowed || url.protocol !== 'https:' || url.port || url.username || url.password || !id || !/^[A-Za-z0-9_-]{1,1024}$/.test(id)) return undefined;
    return 'https://calendar.google.com/calendar/event?eid=' + encodeURIComponent(id);
  } catch {
    return undefined;
  }
}
