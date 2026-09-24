import { DEFAULT_SEARCH_TEMPLATE, isAllowedRemoteUrl } from './security.js';

export type SearchEngineId = 'duckduckgo' | 'google' | 'bing' | 'brave' | 'startpage' | 'ecosia' | 'custom';
export type PresetSearchEngineId = Exclude<SearchEngineId, 'custom'>;
export type HomePageMode = 'new-tab' | 'url';
export type StartupMode = 'continue' | 'home';

/**
 * Behaviour settings, as opposed to `UiPreferences` (layout and theme). The main
 * process is the only place that turns one of these into a URL.
 */
export interface BrowserSettings {
  searchEngine: SearchEngineId;
  /** Present only when `searchEngine` is `custom`. */
  customSearchTemplate?: string;
  homePage: HomePageMode;
  /** Present only when `homePage` is `url`. */
  homePageUrl?: string;
  startup: StartupMode;
}

export type BrowserSettingsPatch = Partial<BrowserSettings>;

export const SEARCH_ENGINES: Record<PresetSearchEngineId, { label: string; template: string }> = {
  duckduckgo: { label: 'DuckDuckGo', template: DEFAULT_SEARCH_TEMPLATE },
  google: { label: 'Google', template: 'https://www.google.com/search?q=%s' },
  bing: { label: 'Bing', template: 'https://www.bing.com/search?q=%s' },
  brave: { label: 'Brave', template: 'https://search.brave.com/search?q=%s' },
  startpage: { label: 'Startpage', template: 'https://www.startpage.com/do/search?q=%s' },
  ecosia: { label: 'Ecosia', template: 'https://www.ecosia.org/search?q=%s' },
};

export const SEARCH_ENGINE_IDS: readonly SearchEngineId[] = [...Object.keys(SEARCH_ENGINES) as PresetSearchEngineId[], 'custom'];
export const HOME_PAGE_MODES: readonly HomePageMode[] = ['new-tab', 'url'];
export const STARTUP_MODES: readonly StartupMode[] = ['continue', 'home'];
export const MAX_SETTING_URL_LENGTH = 2048;

export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
  searchEngine: 'duckduckgo',
  homePage: 'new-tab',
  startup: 'continue',
};

const PATCH_KEYS = new Set(['searchEngine', 'customSearchTemplate', 'homePage', 'homePageUrl', 'startup']);

function member<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

/**
 * A custom search address: HTTPS, no credentials, exactly one `%s`, and the `%s`
 * outside the host so a query can never choose where it is sent.
 */
export function requireSearchTemplate(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Enter a search address');
  const template = value.trim();
  if (!template || template.length > MAX_SETTING_URL_LENGTH) throw new Error('Enter a search address');
  if (template.split('%s').length !== 2) throw new Error('The search address must contain %s exactly once');
  let first: URL;
  let second: URL;
  try {
    first = new URL(template.replace('%s', 'first'));
    second = new URL(template.replace('%s', 'second'));
  } catch {
    throw new Error('The search address is not a valid web address');
  }
  if (first.protocol !== 'https:') throw new Error('The search address must start with https://');
  if (first.username || first.password) throw new Error('The search address must not contain a user name or password');
  if (first.host !== second.host) throw new Error('%s must not be part of the site name');
  return template;
}

function isSearchTemplate(value: unknown): value is string {
  try { requireSearchTemplate(value); return true; } catch { return false; }
}

/** A stored Home address: an HTTP(S) URL without credentials, already normalized by the controller. */
export function isHomePageUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_SETTING_URL_LENGTH && isAllowedRemoteUrl(value);
}

/**
 * Read settings from disk. Each bad field falls back on its own: a bad setting
 * must never put the browser into recovery mode or cost the other fields.
 */
