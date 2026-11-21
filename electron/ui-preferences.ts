import { clampSidePanelWidth, SIDE_PANEL, type BookmarkBarMode } from './chrome-layout.js';

export type ThemePreference = 'system' | 'dark' | 'light';
export type SidePanelTool = 'claude' | 'easynote' | 'assistant' | 'developer' | 'vault' | 'automations' | 'downloads' | 'privacy' | 'settings' | 'bookmarks' | 'history' | 'shortcuts';
export const PINNABLE_PANEL_TOOLS = ['easynote', 'claude', 'assistant', 'developer', 'vault', 'automations', 'downloads', 'privacy'] as const;
export type PinnablePanelTool = typeof PINNABLE_PANEL_TOOLS[number];
export interface AccountPanelPreferences { tool?: PinnablePanelTool; pins?: PinnablePanelTool[] }
export type NewTabBackground = 'plain' | 'lagoon' | 'dusk' | 'mist' | 'graphite';

export interface UiPreferences {
  theme: ThemePreference;
  bookmarkBarMode: BookmarkBarMode;
  sidePanelOpen: boolean;
  sidePanelWidth: number;
  sidePanelCompact?: boolean;
  sidePanelTool: SidePanelTool;
  newTabBackground: NewTabBackground;
  showRecentOnNewTab: boolean;
  offerSetupGuide: boolean;
  importedChromeData: boolean;
}

export type UiPreferencesPatch = Partial<UiPreferences>;

export const THEMES: readonly ThemePreference[] = ['system', 'dark', 'light'];
export const BOOKMARK_BAR_MODES: readonly BookmarkBarMode[] = ['always', 'new-tab', 'hidden'];
export const SIDE_PANEL_TOOLS: readonly SidePanelTool[] = ['claude', 'easynote', 'assistant', 'developer', 'vault', 'automations', 'downloads', 'privacy', 'settings', 'bookmarks', 'history', 'shortcuts'];
export const NEW_TAB_BACKGROUNDS: readonly NewTabBackground[] = ['plain', 'lagoon', 'dusk', 'mist', 'graphite'];

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  theme: 'system',
  bookmarkBarMode: 'always',
  sidePanelOpen: false,
  sidePanelWidth: SIDE_PANEL.default,
  sidePanelTool: 'assistant',
  newTabBackground: 'plain',
  showRecentOnNewTab: true,
  offerSetupGuide: false,
  importedChromeData: false,
};

function member<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

export function isPinnablePanelTool(value: unknown): value is PinnablePanelTool {
  return member(PINNABLE_PANEL_TOOLS, value);
}

export function sanitizeAccountPanel(value: unknown): AccountPanelPreferences | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Partial<AccountPanelPreferences>;
  const tool = isPinnablePanelTool(input.tool) ? input.tool : undefined;
  const pins = Array.isArray(input.pins) ? [...new Set(input.pins.slice(0, 32).filter(isPinnablePanelTool))] : [];
  if (!tool && !pins.length) return undefined;
  return { ...(tool ? { tool } : {}), ...(pins.length ? { pins } : {}) };
}

/**
 * Read preferences from disk. Unknown or hostile values fall back to defaults
 * rather than failing the whole manifest: a bad colour choice must never put the
 * browser into recovery mode.
 */
