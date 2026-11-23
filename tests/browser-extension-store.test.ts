import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserExtensionStore } from '../electron/browser-extension-store';

const spaceA = '63e312ec-87f3-4f24-9a39-c5bb1397e771';
const spaceB = '0a6dd4f8-8a8a-49da-b99a-f191d2355e0b';
const roots: string[] = [];
const encryption = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`protected:${value}`),
  decryptString: (value: Buffer) => value.toString().replace(/^protected:/, ''),
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'private-browser-extension-'));
  roots.push(root);
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(join(source, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'Scoped helper',
    version: '1.0.0',
    permissions: ['storage'],
    host_permissions: ['https://shop.example/*'],
    content_scripts: [{ matches: ['https://shop.example/*'], js: ['content.js'] }],
  }));
  await writeFile(join(source, 'content.js'), 'document.documentElement.dataset.extensionTest = "loaded";');
  return { root, source, store: new BrowserExtensionStore(root, encryption) };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('BrowserExtensionStore', () => {
  it('copies reviewed code, encrypts each Account Space index, and isolates grants', async () => {
    const { root, source, store } = await fixture();
    const review = await store.inspect(source);
    const installed = await store.install(spaceA, review.reviewId, review.requestedOrigins);
    expect(installed.enabled).toBe(true);
    expect((await store.list(spaceB))).toEqual([]);
    const index = await readFile(join(root, 'browser-extensions', `${spaceA}.enc`), 'utf8');
    expect(index).not.toContain('shop.example');
    expect(index).not.toContain('Scoped helper');
    const spaceBReview = await store.inspect(source);
    await store.install(spaceB, spaceBReview.reviewId, []);
    expect((await store.list(spaceB))[0]?.enabled).toBe(false);
    expect((await store.list(spaceA))[0]?.allowedOrigins).toEqual(['https://shop.example']);
  });

  it('rejects changed package files after review', async () => {
    const { source, store } = await fixture();
    const review = await store.inspect(source);
    await writeFile(join(source, 'content.js'), 'changed after review');
    await expect(store.install(spaceA, review.reviewId, review.requestedOrigins)).rejects.toThrow(/changed during review/i);
  });

  it('loads only enabled code into the owning Account Space session with filtered site grants', async () => {
    const { root, source, store } = await fixture();
    const review = await store.inspect(source);
    const item = await store.install(spaceA, review.reviewId, review.requestedOrigins);
    const loaded: Array<{ path: string; id: string }> = [];
    const session = { extensions: {
      getAllExtensions: () => loaded.map((entry) => ({ path: entry.path, id: entry.id })),
      loadExtension: async (path: string) => { const value = { path, id: `electron-${loaded.length + 1}` }; loaded.push(value); return value; },
      removeExtension: () => undefined,
    } } as never;
    expect(await store.loadForSession(spaceA, session)).toEqual([]);
    expect(loaded).toHaveLength(1);
    const manifest = JSON.parse(await readFile(join(root, 'browser-extensions', spaceA, item.id, 'active', 'manifest.json'), 'utf8')) as { host_permissions: string[] };
    expect(manifest.host_permissions).toEqual(['https://shop.example/*']);

    const otherSpaceSession = { extensions: {
      getAllExtensions: () => [],
      loadExtension: async () => { throw new Error('Disabled extension must not load.'); },
      removeExtension: () => undefined,
    } } as never;
    const otherReview = await store.inspect(source);
    await store.install(spaceB, otherReview.reviewId, []);
    expect(await store.loadForSession(spaceB, otherSpaceSession)).toEqual([]);
  });
});
