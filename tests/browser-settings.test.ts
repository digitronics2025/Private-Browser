import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BROWSER_SETTINGS,
  mergeBrowserSettings,
  requireBrowserSettingsPatch,
  requireSearchTemplate,
  resolveHomeUrl,
  sanitizeBrowserSettings,
  searchEngineLabel,
  searchTemplateFor,
} from '../electron/browser-settings';

describe('browser settings', () => {
  it('defaults to DuckDuckGo, the New Tab page and restoring the previous tabs', () => {
    expect(DEFAULT_BROWSER_SETTINGS).toEqual({ searchEngine: 'duckduckgo', homePage: 'new-tab', startup: 'continue' });
    expect(sanitizeBrowserSettings(undefined)).toEqual(DEFAULT_BROWSER_SETTINGS);
    expect(sanitizeBrowserSettings(['google'])).toEqual(DEFAULT_BROWSER_SETTINGS);
  });

  it('falls back field by field for hostile values on disk instead of failing', () => {
    expect(sanitizeBrowserSettings({ searchEngine: 'google', homePage: 'shell', startup: 7 })).toEqual({ ...DEFAULT_BROWSER_SETTINGS, searchEngine: 'google' });
    expect(sanitizeBrowserSettings({ searchEngine: 'custom', customSearchTemplate: 'javascript:alert(%s)', startup: 'home' })).toEqual({ ...DEFAULT_BROWSER_SETTINGS, startup: 'home' });
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
  });
});