export function sanitizeBrowserSettings(value: unknown): BrowserSettings {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const settings: BrowserSettings = {
    searchEngine: member(SEARCH_ENGINE_IDS, input.searchEngine) ? input.searchEngine : DEFAULT_BROWSER_SETTINGS.searchEngine,
    homePage: member(HOME_PAGE_MODES, input.homePage) ? input.homePage : DEFAULT_BROWSER_SETTINGS.homePage,
    startup: member(STARTUP_MODES, input.startup) ? input.startup : DEFAULT_BROWSER_SETTINGS.startup,
  };
  if (settings.searchEngine === 'custom') {
    if (isSearchTemplate(input.customSearchTemplate)) settings.customSearchTemplate = input.customSearchTemplate.trim();
    else settings.searchEngine = DEFAULT_BROWSER_SETTINGS.searchEngine;
  }
  if (settings.homePage === 'url') {
    if (isHomePageUrl(input.homePageUrl)) settings.homePageUrl = input.homePageUrl;
    else settings.homePage = DEFAULT_BROWSER_SETTINGS.homePage;
  }
  return settings;
}

/**
 * Validate a patch sent over IPC. Unlike reading from disk, a bad patch is an
 * error. The Home address is bounded text here; the controller normalizes it
 * with `parseWebAddress` before merging.
 */
export function requireBrowserSettingsPatch(value: unknown): BrowserSettingsPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid browser settings');
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length === 0 || keys.some((key) => !PATCH_KEYS.has(key))) throw new Error('Invalid browser settings');
  const patch: BrowserSettingsPatch = {};
  if ('searchEngine' in input) { if (!member(SEARCH_ENGINE_IDS, input.searchEngine)) throw new Error('Invalid search engine'); patch.searchEngine = input.searchEngine; }
  if ('customSearchTemplate' in input) patch.customSearchTemplate = requireSearchTemplate(input.customSearchTemplate);
  if ('homePage' in input) { if (!member(HOME_PAGE_MODES, input.homePage)) throw new Error('Invalid Home page choice'); patch.homePage = input.homePage; }
  if ('homePageUrl' in input) {
    if (typeof input.homePageUrl !== 'string' || !input.homePageUrl.trim() || input.homePageUrl.length > MAX_SETTING_URL_LENGTH) throw new Error('Enter a web address');
    patch.homePageUrl = input.homePageUrl.trim();
  }
  if ('startup' in input) { if (!member(STARTUP_MODES, input.startup)) throw new Error('Invalid startup choice'); patch.startup = input.startup; }
  if (patch.searchEngine === 'custom' && patch.customSearchTemplate === undefined) throw new Error('Enter a search address');
  if (patch.homePage === 'url' && patch.homePageUrl === undefined) throw new Error('Enter a web address');
  return patch;
}

/** Merge a validated patch. Choosing a preset or the New Tab page drops the now-unused value. */
export function mergeBrowserSettings(current: BrowserSettings, patch: BrowserSettingsPatch): BrowserSettings {
  const next: Record<string, unknown> = { ...current, ...patch };
  if (next.searchEngine !== 'custom') delete next.customSearchTemplate;
  if (next.homePage !== 'url') delete next.homePageUrl;
  return sanitizeBrowserSettings(next);
}

export function searchTemplateFor(settings: BrowserSettings): string {
  if (settings.searchEngine === 'custom') return settings.customSearchTemplate ?? DEFAULT_SEARCH_TEMPLATE;
  return SEARCH_ENGINES[settings.searchEngine].template;
}

export function searchEngineLabel(settings: BrowserSettings): string | undefined {
  return settings.searchEngine === 'custom' ? undefined : SEARCH_ENGINES[settings.searchEngine].label;
}

/** What Home means for a tab. Protected workspaces (Banking) always get the New Tab page. */
export function resolveHomeUrl(settings: BrowserSettings, protectedWorkspace: boolean): string {
  if (protectedWorkspace || settings.homePage !== 'url' || !settings.homePageUrl) return 'private://home';
  return settings.homePageUrl;
}
