import { DEFAULT_SEARCH_TEMPLATE, isAllowedRemoteUrl, normalizeNavigationInput, parseWebAddress, redactSensitiveText } from './security.js';
import { WORKSPACE_IDS } from './account-space-validation.js';
import { ASSISTANT_PRESETS, type AssistantPresetId, type AssistantPresetOverrides } from './ai-prompt.js';
import type { WorkspaceId } from './types.js';

export type SearchEngineId = 'duckduckgo' | 'google' | 'bing' | 'brave' | 'startpage' | 'ecosia' | 'custom';
export type PresetSearchEngineId = Exclude<SearchEngineId, 'custom'>;
export type HomePageMode = 'new-tab' | 'url';
export type StartupMode = 'continue' | 'home' | 'pages';
export interface SiteKeyword { keyword: string; template: string }
export const SPELLCHECK_LANGUAGES = { en: 'English', fr: 'French', ar: 'Arabic' } as const;
export type SpellcheckLanguage = keyof typeof SPELLCHECK_LANGUAGES;
export interface SpellcheckSettings { enabled: boolean; languages: SpellcheckLanguage[] }
export const DEFAULT_SPELLCHECK: SpellcheckSettings = { enabled: true, languages: [] };
const ZOOM_PERCENTS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500];
const ZOOM_PERCENTS_DESCENDING = [...ZOOM_PERCENTS].reverse();

export function nextZoomPercent(current: number, direction: 'in' | 'out' | 'reset'): number {
  if (direction === 'in') return ZOOM_PERCENTS.find((value) => value > current) ?? ZOOM_PERCENTS.at(-1)!;
  if (direction === 'out') return ZOOM_PERCENTS_DESCENDING.find((value) => value < current) ?? ZOOM_PERCENTS[0];
  return 100;
}

export function spellingDictionary(available: string[], language: string): string | undefined {
  const normalized = language.toLowerCase();
  const base = normalized.split('-')[0];
  return available.find((item) => item.toLowerCase() === normalized)
    ?? available.find((item) => item.toLowerCase().split('-')[0] === base);
}

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
  startupPages?: string[];
  siteKeywords?: SiteKeyword[];
  spellcheck?: SpellcheckSettings;
  assistantPrompts?: AssistantPresetOverrides;
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
export const STARTUP_MODES: readonly StartupMode[] = ['continue', 'home', 'pages'];
export const MAX_SETTING_URL_LENGTH = 2048;
export const MAX_STARTUP_PAGES = 8;
export const MAX_SITE_KEYWORDS = 8;

export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
  searchEngine: 'duckduckgo',
  homePage: 'new-tab',
  startup: 'continue',
};

const PATCH_KEYS = new Set(['searchEngine', 'customSearchTemplate', 'homePage', 'homePageUrl', 'startup', 'startupPages', 'siteKeywords', 'spellcheck', 'assistantPrompts']);

function member<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function requireSpellcheck(value: unknown): SpellcheckSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid spellcheck settings.');
  const { enabled, languages } = value as Partial<SpellcheckSettings>;
  if (typeof enabled !== 'boolean' || !Array.isArray(languages) || languages.length > 3
    || !languages.every((language) => member(Object.keys(SPELLCHECK_LANGUAGES), language))) {
    throw new Error('Choose a supported spellcheck language.');
  }
  return { enabled, languages: [...new Set(languages)] };
}

function requireAssistantPrompts(value: unknown): AssistantPresetOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid prompt presets.');
  const result: AssistantPresetOverrides = {};
  for (const [key, prompt] of Object.entries(value)) {
    if (!Object.hasOwn(ASSISTANT_PRESETS, key) || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 2000) {
      throw new Error('Enter a prompt of up to 2,000 characters.');
    }
    result[key as AssistantPresetId] = redactSensitiveText(prompt.trim()).text.slice(0, 2000);
  }
  return result;
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

function requireStartupPages(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_STARTUP_PAGES) throw new Error('Choose up to eight startup pages.');
  const pages = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== 'string' || candidate.length > MAX_SETTING_URL_LENGTH) throw new Error('Enter a web address for each startup page.');
    const url = parseWebAddress(candidate);
    if (!url || !isHomePageUrl(url)) throw new Error('Enter a web address for each startup page.');
    pages.add(url);
  }
  return [...pages];
}

