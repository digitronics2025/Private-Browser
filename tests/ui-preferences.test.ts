import { describe, expect, it } from 'vitest';
import { DEFAULT_UI_PREFERENCES, mergeUiPreferences, requireUiPreferencesPatch, sanitizeUiPreferences } from '../electron/ui-preferences';
import { sanitizeShortcutTiles, validateAccountState, validateManifest } from '../electron/account-space-state';
import { validateIpcArguments } from '../electron/ipc-contracts';
import type { AccountBrowsingStateV2, AccountSpaceId, BrowserStateManifestV2 } from '../electron/types';

const ID = '0c29cc4b-accc-448f-a7f3-8e985a83a38e' as AccountSpaceId;

describe('interface preferences', () => {
  it('starts with the side panel closed and migrates the old bookmarks bar flag', () => {
    expect(DEFAULT_UI_PREFERENCES.sidePanelOpen).toBe(false);
    expect(sanitizeUiPreferences(undefined, false).bookmarkBarMode).toBe('hidden');
    expect(sanitizeUiPreferences(undefined, true).bookmarkBarMode).toBe('always');
    expect(sanitizeUiPreferences({ bookmarkBarMode: 'new-tab' }, false).bookmarkBarMode).toBe('new-tab');
  });

  it('falls back to defaults for hostile values on disk instead of failing', () => {
    expect(sanitizeUiPreferences({ theme: '<img>', sidePanelWidth: 99999, sidePanelTool: 'shell', newTabBackground: 42, sidePanelOpen: 'yes' })).toEqual({ ...DEFAULT_UI_PREFERENCES, sidePanelWidth: 520 });
    expect(sanitizeUiPreferences(['theme'])).toEqual(DEFAULT_UI_PREFERENCES);
  });

  it('rejects malformed IPC patches outright', () => {
    expect(requireUiPreferencesPatch({ theme: 'dark', sidePanelWidth: 100 })).toEqual({ theme: 'dark', sidePanelWidth: 320 });
    for (const bad of [null, [], {}, { theme: 'neon' }, { sidePanelOpen: 1 }, { sidePanelWidth: Number.POSITIVE_INFINITY }, { __proto__: { theme: 'dark' }, extra: true }, { sidePanelTool: 'terminal' }]) {
      expect(() => requireUiPreferencesPatch(bad)).toThrow();
    }
    expect(mergeUiPreferences(DEFAULT_UI_PREFERENCES, { sidePanelOpen: true }).sidePanelOpen).toBe(true);
  });

  it('round-trips through the saved manifest and keeps the legacy flag for older builds', () => {
    const manifest = {
      version: 2,
      activeWorkspaceId: 'digitronics',
      accountSpaceIds: ['122b503d-a1b3-497a-a610-e193af8d0702', 'e42a64d9-9193-47a2-a442-b820660966a1', 'a04aeaa5-497d-4d5f-9da0-8d00331fa7ee', ID, '6ef65669-2112-4cf2-a5e0-dfd4b3f45034'],
      activeAccountSpaceByWorkspace: { digitronics: '122b503d-a1b3-497a-a610-e193af8d0702', tenten: 'e42a64d9-9193-47a2-a442-b820660966a1', development: 'a04aeaa5-497d-4d5f-9da0-8d00331fa7ee', personal: ID, banking: '6ef65669-2112-4cf2-a5e0-dfd4b3f45034' },
      trackerBlocking: true,
      bookmarkBarVisible: true,
      privacyLog: [],
      ui: { ...DEFAULT_UI_PREFERENCES, bookmarkBarMode: 'hidden', theme: 'light' },
    } as unknown as BrowserStateManifestV2;
    const validated = validateManifest(manifest);
    expect(validated.ui).toMatchObject({ bookmarkBarMode: 'hidden', theme: 'light' });
    expect(validated.bookmarkBarVisible).toBe(false);
  });
});

describe('New Tab shortcuts', () => {
  it('accepts only web addresses and bounded lists', () => {
    expect(sanitizeShortcutTiles(undefined)).toBeUndefined();
    const tiles = sanitizeShortcutTiles([
      { id: 'a', title: 'Ok', url: 'https://example.com/' },
      { id: 'b', title: 'Script', url: 'javascript:alert(1)' },
      { id: 'c', title: 'File', url: 'file:///C:/Windows' },
      { id: 'a', title: 'Duplicate', url: 'https://example.org/' },
    ]);
    expect(tiles).toEqual([{ id: 'a', title: 'Ok', url: 'https://example.com/' }]);
    expect(sanitizeShortcutTiles(Array.from({ length: 30 }, (_, index) => ({ id: `t${index}`, title: 't', url: 'https://example.com/' })))).toHaveLength(12);
  });

  it('survives account state validation', () => {
    const state: AccountBrowsingStateV2 = { version: 2, accountSpaceId: ID, workspaceId: 'personal', tabs: [], activeTabId: '', bookmarks: [], history: [], shortcuts: [{ id: 'x', title: 'Mail', url: 'https://mail.example.com/' }] };
    expect(validateAccountState(state).shortcuts).toEqual([{ id: 'x', title: 'Mail', url: 'https://mail.example.com/' }]);
    expect('shortcuts' in validateAccountState({ ...state, shortcuts: undefined })).toBe(false);
  });

  it('is validated at the IPC boundary', () => {
    expect(() => validateIpcArguments('shortcuts:set', [ID, [{ id: 'x', title: 'Bad', url: 'javascript:alert(1)' }]])).toThrow();
    expect(() => validateIpcArguments('shortcuts:set', [ID, null])).not.toThrow();
    expect(() => validateIpcArguments('ui:set-preferences', [{ theme: 'dark' }])).not.toThrow();
    expect(() => validateIpcArguments('ui:set-preferences', [{ theme: 'dark' }, 'extra'])).toThrow();
    expect(() => validateIpcArguments('browser:set-layout', [{ top: 122, left: 0, right: Number.NaN, bottom: 0 }])).toThrow();
    expect(() => validateIpcArguments('browser:set-layout', [{ top: 122, left: 0, right: 400, bottom: 0 }])).not.toThrow();
    expect(() => validateIpcArguments('bookmarks:move', [{ location: 'bar', path: [] }, { kind: 'folder', name: 'Work' }, 2])).not.toThrow();
    expect(() => validateIpcArguments('bookmarks:move', [{ location: 'desktop', path: [] }, { kind: 'folder', name: 'Work' }, 2])).toThrow();
    expect(() => validateIpcArguments('bookmarks:move', [{ location: 'bar', path: [] }, { kind: 'folder', name: 'Work' }, -1])).toThrow();
    expect(() => validateIpcArguments('bookmarks:rename', ['id', '   '])).toThrow();
    expect(() => validateIpcArguments('browser:zoom', ['sideways'])).toThrow();
    expect(() => validateIpcArguments('browser:find', ['x'.repeat(1001), true, true])).toThrow();
    expect(() => validateIpcArguments('browser:move-tab', ['tab', 1.5])).toThrow();
  });
});
