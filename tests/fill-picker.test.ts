import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FILL_PICKER_MAX_ROWS, orderFillCandidates, selectAutomaticFillEntry } from '../electron/myvault/automatic-fill';
import { workspaceVaultPolicy } from '../electron/myvault/workspace-policy';
import type { VaultEntryMetadata } from '../electron/myvault/vault-broker';
import type { FillContext } from '../electron/myvault/fill-capability';
import { FILL_PICKER_MANAGE_INDEX, FillPickerSessions, fillPickerBounds, fillPickerHeight, fillPickerHtml } from '../electron/myvault/fill-picker-model';
import { parseFocusedLoginField } from '../electron/myvault/isolated-fill';

function entry(id: string, updatedAt: string, hasPassword = true, url: string | null = 'https://example.test'): VaultEntryMetadata {
  return { id, title: id, type: 'login', username: `${id}@example.test`, url: url ?? undefined, favorite: false, hasPassword, hasTotp: false, updatedAt };
}

describe('login picker candidate order', () => {
  const entries = [
    entry('older', '2026-09-10T00:00:00.000Z'),
    entry('newest', '2026-09-14T00:00:00.000Z'),
    entry('middle', '2026-09-12T00:00:00.000Z'),
    entry('no-password', '2026-09-15T00:00:00.000Z', false),
    entry('no-url', '2026-09-15T00:00:00.000Z', true, null),
  ];

  it('lists only fillable logins, newest first', () => {
    expect(orderFillCandidates(entries).map((item) => item.id)).toEqual(['newest', 'middle', 'older']);
  });

  it('puts the login chosen earlier this session first and keeps the rest in order', () => {
    expect(orderFillCandidates(entries, 'older').map((item) => item.id)).toEqual(['older', 'newest', 'middle']);
    expect(orderFillCandidates(entries, 'no-password').map((item) => item.id)).toEqual(['newest', 'middle', 'older']);
  });

  it('keeps automatic fill choosing the same login the picker lists first', () => {
    expect(selectAutomaticFillEntry(entries)?.id).toBe(orderFillCandidates(entries)[0]?.id);
    expect(selectAutomaticFillEntry(entries, 'middle')?.id).toBe('middle');
    expect(selectAutomaticFillEntry([])).toBeUndefined();
  });

  it('treats unreadable timestamps as oldest and keeps source order for ties', () => {
    const ties = [entry('a', 'not a date'), entry('b', '2026-09-01T00:00:00.000Z'), entry('c', 'not a date')];
    expect(orderFillCandidates(ties).map((item) => item.id)).toEqual(['b', 'a', 'c']);
  });

  it('caps the visible list at a small number of rows', () => {
    expect(FILL_PICKER_MAX_ROWS).toBe(8);
  });
});

describe('login picker workspace policy', () => {
  it('is on in the everyday workspaces', () => {
    for (const workspace of ['personal', 'digitronics', 'tenten'] as const) {
      expect(workspaceVaultPolicy(workspace).fillPicker).toBe(true);
    }
  });

  it('is off in Banking, which confirms every fill, and in Development, which has no vault', () => {
    expect(workspaceVaultPolicy('banking').fillPicker).toBe(false);
    expect(workspaceVaultPolicy('development').fillPicker).toBe(false);
  });
});

describe('login picker session', () => {
  const context: FillContext = {
    webContentsId: 4, tabId: 'tab-a', navigationGeneration: 2, workspaceId: 'personal',
    accountSpaceId: '0c29cc4b-accc-448f-a7f3-8e985a83a38e' as FillContext['accountSpaceId'], origin: 'https://example.test',
  };
  const NONCE = 'n'.repeat(32);

  function opened(): FillPickerSessions {
    const sessions = new FillPickerSessions();
    sessions.open(context, ['entry-a', 'entry-b'], 77, NONCE);
    return sessions;
  }

  it('maps a row index back to the entry the main process listed', () => {
    expect(opened().take(77, NONCE, 1)).toEqual({ kind: 'entry', context, entryId: 'entry-b' });
  });

  it('turns the footer row into a request to open the vault panel', () => {
    expect(opened().take(77, NONCE, FILL_PICKER_MANAGE_INDEX)).toEqual({ kind: 'manage', context });
  });

  it('ignores a choice from any other view or with the wrong nonce', () => {
    const sessions = opened();
    expect(sessions.take(78, NONCE, 0)).toBeUndefined();
    expect(sessions.take(77, 'x'.repeat(32), 0)).toBeUndefined();
    expect(sessions.take(77, undefined, 0)).toBeUndefined();
    expect(sessions.take(77, NONCE, 0)?.kind).toBe('entry');
  });

  it('honours one choice only', () => {
    const sessions = opened();
    expect(sessions.take(77, NONCE, 0)).toBeDefined();
    expect(sessions.take(77, NONCE, 0)).toBeUndefined();
    expect(sessions.current).toBeUndefined();
  });

  it('consumes the session on an out-of-range or malformed index', () => {
    for (const index of [2, -2, 0.5, '0', null, Number.NaN]) {
      const sessions = opened();
      expect(sessions.take(77, NONCE, index)).toBeUndefined();
      expect(sessions.take(77, NONCE, 0)).toBeUndefined();
    }
  });

  it('chooses the keyboard-highlighted row through the same single-use path', () => {
    const sessions = opened();
    expect(sessions.takeIndex(0)).toEqual({ kind: 'entry', context, entryId: 'entry-a' });
    expect(sessions.takeIndex(0)).toBeUndefined();
  });

  it('has nothing to choose once cleared', () => {
    const sessions = opened();
    sessions.clear();
    expect(sessions.take(77, NONCE, 0)).toBeUndefined();
  });

  it('refuses a short nonce', () => {
    expect(() => new FillPickerSessions().open(context, ['entry-a'], 1, 'short')).toThrow();
  });
});

