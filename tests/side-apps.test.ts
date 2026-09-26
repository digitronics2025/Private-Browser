import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MIN_CHROME_TOP } from '../electron/chrome-layout';
import { validateIpcArguments } from '../electron/ipc-contracts';
import { clampSideAppBounds, isSideAppUrl, SIDE_APPS, sideAppDefinition } from '../electron/side-app-registry';
import { requireUiPreferencesPatch, sanitizeUiPreferences } from '../electron/ui-preferences';

const claude = SIDE_APPS.claude;

describe('side app navigation', () => {
  it('keeps Claude on its own sites and its sign-in providers', () => {
    for (const url of ['https://claude.ai/new', 'https://claude.ai/chat/abc', 'https://www.claude.ai/', 'https://support.anthropic.com/', 'https://accounts.google.com/o/oauth2/auth', 'https://appleid.apple.com/auth']) {
      expect(isSideAppUrl(claude, url), url).toBe(true);
    }
  });

  it('refuses every other host, plain HTTP, credentials and non-web schemes', () => {
    for (const url of [
      'https://example.com/', 'https://claude.ai.example.com/', 'https://evilclaude.ai/', 'https://mail.google.com/',
      'http://claude.ai/', 'https://user:pass@claude.ai/', 'file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,hi', 'not a url', // secret-guard:allow — a fake credential URL that must be refused
    ]) {
      expect(isSideAppUrl(claude, url), url).toBe(false);
    }
  });

  it('admits plain HTTP only for a loopback host a test listed', () => {
    const local = { hosts: ['127.0.0.1'] };
    expect(isSideAppUrl(local, 'http://127.0.0.1:4000/app')).toBe(true);
    expect(isSideAppUrl({ hosts: ['intranet.test'] }, 'http://intranet.test/')).toBe(false);
  });

  it('honours the test override only in an unpackaged build', () => {
    expect(sideAppDefinition('claude', false, 'http://127.0.0.1:4000/app')).toMatchObject({ homeUrl: 'http://127.0.0.1:4000/app', hosts: ['127.0.0.1'], partition: claude.partition });
    expect(sideAppDefinition('claude', true, 'http://127.0.0.1:4000/app')).toBe(claude);
    expect(sideAppDefinition('claude', false, 'file:///etc/passwd')).toBe(claude);
    expect(sideAppDefinition('claude', false, undefined)).toBe(claude);
  });

  it('uses a partition of its own, never an Account Space one', () => {
    expect(claude.partition).toMatch(/^persist:private-browser-side-app-/);
    expect(claude.partition).not.toMatch(/account/);
  });
});

describe('side app bounds', () => {
  const insets = { top: 122, left: 0, right: 400, bottom: 0 };

  it('passes a slot that sits inside the side panel', () => {
    expect(clampSideAppBounds({ x: 1101, y: 200, width: 399, height: 700 }, insets, 1500, 900)).toEqual({ x: 1101, y: 200, width: 399, height: 700 });
  });

  it('never lets the view cover the page, the toolbar or the window edge', () => {
    expect(clampSideAppBounds({ x: 0, y: 0, width: 5000, height: 5000 }, insets, 1500, 900)).toEqual({ x: 1100, y: 122, width: 400, height: 778 });
    const lowTop = clampSideAppBounds({ x: 1100, y: 0, width: 400, height: 900 }, { ...insets, top: 0 }, 1500, 900);
    expect(lowTop?.y).toBe(MIN_CHROME_TOP);
  });

  it('hides the view when the panel is closed or too small', () => {
    expect(clampSideAppBounds({ x: 1100, y: 200, width: 400, height: 700 }, { ...insets, right: 0 }, 1500, 900)).toBeNull();
    expect(clampSideAppBounds({ x: 1100, y: 850, width: 400, height: 50 }, insets, 1500, 900)).toBeNull();
  });
});

describe('side app channels', () => {
  it('validates ids, commands and bounds', () => {
    expect(() => validateIpcArguments('side-app:set-bounds', ['claude', { x: 1, y: 2, width: 3, height: 4 }])).not.toThrow();
    expect(() => validateIpcArguments('side-app:set-bounds', ['claude', null])).not.toThrow();
    expect(() => validateIpcArguments('side-app:command', ['claude', 'open-in-tab'])).not.toThrow();
    expect(() => validateIpcArguments('side-app:clear-data', ['claude'])).not.toThrow();
    for (const [channel, args] of [
      ['side-app:set-bounds', ['chatgpt', null]],
      ['side-app:set-bounds', ['claude', { x: 1, y: 2, width: 3 }]],
      ['side-app:set-bounds', ['claude', { x: 1, y: 2, width: 3, height: 4, url: 'https://x' }]],
      ['side-app:set-bounds', ['claude', { x: -1, y: 2, width: 3, height: 4 }]],
      ['side-app:set-bounds', ['claude', { x: Number.NaN, y: 2, width: 3, height: 4 }]],
      ['side-app:command', ['claude', 'navigate']],
      ['side-app:command', ['claude', 'reload', 'extra']],
      ['side-app:clear-data', []],
    ] as const) {
      expect(() => validateIpcArguments(channel, [...args]), `${channel} ${JSON.stringify(args)}`).toThrow();
    }
  });

  it('is exposed by the preload bridge and registered by the main process', () => {
    const preload = readFileSync(new URL('../electron/preload.cts', import.meta.url), 'utf8');
    const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
    for (const channel of ['side-app:set-bounds', 'side-app:command', 'side-app:clear-data']) {
      expect(preload).toContain(`'${channel}'`);
      expect(main).toContain(`handle('${channel}'`);
    }
  });

  it('gives the side app view no preload and no Node', () => {
    const host = readFileSync(new URL('../electron/side-apps.ts', import.meta.url), 'utf8');
    const preferences = host.slice(host.indexOf('new WebContentsView('), host.indexOf('runtime.view = view;'));
    expect(preferences).not.toContain('preload');
    expect(preferences).toContain('sandbox: true');
    expect(preferences).toContain('contextIsolation: true');
    expect(preferences).toContain('nodeIntegration: false');
  });
});

describe('Claude side panel preference', () => {
  it('is a valid side panel tool', () => {
    expect(requireUiPreferencesPatch({ sidePanelTool: 'claude' })).toEqual({ sidePanelTool: 'claude' });
    expect(sanitizeUiPreferences({ sidePanelTool: 'claude' }).sidePanelTool).toBe('claude');
  });
});
