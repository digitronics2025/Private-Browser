import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FillCapabilityStore, normalizedWebOrigin, type FillContext } from '../electron/myvault/fill-capability';
import { workspaceVaultPolicy } from '../electron/myvault/workspace-policy';

const context: FillContext = { webContentsId: 4, tabId: 'tab-a', navigationGeneration: 2, workspaceId: 'personal', origin: 'https://example.test' };

describe('single-use exact-origin vault fill capabilities', () => {
  it('binds to tab, WebContents, navigation, workspace, exact origin, entry, operation, and expiry', () => {
    let now = 10;
    const store = new FillCapabilityStore(() => now);
    const valid = store.issue(context, 'entry-a', 'fill-login');
    expect(() => store.redeem(valid, context, 'entry-a', 'fill-login')).not.toThrow();
    expect(() => store.redeem(valid, context, 'entry-a', 'fill-login')).toThrow('expired');
    const changed = store.issue(context, 'entry-a', 'fill-login');
    expect(() => store.redeem(changed, { ...context, navigationGeneration: 3 }, 'entry-a', 'fill-login')).toThrow('changed');
    const expired = store.issue(context, 'entry-a', 'fill-login');
    now += 10_001;
    expect(() => store.redeem(expired, context, 'entry-a', 'fill-login')).toThrow('expired');
  });

  it('refuses scheme downgrade, opaque origins, embedded credentials, and IDN lookalikes', () => {
    expect(normalizedWebOrigin('https://example.test/path')).toBe('https://example.test');
    expect(normalizedWebOrigin('https://example.test:444/path')).toBe('https://example.test:444');
    expect(normalizedWebOrigin('http://example.test')).toBe('http://example.test');
    expect(() => normalizedWebOrigin('data:text/html,x')).toThrow('HTTP');
    expect(() => normalizedWebOrigin('https://alice:secret@example.test')).toThrow('Credential'); // secret-guard:allow — inert parser fixture
    expect(() => normalizedWebOrigin('https://xn--pple-43d.example')).toThrow('lookalike');
  });
});

describe('isolated-world fill source', () => {
  it('uses no form submission primitive and targets recognized fields only', () => {
    const source = readFileSync(new URL('../electron/myvault/isolated-fill.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\.submit\s*\(|requestSubmit/);
    expect(source).toContain('executeJavaScriptInIsolatedWorld');
    expect(source).toContain('autocomplete="username"');
    expect(source).toContain('autocomplete="one-time-code"');
  });

  it('captures only after an explicit intent and excludes card and OTP autocomplete fields', () => {
    const source = readFileSync(new URL('../electron/myvault/isolated-fill.ts', import.meta.url), 'utf8');
    expect(source).toContain("'cc-number','cc-csc','cc-exp','one-time-code'");
    expect(source).not.toMatch(/addEventListener\(['"]submit/);
    expect(source).not.toMatch(/querySelectorAll\(['"]input['"]\)/);
  });
});

describe('central workspace vault policy', () => {
  it('hard-disables Banking extraction, capture, DevTools, extensions, and password clipboard', () => {
    expect(workspaceVaultPolicy('banking')).toEqual({
      vaultSurface: true, manualFill: true, saveCapture: false, passwordClipboard: false,
      requireFillConfirmation: true, aiExtraction: false, devTools: false, extensions: false, passkeys: false,
    });
  });

  it('isolates all vault operations from Development while preserving DevTools', () => {
    expect(workspaceVaultPolicy('development')).toMatchObject({ vaultSurface: false, manualFill: false, saveCapture: false, passwordClipboard: false, devTools: true, passkeys: false });
  });

  it.each(['digitronics', 'tenten', 'personal'] as const)('allows deliberate fill/save defaults in %s', (workspace) => {
    expect(workspaceVaultPolicy(workspace)).toMatchObject({ vaultSurface: true, manualFill: true, saveCapture: true, passwordClipboard: true, requireFillConfirmation: false });
  });
});