describe('login picker placement', () => {
  const page = { x: 0, y: 190, width: 1375, height: 860 };

  it('sits just under the field, as wide as the field', () => {
    const bounds = fillPickerBounds({ x: 338, y: 366, width: 400, height: 62 }, 1, page, 2)!;
    expect(bounds).toEqual({ x: 338, y: 190 + 366 + 62 + 4, width: 400, height: fillPickerHeight(2) });
  });

  it('scales with page zoom', () => {
    const bounds = fillPickerBounds({ x: 100, y: 100, width: 300, height: 40 }, 1.25, page, 1)!;
    expect(bounds.x).toBe(125);
    expect(bounds.y).toBe(190 + 175 + 4);
    expect(bounds.width).toBe(375);
  });

  it('flips above a field near the bottom and stays inside the page', () => {
    const bounds = fillPickerBounds({ x: 1300, y: 800, width: 200, height: 40 }, 1, page, 3)!;
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(190 + 800);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.width);
    expect(bounds.width).toBe(280);
  });

  it('is not shown for a field scrolled out of view or a page too small for the list', () => {
    expect(fillPickerBounds({ x: 0, y: -80, width: 300, height: 40 }, 1, page, 1)).toBeUndefined();
    expect(fillPickerBounds({ x: 0, y: 900, width: 300, height: 40 }, 1, page, 1)).toBeUndefined();
    expect(fillPickerBounds({ x: 0, y: 10, width: 300, height: 40 }, 1, { ...page, width: 200 }, 1)).toBeUndefined();
    expect(fillPickerBounds({ x: 0, y: 10, width: 300, height: 40 }, 1, { ...page, height: 60 }, 1)).toBeUndefined();
  });
});

describe('login picker markup', () => {
  it('escapes saved usernames and titles', () => {
    const html = fillPickerHtml([{ entryId: 'secret-id', username: '<img src=x onerror=alert(1)>', title: 't' }], 'cspnonce');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('never puts entry ids or anything password-like into the overlay', () => {
    const html = fillPickerHtml([{ entryId: 'secret-id-123', username: 'a@example.test', title: 'Example' }], 'cspnonce');
    expect(html).not.toContain('secret-id-123');
    expect(html).toContain("script-src 'nonce-cspnonce'");
  });

  it('labels a login saved without a username', () => {
    expect(fillPickerHtml([{ entryId: 'e', username: '', title: '' }], 'n')).toContain('No username');
  });
});

describe('focused login field probe result', () => {
  it('accepts only a known field kind with a real rectangle', () => {
    expect(parseFocusedLoginField({ kind: 'username', x: 1, y: 2, width: 3, height: 4 })).toEqual({ kind: 'username', rect: { x: 1, y: 2, width: 3, height: 4 } });
    expect(parseFocusedLoginField({ kind: 'otp', x: 1, y: 2, width: 3, height: 4 })).toBeUndefined();
    expect(parseFocusedLoginField({ kind: 'password', x: 1, y: 2, width: 0, height: 4 })).toBeUndefined();
    expect(parseFocusedLoginField({ kind: 'password', x: Number.NaN, y: 2, width: 3, height: 4 })).toBeUndefined();
    expect(parseFocusedLoginField(null)).toBeUndefined();
  });
});

describe('login picker preload', () => {
  it('exposes only row choice and highlight, never vault operations', () => {
    const preload = readFileSync(new URL('../electron/myvault/fill-picker-preload.cts', import.meta.url), 'utf8');
    const channels = [...preload.matchAll(/ipcRenderer\.(?:send|on|invoke)\('([^']+)'/g)].map((match) => match[1]);
    expect(channels.sort()).toEqual(['fill-picker:choose', 'fill-picker:highlight']);
    const code = preload.replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/vault:|resolveSecret|password/i);
  });
});
