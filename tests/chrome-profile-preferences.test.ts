import { describe, expect, it } from 'vitest';
import { chromeProfileKey, chromeProfileReceipts, selectedChromeSettings } from '../electron/chrome-profile-preferences';

const preferences = {
  default_search_provider_data: { template_url_data: { url: '{google:baseURL}search?q={searchTerms}' } },
  homepage_is_newtabpage: false, homepage: 'https://reference.example.test/',
  session: { restore_on_startup: 4, startup_urls: ['https://start.example.test/', 'file:///outside'] },
};

describe('Chrome profile settings and import receipts', () => {
  it('maps selected settings independently and drops untrusted startup addresses', () => {
    expect(selectedChromeSettings(preferences, { home: true })).toEqual({
      patch: { homePage: 'url', homePageUrl: 'https://reference.example.test/' }, applied: ['home'], unavailable: [],
    });
    expect(selectedChromeSettings(preferences, { search: true, startup: true })).toEqual({
      patch: { searchEngine: 'google', startup: 'pages', startupPages: ['https://start.example.test/'] },
      applied: ['search', 'startup'], unavailable: [],
    });
    expect(selectedChromeSettings({ session: { restore_on_startup: 5 } }, { startup: true }).patch).toEqual({ startup: 'new-tab' });
  });

  it('rejects an unrecognized search engine and credential-bearing destinations', () => {
    const unsafe = { ...preferences, homepage: 'https://example.test/#access_token=sample',
      default_search_provider_data: { template_url_data: { url: 'https://search.example.test/?q={searchTerms}' } } };
    expect(selectedChromeSettings(unsafe, { home: true, search: true })).toMatchObject({ patch: {}, unavailable: ['search', 'home'] });
    const id = '51497a3f-c1bd-477a-b489-671adbb56fa0';
    const key = chromeProfileKey('Profile 1');
    expect(chromeProfileKey('Default')).not.toBe(key);
    expect(chromeProfileReceipts({ [key]: id, 'untrusted source': id })).toEqual({ [key]: id });
  });
});
