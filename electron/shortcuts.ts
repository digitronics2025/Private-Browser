/**
 * Keyboard shortcuts, defined once.
 *
 * A key press lands in one of two places: the trusted chrome renderer (when the
 * address bar or a panel has focus) or a web page's `webContents` (when a page
 * has focus). Both call `resolveShortcut` with the same input, so a shortcut can
 * no longer work in one half of the window and silently fail in the other. The
 * main process forwards what it resolves to the renderer, which runs every
 * command through one dispatcher.
 */

export type ShortcutCommand =
  | 'developer-tools'
  | 'focus-address'
  | 'new-tab'
  | 'close-tab'
  | 'reopen-closed-tab'
  | 'reload'
  | 'hard-reload'
  | 'back'
  | 'forward'
  | 'home'
  | 'next-tab'
  | 'previous-tab'
  | 'select-tab'
  | 'last-tab'
  | 'toggle-bookmark-bar'
  | 'bookmark-page'
  | 'bookmark-manager'
  | 'history'
  | 'downloads'
  | 'find'
  | 'print'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'fullscreen'
  | 'browser-menu'
  | 'tab-search'
  | 'clear-browsing-data'
  | 'next-account-space'
  | 'previous-account-space'
  /** No key: sent by the login picker's "Manage logins…" row. */
  | 'open-vault';

export interface Shortcut {
  command: ShortcutCommand;
  /** Zero-based tab index for `select-tab`. */
  index?: number;
}

export interface ShortcutInput {
  key: string;
  control: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
}

/** Commands whose result is a focused control in the chrome, so page focus must move there first. */
const CHROME_FOCUS_COMMANDS = new Set<ShortcutCommand>(['focus-address', 'find', 'browser-menu', 'tab-search', 'bookmark-manager', 'history', 'downloads', 'clear-browsing-data']);

export function needsChromeFocus(command: ShortcutCommand): boolean {
  return CHROME_FOCUS_COMMANDS.has(command);
}

export function resolveShortcut(input: ShortcutInput): Shortcut | undefined {
  const command = input.control || input.meta;
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  const plain = !command && !input.alt;

  if (key === 'F12' && !command && !input.alt) return { command: 'developer-tools' };
  if (key === 'F11' && plain && !input.shift) return { command: 'fullscreen' };
  if (key === 'F5' && !input.alt) return { command: command || input.shift ? 'hard-reload' : 'reload' };
  if (key === 'F6' && plain && !input.shift) return { command: 'focus-address' };

  if (input.alt && !command) {
    if (key === 'ArrowLeft' || key === 'Left') return input.shift ? undefined : { command: 'back' };
    if (key === 'ArrowRight' || key === 'Right') return input.shift ? undefined : { command: 'forward' };
    if (key === 'Home' && !input.shift) return { command: 'home' };
    if ((key === 'f' || key === 'e') && !input.shift) return { command: 'browser-menu' };
    if (key === 'd' && !input.shift) return { command: 'focus-address' };
    return undefined;
  }

  if (!command || input.alt) return undefined;

  if (input.shift) {
    switch (key) {
      case 'i': return { command: 'developer-tools' };
      case 'b': return { command: 'toggle-bookmark-bar' };
      case 'o': return { command: 'bookmark-manager' };
      case 't': return { command: 'reopen-closed-tab' };
      case 'a': return { command: 'tab-search' };
      case 'Delete': return { command: 'clear-browsing-data' };
      case 'Tab': return { command: 'previous-tab' };
      case 'ArrowRight': return { command: 'next-account-space' };
      case 'ArrowLeft': return { command: 'previous-account-space' };
      case 'r': return { command: 'hard-reload' };
      case '+': return { command: 'zoom-in' };
      case '_': return { command: 'zoom-out' };
      default: return undefined;
    }
  }

  switch (key) {
    case 'l': return { command: 'focus-address' };
    case 't': return { command: 'new-tab' };
    case 'w': case 'F4': return { command: 'close-tab' };
    case 'r': return { command: 'reload' };
    case 'd': return { command: 'bookmark-page' };
    case 'h': return { command: 'history' };
    case 'j': return { command: 'downloads' };
    case 'f': return { command: 'find' };
    case 'p': return { command: 'print' };
    case 'Tab': case 'PageDown': return { command: 'next-tab' };
    case 'PageUp': return { command: 'previous-tab' };
    case '=': case '+': return { command: 'zoom-in' };
    case '-': return { command: 'zoom-out' };
    case '0': return { command: 'zoom-reset' };
    case '9': return { command: 'last-tab' };
    default:
      if (/^[1-8]$/.test(key)) return { command: 'select-tab', index: Number(key) - 1 };
      return undefined;
  }
}
