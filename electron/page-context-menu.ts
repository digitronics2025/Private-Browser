import { clipboard, Menu, type BrowserWindow, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from 'electron';
import { isAllowedRemoteUrl, isProtectedPage, stripTrackingParameters } from './security.js';

export function showPageContextMenu(
  window: BrowserWindow,
  contents: WebContents,
  params: ContextMenuParams,
  sourceStillActive: () => boolean,
  openInBackground: (url: string) => void,
  openInForeground: (url: string) => void,
  canInspect: () => boolean,
  saveSelectionToNotes?: (selection: string) => void,
): void {
  const frame = params.frame;
  if (!frame || !isAllowedRemoteUrl(params.pageURL) || !isAllowedRemoteUrl(params.frameURL || params.pageURL)
    || isProtectedPage(params.pageURL) || isProtectedPage(params.frameURL || params.pageURL) || !sourceStillActive()) return;
  const frameUrl = frame.url;
  const ownFrame = () => sourceStillActive() && !frame.detached && frame.url === frameUrl;
  const editFrame = () => ownFrame() && contents.focusedFrame?.frameTreeNodeId === frame.frameTreeNodeId;
  const item = (label: string, action: () => void, canRun = ownFrame): MenuItemConstructorOptions => ({
    label,
    click: () => { if (canRun()) action(); },
  });

  const links: MenuItemConstructorOptions[] = [];
  if (params.linkURL.length <= 4096 && isAllowedRemoteUrl(params.linkURL)) {
    const url = stripTrackingParameters(params.linkURL);
    links.push(item('Open link in new tab', () => openInForeground(url)));
    links.push(item('Open link in background tab', () => openInBackground(url)));
    links.push(item('Copy link address', () => clipboard.writeText(url)));
  }
  if (params.mediaType === 'image' && params.mediaFlags.canSave && params.srcURL.length <= 4096 && isAllowedRemoteUrl(params.srcURL)) {
    links.push(item('Save image', () => contents.downloadURL(params.srcURL)));
  }

  const editing: MenuItemConstructorOptions[] = [];
  const password = params.formControlType === 'input-password';
  if (!password && params.selectionText && params.editFlags.canCopy) editing.push(item('Copy selected text', () => contents.copy(), editFrame));
  if (saveSelectionToNotes && !params.isEditable && params.selectionText.trim() && frame === contents.mainFrame) {
    editing.push(item('Save selected text to Notes…', () => saveSelectionToNotes(params.selectionText)));
  }
  if (params.isEditable) editing.push({ ...item('Paste', () => contents.paste(), editFrame), enabled: params.editFlags.canPaste });
  if (!password && params.isEditable && params.misspelledWord) {
    for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
      // Ampersands are accelerators on Windows. A suggestion is always literal.
      editing.push(item(suggestion.replaceAll('&', '&&'), () => contents.replaceMisspelling(suggestion), editFrame));
    }
  }

  const development: MenuItemConstructorOptions[] = [];
  if (canInspect()) {
    development.push(item('Inspect element', () => {
      contents.inspectElement(params.x, params.y);
      if (!contents.isDevToolsOpened()) contents.openDevTools({ mode: 'right', activate: true });
    }, () => ownFrame() && canInspect()));
    development.push(item('Reload', () => contents.reload()));
  }

  const menu: MenuItemConstructorOptions[] = [];
  for (const section of [links, editing, development]) {
    if (!section.length) continue;
    if (menu.length) menu.push({ type: 'separator' });
    menu.push(...section);
  }
  if (menu.length) Menu.buildFromTemplate(menu).popup({ window, frame, sourceType: params.menuSourceType });
}
