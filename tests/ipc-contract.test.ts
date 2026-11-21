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

describe('Agent IPC parity', () => {
  it('registers each Agent preload invocation with explicit argument validation', async () => {
    const preload = readFileSync(new URL('../electron/preload.cts', import.meta.url), 'utf8');
    const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
    const commands = [...preload.matchAll(/ipcRenderer\.invoke\('(agents:[^']+)'/g)].map((match) => match[1]).sort();
    const handlers = [...main.matchAll(/handle\('(agents:[^']+)'/g)].map((match) => match[1]).sort();
    expect(commands).toHaveLength(21);
    expect(commands).toEqual(handlers);
    const { validateIpcArguments } = await import('../electron/ipc-contracts');
    const uuid = '8ad413e5-a5f1-47fd-9593-5255014d6018';
    expect(() => validateIpcArguments('agents:decide', [uuid, 'allow-all'])).toThrow();
    expect(() => validateIpcArguments('agents:decide', [uuid, 'deny'])).not.toThrow();
    expect(() => validateIpcArguments('agents:decide', [uuid, 'always'])).not.toThrow();
    const policy = { profile: 'operate', origins: [], outside: 'deny' };
    for (const session of ['1h', '8h', 'open']) {
      expect(() => validateIpcArguments('agents:set-policy', [uuid, { ...policy, session }])).not.toThrow();
    }
    expect(() => validateIpcArguments('agents:set-policy', [uuid, { ...policy, session: 'forever' }])).toThrow();
    expect(() => validateIpcArguments('agents:set-policy', [uuid, { ...policy, session: 'open', secret: true }])).toThrow();
  });
});

// F-49: the validator used to let every channel it did not list through.
describe('IPC argument validation covers every channel', () => {
  it('refuses an unknown channel and extra arguments on an argument-free one', async () => {
    const { validateIpcArguments } = await import('../electron/ipc-contracts');
    expect(() => validateIpcArguments('browser:not-a-channel', [])).toThrow('Unknown browser command');
    expect(() => validateIpcArguments('vault:lock', [])).not.toThrow();
    expect(() => validateIpcArguments('vault:lock', ['unexpected'])).toThrow();
    expect(() => validateIpcArguments('browser:switch-account-space', ['not-an-id'])).toThrow();
    expect(() => validateIpcArguments('vault:resolve-conflict', ['both'])).toThrow();
    expect(() => validateIpcArguments('browser:new-tab', [undefined, undefined, undefined])).not.toThrow();
  });
});

describe('reference search channel', () => {
  it('requires a bounded reference and exact reviewed HTTPS URL', async () => {
    const { validateIpcArguments } = await import('../electron/ipc-contracts');
    const input = {
      accountSpaceId: '31a6f3a4-7fa6-4447-a6dd-5108de80c3e4', keyword: 'stock', reference: 'LX/3',
      reviewedUrl: 'https://stock.example.test/search?q=LX%2F3',
    };
    for (const value of [
      { ...input, reviewedUrl: 'http://stock.example.test/search?q=LX%2F3' },
      { ...input, keyword: 'stock other' },
      { ...input, reference: 'x'.repeat(121) },
      { ...input, workspaceId: 'personal' },
    ]) expect(() => validateIpcArguments('routines:open-reference', [value])).toThrow();
    expect(() => validateIpcArguments('routines:open-reference', [input])).not.toThrow();
  });
});
