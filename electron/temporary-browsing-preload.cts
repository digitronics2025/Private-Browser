import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('temporaryChrome', {
  command: (command: string, value?: string) => ipcRenderer.invoke('temporary:command', command, value),
  onState: (callback: (state: unknown) => void) => { ipcRenderer.on('temporary:state', (_event, state: unknown) => callback(state)); },
  onFocusAddress: (callback: () => void) => { ipcRenderer.on('temporary:focus-address', () => callback()); },
});
