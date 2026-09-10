import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}));

import { readUpdateBootstrap } from '../electron/update-bootstrap';
import { UpdateServiceStore } from '../electron/update-service';

const input = {
  endpoint: 'https://private-browser-downloads.example.workers.dev',
  accessToken: 'test-token-that-is-long-enough-for-bootstrap',
};

describe('packaged update bootstrap', () => {
  it('reads the bounded generated configuration', () => {
    const directory = mkdtempSync(join(tmpdir(), 'private-browser-bootstrap-'));
    const path = join(directory, 'bootstrap.json');
    writeFileSync(path, JSON.stringify({ version: 1, ...input }));
    expect(readUpdateBootstrap(path)).toEqual(input);
  });

  it('imports once into encrypted storage and respects disconnect', () => {
    const directory = mkdtempSync(join(tmpdir(), 'private-browser-updates-'));
    const path = join(directory, 'updates.enc');
    const store = new UpdateServiceStore(path);
    expect(store.bootstrap(input, '0.3.1')).toBe(true);
    expect(store.status('0.3.1')).toMatchObject({ configured: true, endpoint: input.endpoint });
    expect(readFileSync(path, 'utf8')).not.toContain(input.accessToken);

    store.clear('0.3.1');
    const restarted = new UpdateServiceStore(path);
    expect(restarted.bootstrap(input, '0.3.1')).toBe(true);
    expect(restarted.status('0.3.1').configured).toBe(false);

    restarted.configure(input, '0.3.1');
    expect(restarted.status('0.3.1').configured).toBe(true);
  });
});