function requireSiteKeywords(value: unknown): SiteKeyword[] {
  if (!Array.isArray(value) || value.length > MAX_SITE_KEYWORDS) throw new Error('Choose up to eight site keywords.');
  const used = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.keyword !== 'string') throw new Error('Enter a site keyword.');
    const keyword = item.keyword.trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,15}$/.test(keyword) || used.has(keyword)) throw new Error('Use a unique site keyword of up to 16 letters, digits or hyphens.');
    used.add(keyword);
    return { keyword, template: requireSearchTemplate(item.template) };
  });
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
  if (input.startupPages !== undefined) {
    try {
      const pages = requireStartupPages(input.startupPages);
      if (pages.length) settings.startupPages = pages;
    } catch { /* Ignore invalid stored startup pages. */ }
  }
  if (settings.startup === 'pages' && !settings.startupPages?.length) settings.startup = 'continue';
  if (input.siteKeywords !== undefined) {
    try {
      const keywords = requireSiteKeywords(input.siteKeywords);
      if (keywords.length) settings.siteKeywords = keywords;
    } catch { /* Ignore invalid stored keyword entries. */ }
  }
  if (input.spellcheck !== undefined) {
    try { settings.spellcheck = requireSpellcheck(input.spellcheck); } catch { /* Ignore invalid stored spellcheck settings. */ }
  }
  if (input.assistantPrompts !== undefined) {
    try { settings.assistantPrompts = requireAssistantPrompts(input.assistantPrompts); } catch { /* Ignore invalid stored prompt presets. */ }
  }
  return settings;
}

export function sanitizeWorkspaceSettings(value: unknown): Partial<Record<WorkspaceId, BrowserSettings>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Partial<Record<WorkspaceId, unknown>>;
  return Object.fromEntries([...WORKSPACE_IDS].filter((id) => input[id] && typeof input[id] === 'object' && !Array.isArray(input[id]))
    .map((id) => [id, sanitizeBrowserSettings(input[id])]));
}

export function settingsForWorkspace(state: { settings: BrowserSettings; workspaceSettings?: Partial<Record<WorkspaceId, BrowserSettings>> }, workspace: WorkspaceId): BrowserSettings {
  return state.workspaceSettings?.[workspace] ?? state.settings;
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
  if ('startupPages' in input) patch.startupPages = requireStartupPages(input.startupPages);
  if ('siteKeywords' in input) patch.siteKeywords = requireSiteKeywords(input.siteKeywords);
  if ('spellcheck' in input) patch.spellcheck = requireSpellcheck(input.spellcheck);
  if ('assistantPrompts' in input) patch.assistantPrompts = requireAssistantPrompts(input.assistantPrompts);
  if (patch.searchEngine === 'custom' && patch.customSearchTemplate === undefined) throw new Error('Enter a search address');
  if (patch.homePage === 'url' && patch.homePageUrl === undefined) throw new Error('Enter a web address');
  if (patch.startup === 'pages' && !patch.startupPages?.length) throw new Error('Add at least one startup page.');
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

export function resolveWorkspaceNavigation(value: string, settings: BrowserSettings, protectedWorkspace: boolean): string {
  if (!protectedWorkspace && settings.siteKeywords?.length) {
    const match = /^([a-z][a-z0-9-]{0,15})\s+(.+)$/is.exec(value.trim());
    const keyword = match && settings.siteKeywords.find((entry) => entry.keyword === match[1].toLowerCase());
    if (match && keyword) return keyword.template.replace('%s', encodeURIComponent(match[2].trim()));
  }
  return normalizeNavigationInput(value, searchTemplateFor(settings));
}

/** What Home means for a tab. Protected workspaces (Banking) always get the New Tab page. */
export function resolveHomeUrl(settings: BrowserSettings, protectedWorkspace: boolean): string {
  if (protectedWorkspace || settings.homePage !== 'url' || !settings.homePageUrl) return 'private://home';
  return settings.homePageUrl;
}
