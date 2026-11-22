import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('privatePdfPreview', {
  load: (receive: (bytes: Uint8Array) => void) => {
    ipcRenderer.once('protected-pdf:document', (_event, bytes: Uint8Array) => receive(bytes));
    ipcRenderer.send('protected-pdf:ready');
  },
});
