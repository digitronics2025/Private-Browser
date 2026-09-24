import { contextBridge, ipcRenderer } from 'electron';

// The login picker overlay can only point at a row. It never sees an entry id,
// a password or the page, and each view is good for one choice.
const nonceArgument = process.argv.find((value) => value.startsWith('--fill-picker-nonce='));
const nonce = nonceArgument?.slice('--fill-picker-nonce='.length) ?? '';
let used = false;

contextBridge.exposeInMainWorld('fillPicker', {
  choose(index: number): void {
    if (used || typeof index !== 'number') return;
    used = true;
    ipcRenderer.send('fill-picker:choose', nonce, index);
  },
  onHighlight(callback: (index: number) => void): void {
    ipcRenderer.on('fill-picker:highlight', (_event, index: unknown) => {
      if (typeof index === 'number') callback(index);
    });
  },
});
