import { isProtectedPage } from './security.js';

export const MEMORY_SAVER_INTERVAL_MS = 5_000;
export const MAX_MEMORY_SAVER_EXCLUSIONS = 64;

export interface MemorySaverPage {
  lastVisibleAt: number;
  interacted?: boolean;
  request?: { url: string; method: string };
}

export function memorySaverOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin.length > 300 || isProtectedPage(value)) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function memorySaverExclusions(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const origins = [...new Set(value.slice(0, MAX_MEMORY_SAVER_EXCLUSIONS).filter((origin): origin is string =>
    typeof origin === 'string' && memorySaverOrigin(origin) === origin))];
  return origins.length ? origins : undefined;
}

export function mayReloadInactivePage(page: MemorySaverPage, currentUrl: string, minutes: number, now: number): boolean {
  if (minutes <= 0 || page.interacted || !page.request || page.request.method !== 'GET' || page.request.url !== currentUrl
    || now - page.lastVisibleAt < minutes * 60_000 || !memorySaverOrigin(currentUrl)) return false;
  const url = new URL(currentUrl);
  return !url.search && !url.hash;
}

// The isolated world returns one boolean. Form values and text never leave the page.
export const MEMORY_SAVER_PAGE_CHECK = `document.readyState === 'complete'
  && history.state == null && (window.getSelection()?.isCollapsed ?? true)
  && !navigator.serviceWorker?.controller
  && !document.querySelector('form, input, textarea, select, iframe, canvas, audio, video, object, embed, [contenteditable]:not([contenteditable="false"])')`;
