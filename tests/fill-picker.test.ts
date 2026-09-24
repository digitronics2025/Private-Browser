import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FILL_PICKER_MAX_ROWS, orderFillCandidates, selectAutomaticFillEntry } from '../electron/myvault/automatic-fill';
import { workspaceVaultPolicy } from '../electron/myvault/workspace-policy';
import type { VaultEntryMetadata } from '../electron/myvault/vault-broker';
import type { FillContext } from '../electron/myvault/fill-capability';
import { FILL_PICKER_ARM_DELAY_MS, FILL_PICKER_MANAGE_INDEX, FillPickerSessions, fillPickerBounds, fillPickerHeight, fillPickerHtml, isFillPickerChoiceArmed } from '../electron/myvault/fill-picker-model';
import { parseFocusedLoginField } from '../electron/myvault/isolated-fill';
import { FILL_PREFERENCE_MAX_SITES, FillPreferenceStore } from '../electron/myvault/fill-preferences';

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

  it('bounds the list only as a sanity limit, since it scrolls', () => {
    expect(FILL_PICKER_MAX_ROWS).toBe(50);
  });

  it('lists this exact address first, then other addresses of the same site', () => {
    const site = [
      entry('sibling-new', '2026-09-20T00:00:00.000Z', true, 'https://www.example.test'),
      entry('exact-old', '2026-09-01T00:00:00.000Z', true, 'https://example.test'),
      entry('exact-new', '2026-09-10T00:00:00.000Z', true, 'https://example.test'),
    ];
    expect(orderFillCandidates(site, undefined, 'https://example.test').map((item) => item.id)).toEqual(['exact-new', 'exact-old', 'sibling-new']);
    expect(orderFillCandidates(site, 'sibling-new', 'https://example.test').map((item) => item.id)).toEqual(['sibling-new', 'exact-new', 'exact-old']);
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

// F-34: a click already on its way when the list appeared (a double-click a
// page asked for) must not pick a row.
describe('login picker click arming', () => {
  it('ignores pointer choices until the list has been visible long enough to read', () => {
    expect(isFillPickerChoiceArmed(undefined, 10_000)).toBe(false);
    expect(isFillPickerChoiceArmed(10_000, 10_000)).toBe(false);
    expect(isFillPickerChoiceArmed(10_000, 10_000 + FILL_PICKER_ARM_DELAY_MS - 1)).toBe(false);
    expect(isFillPickerChoiceArmed(10_000, 10_000 + FILL_PICKER_ARM_DELAY_MS)).toBe(true);
  });

  it('checks arming in main before a choice is taken, not in the overlay page', () => {
    const source = readFileSync(join(process.cwd(), 'electron/myvault/fill-picker.ts'), 'utf8');
    const handler = source.slice(source.indexOf("ipcMain.on('fill-picker:choose'"), source.indexOf('get isOpen'));
    expect(handler.indexOf('isFillPickerChoiceArmed')).toBeGreaterThan(-1);
    expect(handler.indexOf('isFillPickerChoiceArmed')).toBeLessThan(handler.indexOf('this.sessions.take('));
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

  it('arms clicks after the same delay main enforces, without spending the one choice early', () => {
    const preload = readFileSync(new URL('../electron/myvault/fill-picker-preload.cts', import.meta.url), 'utf8');
    expect(Number(/ARM_DELAY_MS = (\d+)/.exec(preload)?.[1])).toBe(FILL_PICKER_ARM_DELAY_MS);
    const choose = preload.slice(preload.indexOf('choose(index'));
    expect(choose.indexOf('ARM_DELAY_MS')).toBeLessThan(choose.indexOf('used = true'));
  });
});

describe('login picker never covers the field', () => {
  const page = { x: 0, y: 190, width: 1375, height: 860 };
  const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  it('keeps clear of the field wherever it is and however many logins there are', () => {
    for (let fieldY = -20; fieldY < page.height; fieldY += 17) {
      for (const rows of [1, 2, 8, 12, 50]) {
        const field = { x: 338, y: fieldY, width: 700, height: 62 };
        const bounds = fillPickerBounds(field, 1, page, rows);
        if (!bounds) continue;
        const fieldInWindow = { x: page.x + field.x, y: page.y + field.y, width: field.width, height: field.height };
        expect(overlaps(bounds, fieldInWindow), `field y ${fieldY}, ${rows} rows`).toBe(false);
        expect(bounds.y).toBeGreaterThanOrEqual(page.y);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(page.y + page.height);
        expect(bounds.height).toBeGreaterThanOrEqual(fillPickerHeight(1));
      }
    }
  });

  it('shrinks to the larger side and scrolls when the full list fits nowhere', () => {
    // Eight logins, more room below than above, but not enough for all of them.
    const bounds = fillPickerBounds({ x: 338, y: 200, width: 700, height: 62 }, 1, { ...page, height: 700 }, 8)!;
    expect(bounds.height).toBeLessThan(fillPickerHeight(8));
    expect(bounds.y).toBe(190 + 200 + 62 + 4);
    expect(bounds.y + bounds.height).toBe(190 + 700);
  });

  it('goes above when there is more room there', () => {
    const bounds = fillPickerBounds({ x: 10, y: 600, width: 300, height: 40 }, 1, { ...page, height: 700 }, 20)!;
    expect(bounds.y + bounds.height).toBe(190 + 600 - 4);
    expect(bounds.y).toBe(190);
  });

  it('is not shown when neither side holds a row and the footer', () => {
    expect(fillPickerBounds({ x: 10, y: 60, width: 300, height: 40 }, 1, { ...page, height: 160 }, 3)).toBeUndefined();
  });
});

describe('login picker markup for a long list', () => {
  it('is sized so a list that fits shows no scrollbar', () => {
    // rows + footer + padding + the 1px frame, top and bottom
    expect(fillPickerHeight(2)).toBe(2 * 52 + 44 + 2 * 6 + 2);
  });

  it('scrolls the rows and keeps "Manage logins" pinned', () => {
    const html = fillPickerHtml([{ entryId: 'e', username: 'a@example.test', title: 't' }], 'n');
    expect(html).toContain('overflow-y:auto');
    expect(html).toContain("scrollIntoView({block:'nearest'})");
    expect(html).toContain('.manage{flex:none');
  });

  it('shows, escaped, the address a same-site login was saved for', () => {
    const html = fillPickerHtml([{ entryId: 'e', username: 'a@example.test', title: 't', savedFor: '<b>www.example.test</b>' }], 'n');
    expect(html).toContain('&lt;b&gt;www.example.test&lt;/b&gt;');
    expect(html).not.toContain('<b>www.example.test');
    expect(html).not.toContain('saved password');
  });
});

describe('remembered login per site', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fill-preferences-'));
  const storage = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (value: Buffer) => {
      const text = value.toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('bad');
      return text.slice(4);
    },
  };
  let counter = 0;
  const file = () => join(directory, `prefs-${counter += 1}.enc`);

  it('is shared by every address of a site and survives a restart', () => {
    const path = file();
    new FillPreferenceStore(path, storage).remember('https://admin.digitronics.ma', 'entry-b');
    const reloaded = new FillPreferenceStore(path, storage);
    expect(reloaded.get('https://digitronics.ma')).toBe('entry-b');
    expect(reloaded.get('https://www.digitronics.ma')).toBe('entry-b');
    expect(reloaded.get('https://evil.co.ma')).toBeUndefined();
  });

  it('keeps IP addresses to their exact origin', () => {
    const store = new FillPreferenceStore(file(), storage);
    store.remember('https://127.0.0.1:8443', 'entry-ip');
    expect(store.get('https://127.0.0.1:8443')).toBe('entry-ip');
    expect(store.get('https://127.0.0.1:9443')).toBeUndefined();
  });

  it('writes only ciphertext, and nothing at all without OS encryption', () => {
    const path = file();
    new FillPreferenceStore(path, storage).remember('https://digitronics.ma', 'entry-a');
    expect(Buffer.from(readFileSync(path, 'utf8'), 'base64').toString('utf8').startsWith('enc:')).toBe(true);
    const plainPath = file();
    const memoryOnly = new FillPreferenceStore(plainPath, { ...storage, isEncryptionAvailable: () => false });
    memoryOnly.remember('https://digitronics.ma', 'entry-a');
    expect(memoryOnly.get('https://digitronics.ma')).toBe('entry-a');
    expect(existsSync(plainPath)).toBe(false);
  });

  it('starts empty from an unreadable file', () => {
    const path = file();
    writeFileSync(path, 'not ciphertext', 'utf8');
    expect(new FillPreferenceStore(path, storage).get('https://digitronics.ma')).toBeUndefined();
  });

  it('forgets the oldest site beyond the cap', () => {
    let now = 0;
    const store = new FillPreferenceStore(file(), { ...storage, isEncryptionAvailable: () => false }, () => (now += 1));
    for (let index = 0; index <= FILL_PREFERENCE_MAX_SITES; index += 1) store.remember(`https://site${index}.com`, `entry-${index}`);
    expect(store.get('https://site0.com')).toBeUndefined();
    expect(store.get('https://site1.com')).toBe('entry-1');
    expect(store.get(`https://site${FILL_PREFERENCE_MAX_SITES}.com`)).toBe(`entry-${FILL_PREFERENCE_MAX_SITES}`);
  });
});
