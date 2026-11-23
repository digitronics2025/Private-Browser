import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BROWSER_SETTINGS,
  mergeBrowserSettings,
  requireBrowserSettingsPatch,
  requireSearchTemplate,
  referenceSearchUrl,
  resolveHomeUrl,
  resolveNewTabUrl,
  resolveWorkspaceNavigation,
  sanitizeBrowserSettings,
  searchEngineLabel,
  searchTemplateFor,
  settingsForWorkspace,
} from '../electron/browser-settings';

describe('browser settings', () => {
  it('defaults to DuckDuckGo, the New Tab page and restoring the previous tabs', () => {
    expect(DEFAULT_BROWSER_SETTINGS).toEqual({ searchEngine: 'duckduckgo', homePage: 'new-tab', newTab: 'start', startup: 'automatic' });
    expect(sanitizeBrowserSettings(undefined)).toEqual(DEFAULT_BROWSER_SETTINGS);
    expect(sanitizeBrowserSettings(['google'])).toEqual(DEFAULT_BROWSER_SETTINGS);
  });

  it('falls back field by field for hostile values on disk instead of failing', () => {
    expect(sanitizeBrowserSettings({ searchEngine: 'google', homePage: 'shell', startup: 7 })).toEqual({ ...DEFAULT_BROWSER_SETTINGS, searchEngine: 'google' });
    expect(sanitizeBrowserSettings({ searchEngine: 'custom', customSearchTemplate: 'javascript:alert(%s)', startup: 'home' })).toEqual({ ...DEFAULT_BROWSER_SETTINGS, startupHome: true });
    expect(sanitizeBrowserSettings({ homePage: 'url', homePageUrl: 'file:///C:/Windows' })).toEqual(DEFAULT_BROWSER_SETTINGS);
    expect(sanitizeBrowserSettings({ homePage: 'url', homePageUrl: 'https://tenten.ma/' })).toEqual({ ...DEFAULT_BROWSER_SETTINGS, homePage: 'url', homePageUrl: 'https://tenten.ma/' });
    expect(sanitizeBrowserSettings({ searchEngine: 'bing', customSearchTemplate: 'https://example.com/?q=%s' })).toEqual({ ...DEFAULT_BROWSER_SETTINGS, searchEngine: 'bing' });
  });

  it('accepts only HTTPS search addresses with one %s outside the site name', () => {
    expect(requireSearchTemplate(' https://search.example.com/find?q=%s&lang=fr ')).toBe('https://search.example.com/find?q=%s&lang=fr');
    expect(requireSearchTemplate('https://example.com/search/%s')).toBe('https://example.com/search/%s');
    const refused = [
      'http://example.com/?q=%s',
      'https://example.com/?q=',
      'https://example.com/?q=%s&r=%s',
      'https://%s.example.com/',
      'https://example.%s/?q=1',
      'https://user:pass@example.com/?q=%s', // secret-guard:allow
      'javascript:alert(%s)',
      'not a url %s',
      `https://example.com/?q=%s&pad=${'x'.repeat(2048)}`,
      42,
    ];
    for (const value of refused) expect(() => requireSearchTemplate(value), String(value)).toThrow();
  });

  it('names the template and label of the chosen engine', () => {
    const google = sanitizeBrowserSettings({ searchEngine: 'google' });
    const custom = sanitizeBrowserSettings({ searchEngine: 'custom', customSearchTemplate: 'https://example.com/s/%s?src=pb' });
    expect(searchTemplateFor(DEFAULT_BROWSER_SETTINGS)).toBe('https://duckduckgo.com/?q=%s');
    expect(searchTemplateFor(google)).toBe('https://www.google.com/search?q=%s');
    expect(searchTemplateFor(custom)).toBe('https://example.com/s/%s?src=pb');
    expect(searchEngineLabel(google)).toBe('Google');
    expect(searchEngineLabel(custom)).toBeUndefined();
  });

  it('rejects malformed or incomplete IPC patches outright', () => {
    expect(requireBrowserSettingsPatch({ searchEngine: 'brave' })).toEqual({ searchEngine: 'brave' });
    expect(requireBrowserSettingsPatch({ homePage: 'url', homePageUrl: ' tenten.ma ' })).toEqual({ homePage: 'url', homePageUrl: 'tenten.ma' });
    const bad = [null, [], {}, { searchEngine: 'yahoo' }, { searchEngine: 'custom' }, { homePage: 'url' }, { homePageUrl: '' }, { homePageUrl: 'x'.repeat(2049) },
      { startup: 'everything' }, { customSearchTemplate: 'http://x.test/?q=%s' }, { extra: true }, { __proto__: { searchEngine: 'google' }, extra: 1 }];
    for (const value of bad) expect(() => requireBrowserSettingsPatch(value), JSON.stringify(value)).toThrow();
  });

  it('merges patches and drops values the new choice no longer uses', () => {
    const custom = mergeBrowserSettings(DEFAULT_BROWSER_SETTINGS, { searchEngine: 'custom', customSearchTemplate: 'https://example.com/?q=%s' });
    expect(custom.customSearchTemplate).toBe('https://example.com/?q=%s');
    expect(mergeBrowserSettings(custom, { searchEngine: 'ecosia' })).toEqual({ ...DEFAULT_BROWSER_SETTINGS, searchEngine: 'ecosia' });
    const home = mergeBrowserSettings(DEFAULT_BROWSER_SETTINGS, { homePage: 'url', homePageUrl: 'https://tenten.ma/' });
    expect(mergeBrowserSettings(home, { homePage: 'new-tab' })).toEqual(DEFAULT_BROWSER_SETTINGS);
  });

  it('keeps Banking on the New Tab page whatever the Home setting says', () => {
    const home = sanitizeBrowserSettings({ homePage: 'url', homePageUrl: 'https://tenten.ma/' });
    expect(resolveHomeUrl(home, false)).toBe('https://tenten.ma/');
    expect(resolveHomeUrl(home, true)).toBe('private://home');
    expect(resolveHomeUrl(DEFAULT_BROWSER_SETTINGS, false)).toBe('private://home');
    expect(resolveNewTabUrl({ ...DEFAULT_BROWSER_SETTINGS, newTab: 'blank' }, true)).toBe('private://home');
  });

  it('keeps Home, New Tab and startup independent across every choice combination', () => {
    const homes = [
      { homePage: 'new-tab' as const },
      { homePage: 'url' as const, homePageUrl: 'https://home.example.test/' },
    ];
    const newTabs = [
      { newTab: 'start' as const },
      { newTab: 'blank' as const },
      { newTab: 'url' as const, newTabUrl: 'https://tab.example.test/' },
    ];
    const startups = ['fresh', 'ask', 'automatic'] as const;
    let combinations = 0;
    for (const home of homes) for (const newTab of newTabs) for (const startup of startups) {
      const settings = sanitizeBrowserSettings({ ...home, ...newTab, startup });
      expect(settings.startup).toBe(startup);
      expect(resolveHomeUrl(settings, false)).toBe(home.homePage === 'url' ? 'https://home.example.test/' : 'private://home');
      expect(resolveNewTabUrl(settings, false)).toBe(newTab.newTab === 'url' ? 'https://tab.example.test/'
        : newTab.newTab === 'blank' ? 'private://blank' : 'private://home');
      combinations++;
    }
    expect(combinations).toBe(18);
  });

  it('migrates each legacy startup choice without losing its add-on', () => {
    expect(sanitizeBrowserSettings({ startup: 'continue' }).startup).toBe('automatic');
    expect(sanitizeBrowserSettings({ startup: 'home' })).toMatchObject({ startup: 'automatic', startupHome: true });
    expect(sanitizeBrowserSettings({ startup: 'new-tab' })).toMatchObject({ startup: 'automatic', startupNewTab: true });
    expect(sanitizeBrowserSettings({ startup: 'pages', startupPages: ['https://start.example.test/'] }))
      .toMatchObject({ startup: 'automatic', startupPages: ['https://start.example.test/'] });
  });

  it('preserves legacy settings and restricts startup pages and explicit site keywords by workspace', () => {
    const legacy = sanitizeBrowserSettings({ searchEngine: 'google', homePage: 'url', homePageUrl: 'https://example.test/old' });
    const patch = requireBrowserSettingsPatch({
      startup: 'pages', startupPages: ['example.test/start', 'https://example.test/start'],
      siteKeywords: [{ keyword: 'GH', template: 'https://example.test/search?q=%s' }],
    });
    const personal = mergeBrowserSettings(legacy, patch);
    const state = { settings: legacy, workspaceSettings: { personal } };
    expect(settingsForWorkspace(state, 'tenten')).toEqual(legacy);
    expect(settingsForWorkspace(state, 'personal').startupPages).toEqual(['https://example.test/start']);
    expect(resolveWorkspaceNavigation('gh privacy & tabs', personal, false)).toBe('https://example.test/search?q=privacy%20%26%20tabs');
    expect(resolveWorkspaceNavigation('gh privacy & tabs', personal, true)).toBe('https://www.google.com/search?q=gh%20privacy%20%26%20tabs');
    expect(requireBrowserSettingsPatch({ startup: 'pages', startupPages: [] })).toMatchObject({ startup: 'automatic' });
    expect(() => requireBrowserSettingsPatch({ startupPages: ['file:///fixture'] })).toThrow();
    expect(() => requireBrowserSettingsPatch({ siteKeywords: [{ keyword: 'gh', template: 'http://example.test?q=%s' }] })).toThrow();
  });

  it('previews the exact normalized URL for a saved reference search without a fallback', () => {
    const settings = mergeBrowserSettings(DEFAULT_BROWSER_SETTINGS, {
      siteKeywords: [{ keyword: 'stock', template: 'https://inventory.example.test/search?q=%s&utm_source=portal' }],
    });
    const url = referenceSearchUrl(settings, 'stock', '  LX/3 & blue #5  ');
    expect(url).toBe('https://inventory.example.test/search?q=LX%2F3+%26+blue+%235');
    expect(new URL(url!).searchParams.get('q')).toBe('LX/3 & blue #5');
    expect(referenceSearchUrl(settings, 'missing', 'LX/3')).toBeUndefined();
    expect(referenceSearchUrl(settings, 'stock', '  ')).toBeUndefined();
    expect(referenceSearchUrl(settings, 'stock', 'x'.repeat(121))).toBeUndefined();
    expect(referenceSearchUrl(settings, 'stock', String.fromCharCode(0xd800))).toBeUndefined();
  });
});
