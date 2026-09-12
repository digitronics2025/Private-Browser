import { contextBridge, ipcRenderer } from 'electron';
import type { SecureDialogKind, SecureDialogValue } from './secure-dialog-contract.js';

const nonceArgument = process.argv.find((value) => value.startsWith('--vault-dialog-nonce='));
const kindArgument = process.argv.find((value) => value.startsWith('--vault-dialog-kind='));
const nonce = nonceArgument?.slice('--vault-dialog-nonce='.length) ?? '';
const kind = (kindArgument?.slice('--vault-dialog-kind='.length) ?? '') as SecureDialogKind;
let used = false;

contextBridge.exposeInMainWorld('secureVault', {
  kind,
  submit(value: SecureDialogValue): void {
    if (used) return;
    used = true;
    ipcRenderer.send('vault-secure:submit', nonce, value);
  },
  cancel(): void {
    if (used) return;
    used = true;
    ipcRenderer.send('vault-secure:cancel', nonce);
  },
});
