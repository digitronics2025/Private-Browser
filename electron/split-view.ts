import { isAllowedRemoteUrl, isProtectedPage } from './security.js';
import type { BrowserTab } from './types.js';

export const SPLIT_GUTTER = 8;
export const MIN_SPLIT_WIDTH = 640;

export function splitPageAllowed(tab: BrowserTab): boolean {
  return tab.workspaceId !== 'banking' && !tab.isHome && !tab.restorePaused && !tab.problem
    && isAllowedRemoteUrl(tab.url) && !isProtectedPage(tab.url);
}

export function splitBounds<T extends { x: number; y: number; width: number; height: number }>(rect: T): { left: T; right: T } | undefined {
  if (rect.width < MIN_SPLIT_WIDTH || rect.height < 1) return undefined;
  const leftWidth = Math.floor((rect.width - SPLIT_GUTTER) / 2);
  return {
    left: { ...rect, width: leftWidth },
    right: { ...rect, x: rect.x + leftWidth + SPLIT_GUTTER, width: rect.width - leftWidth - SPLIT_GUTTER },
  };
}