export function sanitizeUiPreferences(value: unknown, legacyBookmarkBarVisible = true): UiPreferences {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    theme: member(THEMES, input.theme) ? input.theme : DEFAULT_UI_PREFERENCES.theme,
    bookmarkBarMode: member(BOOKMARK_BAR_MODES, input.bookmarkBarMode) ? input.bookmarkBarMode : legacyBookmarkBarVisible ? 'always' : 'hidden',
    sidePanelOpen: typeof input.sidePanelOpen === 'boolean' ? input.sidePanelOpen : DEFAULT_UI_PREFERENCES.sidePanelOpen,
    sidePanelWidth: typeof input.sidePanelWidth === 'number' ? clampSidePanelWidth(input.sidePanelWidth) : DEFAULT_UI_PREFERENCES.sidePanelWidth,
    ...(typeof input.sidePanelCompact === 'boolean' ? { sidePanelCompact: input.sidePanelCompact } : {}),
    sidePanelTool: member(SIDE_PANEL_TOOLS, input.sidePanelTool) ? input.sidePanelTool : DEFAULT_UI_PREFERENCES.sidePanelTool,
    newTabBackground: member(NEW_TAB_BACKGROUNDS, input.newTabBackground) ? input.newTabBackground : DEFAULT_UI_PREFERENCES.newTabBackground,
    showRecentOnNewTab: typeof input.showRecentOnNewTab === 'boolean' ? input.showRecentOnNewTab : DEFAULT_UI_PREFERENCES.showRecentOnNewTab,
    offerSetupGuide: input.offerSetupGuide === true,
    importedChromeData: input.importedChromeData === true,
  };
}

/** Validate a patch sent over IPC. Unlike reading from disk, a bad patch is an error. */
export function requireUiPreferencesPatch(value: unknown): UiPreferencesPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid interface preferences');
  const input = value as Record<string, unknown>;
  const allowed = new Set(['theme', 'bookmarkBarMode', 'sidePanelOpen', 'sidePanelWidth', 'sidePanelCompact', 'sidePanelTool', 'newTabBackground', 'showRecentOnNewTab', 'offerSetupGuide', 'importedChromeData']);
  const keys = Object.keys(input);
  if (keys.length === 0 || keys.some((key) => !allowed.has(key))) throw new Error('Invalid interface preferences');
  const patch: UiPreferencesPatch = {};
  if ('theme' in input) { if (!member(THEMES, input.theme)) throw new Error('Invalid theme'); patch.theme = input.theme; }
  if ('bookmarkBarMode' in input) { if (!member(BOOKMARK_BAR_MODES, input.bookmarkBarMode)) throw new Error('Invalid bookmarks bar mode'); patch.bookmarkBarMode = input.bookmarkBarMode; }
  if ('sidePanelOpen' in input) { if (typeof input.sidePanelOpen !== 'boolean') throw new Error('Invalid side panel state'); patch.sidePanelOpen = input.sidePanelOpen; }
  if ('sidePanelCompact' in input) { if (typeof input.sidePanelCompact !== 'boolean') throw new Error('Invalid side panel mode'); patch.sidePanelCompact = input.sidePanelCompact; }
  if ('sidePanelWidth' in input) {
    if (typeof input.sidePanelWidth !== 'number' || !Number.isFinite(input.sidePanelWidth)) throw new Error('Invalid side panel width');
    patch.sidePanelWidth = clampSidePanelWidth(input.sidePanelWidth);
  }
  if ('sidePanelTool' in input) { if (!member(SIDE_PANEL_TOOLS, input.sidePanelTool)) throw new Error('Invalid side panel tool'); patch.sidePanelTool = input.sidePanelTool; }
  if ('newTabBackground' in input) { if (!member(NEW_TAB_BACKGROUNDS, input.newTabBackground)) throw new Error('Invalid New Tab background'); patch.newTabBackground = input.newTabBackground; }
  if ('showRecentOnNewTab' in input) {
    if (typeof input.showRecentOnNewTab !== 'boolean') throw new Error('Invalid New Tab history setting');
    patch.showRecentOnNewTab = input.showRecentOnNewTab;
  }
  for (const key of ['offerSetupGuide', 'importedChromeData'] as const) {
    if (!(key in input)) continue;
    if (typeof input[key] !== 'boolean') throw new Error('Invalid setup preference');
    patch[key] = input[key];
  }
  return patch;
}

export function mergeUiPreferences(current: UiPreferences, patch: UiPreferencesPatch): UiPreferences {
  return sanitizeUiPreferences({ ...current, ...patch });
}
