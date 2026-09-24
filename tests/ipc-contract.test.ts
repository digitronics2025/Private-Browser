import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSecureDialogValue } from '../electron/myvault/secure-dialog-contract';

describe('secure vault dialog contract', () => {
  it('accepts bounded unlock and editor values and reduces URLs to origins', () => {
    expect(parseSecureDialogValue('unlock', { password: 'test password' })).toEqual({ password: 'test password' });
    expect(parseSecureDialogValue('edit-login', { title: 'Site', url: 'https://example.test/path', username: 'alice', password: 'value' })).toMatchObject({ url: 'https://example.test' });
  });

  it('rejects oversized, insecure, malformed, and unconfirmed submissions', () => {
    expect(() => parseSecureDialogValue('unlock', { password: 'x'.repeat(1025) })).toThrow();
    expect(() => parseSecureDialogValue('edit-login', { title: 'Site', url: 'file:///tmp/x', username: 'alice', password: 'value' })).toThrow();
    expect(() => parseSecureDialogValue('pair', { endpoint: 'http://example.test', enrollmentCode: 'bad', password: 'value' })).toThrow();
    expect(() => parseSecureDialogValue('confirm-delete', { confirmed: false })).toThrow();
  });

  it('keeps secret-bearing arguments out of the ordinary preload contract', () => {
    const preload = readFileSync(new URL('../electron/preload.cts', import.meta.url), 'utf8');
    expect(preload).not.toMatch(/unlockVault:\s*\([^)]*password/);
    expect(preload).not.toMatch(/addVaultItem:\s*\([^)]*VaultItemInput/);
    expect(preload).not.toContain('resolveSecretForTrustedOperation');
  });
});

describe('browser settings channels', () => {
  it('validates the settings patch and takes no arguments for Home', async () => {
    const { validateIpcArguments } = await import('../electron/ipc-contracts');
    expect(() => validateIpcArguments('settings:set', [{ searchEngine: 'google' }])).not.toThrow();
    expect(() => validateIpcArguments('settings:set', [{ searchEngine: 'custom', customSearchTemplate: 'https://example.com/?q=%s' }])).not.toThrow();
    for (const args of [[], [{}], [{ searchEngine: 'yahoo' }], [{ searchEngine: 'custom', customSearchTemplate: 'http://x.test/?q=%s' }], [{ homePage: 'url' }], [{ startup: 'home' }, 'extra']]) {
      expect(() => validateIpcArguments('settings:set', args), JSON.stringify(args)).toThrow();
    }
    expect(() => validateIpcArguments('browser:home', [])).not.toThrow();
    expect(() => validateIpcArguments('browser:home', ['https://example.com'])).toThrow();
  });

  it('exposes both channels through the preload bridge and the main-process handlers', () => {
    const preload = readFileSync(new URL('../electron/preload.cts', import.meta.url), 'utf8');
    const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
    for (const channel of ['settings:set', 'browser:home']) {
      expect(preload).toContain(`'${channel}'`);
      expect(main).toContain(`handle('${channel}'`);
    }
  });
});
