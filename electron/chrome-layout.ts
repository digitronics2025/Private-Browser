/**
 * The single source of browser-chrome geometry.
 *
 * Web pages are native `WebContentsView`s positioned by the main process, not
 * part of the React tree, so the renderer and the main process must agree on
 * exactly where the chrome ends. Both import these numbers: the renderer sizes
 * its bars from them and reports the resulting insets, and the main process
 * clamps whatever it receives against the same limits.
 */

export const CHROME = {
  tabStrip: 40,
  toolbar: 48,
  bookmarkBar: 34,
  findBar: 44,
} as const;

export const SIDE_PANEL = {
  min: 320,
  default: 400,
  max: 520,
} as const;

/** The narrowest page the main process will ever lay out. */
export const MIN_CONTENT_WIDTH = 200;
export const MIN_CONTENT_HEIGHT = 100;
/** The renderer can never cover less than the tab strip and toolbar. */
export const MIN_CHROME_TOP = CHROME.tabStrip + CHROME.toolbar;
/** Width Windows reserves for the native caption buttons when the overlay API is unavailable. */
export const CAPTION_BUTTONS_FALLBACK_WIDTH = 138;

/** Colours the native title-bar overlay must share with the tab strip. */
export const FRAME_COLORS = {
  dark: { frame: '#16181b', symbol: '#e3e6ea', window: '#1f2226' },
  light: { frame: '#dde4e8', symbol: '#1e2329', window: '#f6f8f9' },
} as const;

export type BookmarkBarMode = 'always' | 'new-tab' | 'hidden';

export interface ContentInsets {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export interface ChromeLayoutInput {
  bookmarkBarMode: BookmarkBarMode;
  isHome: boolean;
  findBarOpen: boolean;
  sidePanelOpen: boolean;
  sidePanelWidth: number;
  fullscreen: boolean;
  windowWidth?: number;
}

export interface ChromeLayout {
  tabStrip: number;
  toolbar: number;
  bookmarkBar: number;
  findBar: number;
  sidePanel: number;
  insets: ContentInsets;
}

export const ZERO_INSETS: ContentInsets = { top: 0, left: 0, right: 0, bottom: 0 };

export function bookmarkBarShown(mode: BookmarkBarMode, isHome: boolean): boolean {
  return mode === 'always' || (mode === 'new-tab' && isHome);
}

export function clampSidePanelWidth(width: number, windowWidth?: number): number {
  const requested = Number.isFinite(width) ? Math.round(width) : SIDE_PANEL.default;
  const ceiling = windowWidth === undefined
    ? SIDE_PANEL.max
    : Math.max(SIDE_PANEL.min, Math.min(SIDE_PANEL.max, Math.floor(windowWidth - MIN_CONTENT_WIDTH)));
  return Math.min(ceiling, Math.max(SIDE_PANEL.min, requested));
}

export function computeChromeLayout(input: ChromeLayoutInput): ChromeLayout {
  if (input.fullscreen) {
    return { tabStrip: 0, toolbar: 0, bookmarkBar: 0, findBar: 0, sidePanel: 0, insets: { ...ZERO_INSETS } };
  }
  const bookmarkBar = bookmarkBarShown(input.bookmarkBarMode, input.isHome) ? CHROME.bookmarkBar : 0;
  const findBar = input.findBarOpen && !input.isHome ? CHROME.findBar : 0;
  const sidePanel = input.sidePanelOpen ? clampSidePanelWidth(input.sidePanelWidth, input.windowWidth) : 0;
  return {
    tabStrip: CHROME.tabStrip,
    toolbar: CHROME.toolbar,
    bookmarkBar,
    findBar,
    sidePanel,
    insets: {
      top: CHROME.tabStrip + CHROME.toolbar + bookmarkBar + findBar,
      left: 0,
      right: sidePanel,
      bottom: 0,
    },
  };
}

export const DEFAULT_CONTENT_INSETS: ContentInsets = computeChromeLayout({
  bookmarkBarMode: 'always',
  isHome: false,
  findBarOpen: false,
  sidePanelOpen: false,
  sidePanelWidth: SIDE_PANEL.default,
  fullscreen: false,
}).insets;

/** Normalise insets received from the renderer. Never trusts them to be sane. */
export function sanitizeContentInsets(value: ContentInsets): ContentInsets {
  const finite = (input: number, minimum: number) => Math.max(minimum, Math.min(4000, Math.round(Number.isFinite(input) ? input : minimum)));
  return {
    top: finite(value.top, MIN_CHROME_TOP),
    left: finite(value.left, 0),
    right: finite(value.right, 0),
    bottom: finite(value.bottom, 0),
  };
}

/** The rectangle a page occupies inside a window content area of the given size. */
export function contentBounds(insets: ContentInsets, windowWidth: number, windowHeight: number): { x: number; y: number; width: number; height: number } {
  const right = Math.min(insets.right, Math.max(0, windowWidth - insets.left - MIN_CONTENT_WIDTH));
  return {
    x: insets.left,
    y: insets.top,
    width: Math.max(MIN_CONTENT_WIDTH, windowWidth - insets.left - right),
    height: Math.max(MIN_CONTENT_HEIGHT, windowHeight - insets.top - insets.bottom),
  };
}
