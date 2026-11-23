import { beforeEach, describe, expect, it, vi } from 'vitest';

const menuMock = vi.hoisted(() => ({ template: [] as Array<{ label?: string; click?: () => void }> }));
vi.mock('electron', () => ({
  clipboard: { writeText: vi.fn() },
  Menu: { buildFromTemplate: (template: Array<{ label?: string; click?: () => void }>) => {
    menuMock.template = template;
    return { popup: vi.fn() };
  } },
}));

import { showPageContextMenu } from '../electron/page-context-menu';

describe('page link context menu', () => {
  beforeEach(() => { menuMock.template = []; });

  it('offers a foreground tab and preserves the background action with a safe URL', () => {
    const foreground = vi.fn();
    const background = vi.fn();
    const frame = { url: 'https://shop.example/list', detached: false, frameTreeNodeId: 1 };
    const contents = { mainFrame: frame, focusedFrame: frame };
    showPageContextMenu(
      {} as never,
      contents as never,
      { frame, pageURL: frame.url, frameURL: frame.url, linkURL: 'https://shop.example/item?utm_source=ad&id=7',
        srcURL: '', mediaType: 'none', mediaFlags: { canSave: false }, selectionText: '', editFlags: {},
        formControlType: 'none', isEditable: false, misspelledWord: '', dictionarySuggestions: [], x: 0, y: 0,
      } as never,
      () => true,
      background,
      foreground,
      () => false,
    );
    expect(menuMock.template.map((item) => item.label)).toContain('Open link in new tab');
    expect(menuMock.template.map((item) => item.label)).toContain('Open link in background tab');
    menuMock.template.find((item) => item.label === 'Open link in new tab')?.click?.();
    menuMock.template.find((item) => item.label === 'Open link in background tab')?.click?.();
    expect(foreground).toHaveBeenCalledWith('https://shop.example/item?id=7');
    expect(background).toHaveBeenCalledWith('https://shop.example/item?id=7');
  });
});
