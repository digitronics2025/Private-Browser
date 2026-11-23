import { describe, expect, it } from 'vitest';
import { inspectBrowserExtensionManifest, manifestForAllowedOrigins } from '../electron/browser-extension-policy';

const base = {
  manifest_version: 3,
  name: 'Example helper',
  version: '1.2.0',
  permissions: ['storage'],
  host_permissions: ['https://shop.example/*', 'https://catalog.example/*'],
  content_scripts: [{ matches: ['https://shop.example/*', 'https://catalog.example/*'], js: ['content.js'] }],
};

describe('Private Browser extension policy', () => {
  it('reviews exact HTTPS sites and removes access that was not approved', () => {
    const review = inspectBrowserExtensionManifest(base);
    expect(review.review.requestedOrigins).toEqual(['https://catalog.example', 'https://shop.example']);
    const restricted = manifestForAllowedOrigins(review.manifest, ['https://shop.example']);
    expect(restricted.host_permissions).toEqual(['https://shop.example/*']);
    expect(restricted.content_scripts[0]?.matches).toEqual(['https://shop.example/*']);
  });

  it.each([
    ['all websites', { ...base, host_permissions: ['<all_urls>'] }],
    ['wildcard hosts', { ...base, host_permissions: ['https://*.example/*'] }],
    ['unencrypted sites', { ...base, host_permissions: ['http://shop.example/*'] }],
    ['browser data APIs', { ...base, permissions: ['cookies'] }],
    ['browser action UI', { ...base, action: { default_popup: 'popup.html' } }],
    ['unreviewed manifest fields', { ...base, icons: { 32: '../../outside.png' } }],
    ['page-world script execution', { ...base, content_scripts: [{ matches: ['https://shop.example/*'], js: ['content.js'], world: 'MAIN' }] }],
    ['Manifest V2', { ...base, manifest_version: 2 }],
  ])('rejects %s', (_label, manifest) => {
    expect(() => inspectBrowserExtensionManifest(manifest)).toThrow();
  });

  it('refuses grants outside the reviewed host set and unsafe script paths', () => {
    const review = inspectBrowserExtensionManifest(base);
    expect(() => manifestForAllowedOrigins(review.manifest, ['https://evil.example'])).toThrow(/changed/i);
    expect(() => inspectBrowserExtensionManifest({ ...base, content_scripts: [{ matches: ['https://shop.example/*'], js: ['../outside.js'] }] })).toThrow(/unsafe/i);
  });
});
