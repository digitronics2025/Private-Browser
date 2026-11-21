import { createHash } from 'node:crypto';
import { isHomePageUrl, MAX_STARTUP_PAGES, type BrowserSettingsPatch, type PresetSearchEngineId } from './browser-settings.js';
import type { AccountSpaceId, ChromeSettingChoice, ChromeSettingsSelection } from './types.js';

export const MAX_CHROME_PROFILE_RECEIPTS = 256;

export function chromeProfileKey(profileId: string): string {
  if (profileId !== 'Default' && !/^Profile \d+$/.test(profileId)) throw new Error('Unknown Chrome profile');
  // The browser discovers Chrome's single standard user-data root per OS user.
  // The receipt contains no source path, profile name, email, or page data.
  return createHash('sha256').update('chrome-profile-v1:' + profileId).digest('hex');
}

export function chromeProfileReceipts(value: unknown): Record<string, AccountSpaceId> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).slice(0, MAX_CHROME_PROFILE_RECEIPTS).filter(([fingerprint, id]) =>
    /^[a-f0-9]{64}$/.test(fingerprint) && typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id));
  return entries.length ? Object.fromEntries(entries) : undefined;
}

const SEARCH_ORIGINS: Record<string, PresetSearchEngineId> = {
  'https://www.google.com': 'google',
  'https://www.bing.com': 'bing',
  'https://duckduckgo.com': 'duckduckgo',
  'https://search.brave.com': 'brave',
  'https://www.startpage.com': 'startpage',
  'https://www.ecosia.org': 'ecosia',
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeSettingAddress(value: unknown): string | undefined {
  if (!isHomePageUrl(value)) return undefined;
  const url = new URL(value);
  // Opening a saved address must not restore embedded account or session data.
  if (url.username || url.password || /(?:token|password|session|auth|secret|key|code)/i.test([...url.searchParams.keys(), url.hash].join(' '))) return undefined;
  return url.href;
}

function searchEngine(preferences: Record<string, unknown>): PresetSearchEngineId | undefined {
  const data = record(record(preferences.default_search_provider_data).template_url_data);
  if (typeof data.url !== 'string' || !data.url.includes('{searchTerms}') || data.url.length > 4096) return undefined;
  const template = data.url.replace(/^\{google:baseURL\}/, 'https://www.google.com/');
  try {
    const url = new URL(template.replaceAll('{searchTerms}', 'search-term'));
    return url.username || url.password ? undefined : SEARCH_ORIGINS[url.origin];
  } catch {
    return undefined;
  }
}

export function selectedChromeSettings(value: unknown, choice: ChromeSettingsSelection): {
  patch: BrowserSettingsPatch; applied: ChromeSettingChoice[]; unavailable: ChromeSettingChoice[];
} {
  const preferences = record(value);
  const patch: BrowserSettingsPatch = {};
  const applied: ChromeSettingChoice[] = [];
  const unavailable: ChromeSettingChoice[] = [];
  if (choice.search) {
    const engine = searchEngine(preferences);
    if (engine) { patch.searchEngine = engine; applied.push('search'); }
    else unavailable.push('search');
  }
  if (choice.home) {
    const address = safeSettingAddress(preferences.homepage);
    if (preferences.homepage_is_newtabpage === true || preferences.homepage === 'chrome://newtab/') {
      patch.homePage = 'new-tab'; applied.push('home');
    } else if (address && preferences.homepage_is_newtabpage === false) {
      patch.homePage = 'url'; patch.homePageUrl = address; applied.push('home');
    } else unavailable.push('home');
  }
  if (choice.startup) {
    const session = record(preferences.session);
    const mode = session.restore_on_startup;
    const pages = Array.isArray(session.startup_urls)
      ? [...new Set(session.startup_urls.slice(0, MAX_STARTUP_PAGES).map(safeSettingAddress).filter((url): url is string => Boolean(url)))] : [];
    if (mode === 1) { patch.startup = 'continue'; applied.push('startup'); }
    else if (mode === 5) { patch.startup = 'new-tab'; applied.push('startup'); }
    else if ((mode === 4 || mode === 6) && pages.length) {
      patch.startup = 'pages'; patch.startupPages = pages; applied.push('startup');
    } else unavailable.push('startup');
  }
  return { patch, applied, unavailable };
}
