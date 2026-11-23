import { expect, it } from 'vitest';
import { resolveChromeUrl } from '../electron/trusted-chrome.js';

const bundled = 'file:///dist/index.html';

it('ignores the development URL in a packaged browser and only accepts loopback development', () => {
  expect(resolveChromeUrl(true, bundled, 'https://example.com')).toBe(bundled);
  expect(resolveChromeUrl(false, bundled, 'http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173/');
  expect(() => resolveChromeUrl(false, bundled, 'https://example.com')).toThrow(/loopback/);
});
