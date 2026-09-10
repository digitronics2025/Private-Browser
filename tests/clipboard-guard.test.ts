import { describe, expect, it } from 'vitest';
import { ClipboardGuard, type ClipboardLike } from '../electron/clipboard-guard';

/** Electron 44 returns promises; older majors returned strings. Cover both. */
function fakeClipboard(mode: 'async' | 'sync') {
  const state = { text: '', cleared: 0 };
  const clipboard: ClipboardLike = {
    writeText(text) {
      state.text = text;
      return mode === 'async' ? Promise.resolve() : undefined;
    },
    readText() {
      return mode === 'async' ? Promise.resolve(state.text) : state.text;
    },
    clear() {
      state.text = '';
      state.cleared += 1;
    },
  };
  return { clipboard, state };
}

describe.each(['async', 'sync'] as const)('ClipboardGuard over a %s clipboard', (mode) => {
  it('clears a copied secret that is still on the clipboard', async () => {
    const { clipboard, state } = fakeClipboard(mode);
    const guard = new ClipboardGuard(clipboard);
    guard.copy('hunter2');
    expect(state.text).toBe('hunter2');
    expect(await guard.flush()).toBe(true);
    expect(state.text).toBe('');
    expect(state.cleared).toBe(1);
  });

  it('never destroys something the user copied afterwards', async () => {
    const { clipboard, state } = fakeClipboard(mode);
    const guard = new ClipboardGuard(clipboard);
    guard.copy('hunter2');
    clipboard.writeText('a shopping list');
    expect(await guard.flush()).toBe(false);
    expect(state.text).toBe('a shopping list');
    expect(state.cleared).toBe(0);
  });

  it('is safe to flush twice and when nothing was copied', async () => {
    const { clipboard, state } = fakeClipboard(mode);
    const guard = new ClipboardGuard(clipboard);
    expect(await guard.flush()).toBe(false);
    guard.copy('code-123');
    expect(await guard.flush()).toBe(true);
    expect(await guard.flush()).toBe(false);
    expect(state.cleared).toBe(1);
  });

  it('tracks only the most recent secret when one is copied over another', async () => {
    const { clipboard, state } = fakeClipboard(mode);
    const guard = new ClipboardGuard(clipboard);
    guard.copy('first');
    guard.copy('second');
    expect(await guard.flush()).toBe(true);
    expect(state.text).toBe('');
    expect(state.cleared).toBe(1);
  });

  it('clears on the hold deadline without holding the process open', async () => {
    const { clipboard, state } = fakeClipboard(mode);
    const guard = new ClipboardGuard(clipboard, 5);
    guard.copy('expires-soon');
    expect(guard.isPending).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(state.text).toBe('');
    expect(state.cleared).toBe(1);
    expect(guard.isPending).toBe(false);
  });
});

describe('ClipboardGuard failure handling', () => {
  it('leaves the clipboard alone when it cannot be read', async () => {
    const state = { cleared: 0 };
    const guard = new ClipboardGuard({
      writeText: () => undefined,
      readText: () => Promise.reject(new Error('clipboard unavailable')),
      clear: () => { state.cleared += 1; },
    });
    guard.copy('hunter2');
    expect(await guard.flush()).toBe(false);
    expect(state.cleared).toBe(0);
  });
});
