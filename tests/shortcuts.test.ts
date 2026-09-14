import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { needsChromeFocus, resolveShortcut, type ShortcutInput } from '../electron/shortcuts';

const key = (value: string, modifiers: Partial<Omit<ShortcutInput, 'key'>> = {}): ShortcutInput => ({ key: value, control: false, meta: false, shift: false, alt: false, ...modifiers });

describe('keyboard shortcuts', () => {
  it('keeps the original browser shortcuts', () => {
    expect(resolveShortcut(key('l', { control: true }))).toEqual({ command: 'focus-address' });
    expect(resolveShortcut(key('t', { control: true }))).toEqual({ command: 'new-tab' });
    expect(resolveShortcut(key('w', { control: true }))).toEqual({ command: 'close-tab' });
    expect(resolveShortcut(key('r', { control: true }))).toEqual({ command: 'reload' });
    expect(resolveShortcut(key('F12'))).toEqual({ command: 'developer-tools' });
    expect(resolveShortcut(key('I', { control: true, shift: true }))).toEqual({ command: 'developer-tools' });
    expect(resolveShortcut(key('B', { control: true, shift: true }))).toEqual({ command: 'toggle-bookmark-bar' });
    expect(resolveShortcut(key('ArrowLeft', { alt: true }))).toEqual({ command: 'back' });
    expect(resolveShortcut(key('Left', { alt: true }))).toEqual({ command: 'back' });
    expect(resolveShortcut(key('ArrowRight', { control: true, shift: true }))).toEqual({ command: 'next-account-space' });
  });

  it('adds the standard safe Chrome shortcuts', () => {
    expect(resolveShortcut(key('Tab', { control: true }))).toEqual({ command: 'next-tab' });
    expect(resolveShortcut(key('Tab', { control: true, shift: true }))).toEqual({ command: 'previous-tab' });
    expect(resolveShortcut(key('3', { control: true }))).toEqual({ command: 'select-tab', index: 2 });
    expect(resolveShortcut(key('9', { control: true }))).toEqual({ command: 'last-tab' });
    expect(resolveShortcut(key('T', { control: true, shift: true }))).toEqual({ command: 'reopen-closed-tab' });
    expect(resolveShortcut(key('f', { control: true }))).toEqual({ command: 'find' });
    expect(resolveShortcut(key('=', { control: true }))).toEqual({ command: 'zoom-in' });
    expect(resolveShortcut(key('-', { control: true }))).toEqual({ command: 'zoom-out' });
    expect(resolveShortcut(key('0', { control: true }))).toEqual({ command: 'zoom-reset' });
    expect(resolveShortcut(key('F5'))).toEqual({ command: 'reload' });
    expect(resolveShortcut(key('F5', { control: true }))).toEqual({ command: 'hard-reload' });
    expect(resolveShortcut(key('F11'))).toEqual({ command: 'fullscreen' });
    expect(resolveShortcut(key('Delete', { control: true, shift: true }))).toEqual({ command: 'clear-browsing-data' });
    expect(resolveShortcut(key('f', { alt: true }))).toEqual({ command: 'browser-menu' });
  });

  it('leaves ordinary typing and page keys alone', () => {
    for (const input of [key('a'), key('l'), key('Escape'), key('ArrowLeft'), key('c', { control: true }), key('v', { control: true }), key('a', { control: true }), key('z', { control: true }), key('F4', { alt: true })]) {
      expect(resolveShortcut(input)).toBeUndefined();
    }
  });

  it('moves focus into the chrome only for commands that need it', () => {
    expect(needsChromeFocus('focus-address')).toBe(true);
    expect(needsChromeFocus('find')).toBe(true);
    expect(needsChromeFocus('reload')).toBe(false);
  });

  it('is the only shortcut table: both processes call it', () => {
    const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(main).toContain('resolveShortcut(');
    expect(app).toContain('resolveShortcut(');
    expect(main).not.toMatch(/command && key === 'l'/);
  });
});
