import { describe, expect, it } from 'vitest';
import { mayReloadInactivePage, memorySaverExclusions, memorySaverOrigin } from '../electron/memory-saver';

const URL = 'https://reading.example.test/guide';
const eligible = { lastVisibleAt: 100, request: { url: URL, method: 'GET' } };

describe('Memory Saver policy', () => {
  it('requires inactivity and the exact observed GET', () => {
    expect(mayReloadInactivePage(eligible, URL, 5, 300_100)).toBe(true);
    expect(mayReloadInactivePage(eligible, URL, 5, 300_099)).toBe(false);
    expect(mayReloadInactivePage(eligible, URL, 0, 1_000_000)).toBe(false);
    expect(mayReloadInactivePage({ ...eligible, interacted: true }, URL, 5, 300_100)).toBe(false);
    expect(mayReloadInactivePage({ ...eligible, request: { url: URL, method: 'POST' } }, URL, 5, 300_100)).toBe(false);
    expect(mayReloadInactivePage(eligible, URL + '?reader=1', 5, 300_100)).toBe(false);
  });

  it('keeps only canonical exact origins and skips protected destinations', () => {
    expect(memorySaverOrigin('https://banking.example.test/')).toBeUndefined();
    expect(memorySaverExclusions(['https://reading.example.test', 'https://reading.example.test', URL, 'file:///'])).toEqual(['https://reading.example.test']);
  });
});
