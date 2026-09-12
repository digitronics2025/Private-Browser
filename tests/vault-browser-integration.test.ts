import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FillCapabilityStore, normalizedWebOrigin, type FillContext } from '../electron/myvault/fill-capability';
import { workspaceVaultPolicy } from '../electron/myvault/workspace-policy';
import { isAutomaticFillPageUrl, selectAutomaticFillEntry } from '../electron/myvault/automatic-fill';
import type { VaultEntryMetadata } from '../electron/myvault/vault-broker';

const context: FillContext = {
  webContentsId: 4,
  tabId: 'tab-a',
  navigationGeneration: 2,
  workspaceId: 'personal',
  accountSpaceId: '0c29cc4b-accc-448f-a7f3-8e985a83a38e' as FillContext['accountSpaceId'],
  origin: 'https://example.test',
};

describe('single-use exact-origin vault fill capabilities', () => {
  it('binds to tab, WebContents, navigation, workspace, exact origin, entry, operation, and expiry', () => {
    let now = 10;
    const store = new FillCapabilityStore(() => now);
    const valid = store.issue(context, 'entry-a', 'fill-login');
    expect(() => store.redeem(valid, context, 'entry-a', 'fill-login')).not.toThrow();
    expect(() => store.redeem(valid, context, 'entry-a', 'fill-login')).toThrow('expired');
    const changed = store.issue(context, 'entry-a', 'fill-login');
    expect(() => store.redeem(changed, { ...context, navigationGeneration: 3 }, 'entry-a', 'fill-login')).toThrow('changed');
    const crossedAccount = store.issue(context, 'entry-a', 'fill-login');
    expect(() => store.redeem(crossedAccount, { ...context, accountSpaceId: '6ba2c705-9ba8-4f4a-9af2-46f8a36f9fc4' as FillContext['accountSpaceId'] }, 'entry-a', 'fill-login')).toThrow('changed');
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

  it('keeps automatic fill empty-field-only, rejects new-password forms, and never submits', () => {
    const source = readFileSync(new URL('../electron/myvault/isolated-fill.ts', import.meta.url), 'utf8');
    expect(source).toContain("return 'occupied'");
    expect(source).toContain("return 'new-password-form'");
    expect(source).toContain('passwordFields.length !== 1');
    expect(source).not.toMatch(/\.submit\s*\(|requestSubmit/);
  });
});

describe('central workspace vault policy', () => {
  it('hard-disables Banking extraction, capture, DevTools, extensions, and password clipboard', () => {
    expect(workspaceVaultPolicy('banking')).toEqual({
      vaultSurface: true, manualFill: true, automaticFill: false, saveCapture: false, passwordClipboard: false,
      requireFillConfirmation: true, aiExtraction: false, devTools: false, extensions: false, passkeys: false,
    });
  });

  it('isolates all vault operations from Development while preserving DevTools', () => {
    expect(workspaceVaultPolicy('development')).toMatchObject({ vaultSurface: false, manualFill: false, automaticFill: false, saveCapture: false, passwordClipboard: false, devTools: true, passkeys: false });
  });

  it.each(['digitronics', 'tenten', 'personal'] as const)('allows deliberate fill/save defaults in %s', (workspace) => {
    expect(workspaceVaultPolicy(workspace)).toMatchObject({ vaultSurface: true, manualFill: true, automaticFill: true, saveCapture: true, passwordClipboard: true, requireFillConfirmation: false });
  });
});

describe('Chrome-style automatic fill decisions', () => {
  const entry = (id: string, updatedAt: string, hasPassword = true): VaultEntryMetadata => ({
    id,
    title: id,
    type: 'login',
    username: `${id}@example.test`,
    url: 'https://example.test',
    favorite: false,
    hasPassword,
    hasTotp: false,
    updatedAt,
  });

  it('allows normal HTTPS login URLs but excludes insecure and account-creation routes', () => {
    expect(isAutomaticFillPageUrl('https://example.test/login')).toBe(true);
    expect(isAutomaticFillPageUrl('https://example.test/sign-up?campaign=1')).toBe(false);
    expect(isAutomaticFillPageUrl('https://example.test/reset-password')).toBe(false);
    expect(isAutomaticFillPageUrl('http://example.test/login')).toBe(false);
  });

  it('uses a remembered manual choice, otherwise the newest eligible login', () => {
    const entries = [
      entry('older', '2026-01-01T00:00:00.000Z'),
      entry('newer', '2026-09-12T00:00:00.000Z'),
      entry('missing-secret', '2026-09-13T00:00:00.000Z', false),
    ];
    expect(selectAutomaticFillEntry(entries)?.id).toBe('newer');
    expect(selectAutomaticFillEntry(entries, 'older')?.id).toBe('older');
  });
});
