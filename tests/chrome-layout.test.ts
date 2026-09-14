import { describe, expect, it } from 'vitest';
import { CHROME, clampSidePanelWidth, computeChromeLayout, contentBounds, DEFAULT_CONTENT_INSETS, MIN_CHROME_TOP, MIN_CONTENT_WIDTH, sanitizeContentInsets, SIDE_PANEL, type ChromeLayoutInput } from '../electron/chrome-layout';

const base: ChromeLayoutInput = { bookmarkBarMode: 'always', isHome: false, findBarOpen: false, sidePanelOpen: false, sidePanelWidth: SIDE_PANEL.default, fullscreen: false };

describe('chrome layout', () => {
  it('stacks the tab strip, toolbar, bookmarks bar and find bar', () => {
    expect(computeChromeLayout(base).insets).toEqual({ top: CHROME.tabStrip + CHROME.toolbar + CHROME.bookmarkBar, left: 0, right: 0, bottom: 0 });
    expect(computeChromeLayout({ ...base, bookmarkBarMode: 'hidden' }).insets.top).toBe(CHROME.tabStrip + CHROME.toolbar);
    expect(computeChromeLayout({ ...base, findBarOpen: true }).insets.top).toBe(CHROME.tabStrip + CHROME.toolbar + CHROME.bookmarkBar + CHROME.findBar);
  });

  it('shows the New-Tab-only bookmarks bar only on the New Tab page', () => {
    expect(computeChromeLayout({ ...base, bookmarkBarMode: 'new-tab', isHome: true }).bookmarkBar).toBe(CHROME.bookmarkBar);
    expect(computeChromeLayout({ ...base, bookmarkBarMode: 'new-tab', isHome: false }).bookmarkBar).toBe(0);
  });

  it('never reserves a find bar on the New Tab page', () => {
    expect(computeChromeLayout({ ...base, isHome: true, findBarOpen: true }).findBar).toBe(0);
  });

  it('reserves exactly the side panel width on the right and clamps it', () => {
    expect(computeChromeLayout({ ...base, sidePanelOpen: true }).insets.right).toBe(SIDE_PANEL.default);
    expect(computeChromeLayout({ ...base, sidePanelOpen: true, sidePanelWidth: 9000 }).insets.right).toBe(SIDE_PANEL.max);
    expect(computeChromeLayout({ ...base, sidePanelOpen: true, sidePanelWidth: 10 }).insets.right).toBe(SIDE_PANEL.min);
    expect(computeChromeLayout({ ...base, sidePanelOpen: false, sidePanelWidth: 480 }).insets.right).toBe(0);
    expect(clampSidePanelWidth(Number.NaN)).toBe(SIDE_PANEL.default);
    expect(clampSidePanelWidth(520, 640)).toBe(440);
  });

  it('gives the page the whole window in full screen', () => {
    expect(computeChromeLayout({ ...base, fullscreen: true, sidePanelOpen: true, findBarOpen: true }).insets).toEqual({ top: 0, left: 0, right: 0, bottom: 0 });
  });

  it('keeps the main-process default identical to the renderer calculation', () => {
    expect(DEFAULT_CONTENT_INSETS).toEqual(computeChromeLayout(base).insets);
  });

  it('never lets renderer insets cover the address bar or produce a sliver of page', () => {
    expect(sanitizeContentInsets({ top: 0, left: -5, right: Number.NaN, bottom: 1e9 })).toEqual({ top: MIN_CHROME_TOP, left: 0, right: 0, bottom: 4000 });
    expect(contentBounds({ top: 122, left: 0, right: 400, bottom: 0 }, 1366, 768)).toEqual({ x: 0, y: 122, width: 966, height: 646 });
    expect(contentBounds({ top: 88, left: 0, right: 520, bottom: 0 }, 600, 400).width).toBe(MIN_CONTENT_WIDTH);
  });
});
