import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountStore, type SafeStorageAdapter } from '../electron/account-store';
import { AccountPermissionManager } from '../electron/account-permissions';
import type { AccountSpaceId } from '../electron/types';

class TestEncryption implements SafeStorageAdapter {
  isEncryptionAvailable(): boolean { return true; }
  encryptString(value: string): Buffer { return Buffer.from(value).reverse(); }
  decryptString(value: Buffer): string { return Buffer.from(value).reverse().toString(); }
}

const ID = '122b503d-a1b3-497a-a610-e193af8d0702' as AccountSpaceId;
const SECOND_ID = '6ba2c705-9ba8-4f4a-9af2-46f8a36f9fc4' as AccountSpaceId;

function fixture(workspaceId: 'personal' | 'banking' = 'personal') {
  let now = new Date('2026-09-12T10:00:00Z');
  const store = new AccountStore(mkdtempSync(join(tmpdir(), 'permissions-')), new TestEncryption(), () => now);
  store.createLocal({ id: ID, workspaceId, label: 'Account', color: 'indigo', order: 0 });
  return { store, manager: new AccountPermissionManager(store, () => now), advance: () => { now = new Date(now.getTime() + 61_000); } };
}

describe('Account Space exact-origin permissions', () => {
  it('denies Banking before consulting an encrypted always grant', () => {
    const { store, manager } = fixture('banking');
    store.update(ID, (record) => record.permissionGrants.push({ origin: 'https://meet.google.com', capability: 'camera' }));
    expect(manager.evaluate(ID, 'banking', 'https://meet.google.com', 'camera')).toBe('denied');
  });

  it('limits notifications and capture to exact service origins', () => {
    const { manager } = fixture();
    expect(manager.evaluate(ID, 'personal', 'https://mail.google.com', 'notifications')).toBe('prompt');
    expect(manager.evaluate(ID, 'personal', 'https://evil.example', 'notifications')).toBe('denied');
    expect(manager.evaluate(ID, 'personal', 'https://meet.google.com', 'camera-and-microphone')).toBe('prompt');
    expect(manager.evaluate(ID, 'personal', 'https://accounts.google.com', 'camera')).toBe('denied');
    expect(manager.evaluate(ID, 'personal', 'https://maps.google.com', 'geolocation')).toBe('denied');
  });

  it('makes allow-once single-use and prompt IDs replay-proof', () => {
    const { manager } = fixture();
    const prompt = manager.createPrompt(ID, 'personal', 'https://meet.google.com', 'display-capture');
    expect(manager.applyDecision(prompt, 'allow-once', true)).toBe(true);
    expect(manager.evaluate(ID, 'personal', 'https://meet.google.com', 'display-capture')).toBe('granted');
    expect(manager.evaluate(ID, 'personal', 'https://meet.google.com', 'display-capture')).toBe('prompt');
    expect(() => manager.applyDecision(prompt, 'allow-once')).toThrow(/already used/);
  });

  it('keeps session grants in memory and always grants in only that account record', () => {
    const { store, manager } = fixture();
    const sessionPrompt = manager.createPrompt(ID, 'personal', 'https://example.com', 'clipboard-write');
    manager.applyDecision(sessionPrompt, 'allow-session');
    expect(manager.evaluate(ID, 'personal', 'https://example.com', 'clipboard-write')).toBe('granted');
    manager.clearAccount(ID);
    expect(manager.evaluate(ID, 'personal', 'https://example.com', 'clipboard-write')).toBe('prompt');

    const persistentPrompt = manager.createPrompt(ID, 'personal', 'https://example.com', 'file-system');
    manager.applyDecision(persistentPrompt, 'allow-always');
    expect(store.require(ID).permissionGrants).toEqual([{ origin: 'https://example.com', capability: 'file-system' }]);
    store.createLocal({ id: SECOND_ID, workspaceId: 'personal', label: 'Second', color: 'sky', order: 1 });
    expect(manager.evaluate(SECOND_ID, 'personal', 'https://example.com', 'file-system')).toBe('prompt');
  });

  it('expires unresolved prompts', () => {
    const { manager, advance } = fixture();
    const prompt = manager.createPrompt(ID, 'personal', 'https://calendar.google.com', 'notifications');
    advance();
    expect(() => manager.applyDecision(prompt, 'allow-once')).toThrow(/expired/);
  });

  it('requires an active visible Meet main frame and a fresh source picker', () => {
    const source = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
    expect(source).toContain("origin !== 'https://meet.google.com'");
    expect(source).toContain('!activeView?.getVisible()');
    expect(source).toContain('request.frame !== activeView.webContents.mainFrame');
    expect(source).toContain("desktopCapturer.getSources({ types: ['screen', 'window']");
    expect(source).toContain('sources.find((candidate) => candidate.id === sourceId)');
    expect(source).toContain('{ useSystemPicker: false }');
  });
});
