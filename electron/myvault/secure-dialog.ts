import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { BrowserWindow, ipcMain, type BrowserWindowConstructorOptions } from 'electron';
import { parseSecureDialogValue, type SecureDialogKind, type SecureDialogValue } from './secure-dialog-contract.js';

interface PendingDialog {
  window: BrowserWindow;
  kind: SecureDialogKind;
  resolve: (value: SecureDialogValue | undefined) => void;
  used: boolean;
  timeout: NodeJS.Timeout;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}

function fields(kind: SecureDialogKind, origin?: string): string {
  if (kind === 'unlock') return '<label>Master password<input name="password" type="password" autocomplete="current-password" maxlength="1024" required autofocus></label>';
  if (kind === 'pair') return '<label>MyVault address<input name="endpoint" type="url" value="https://myvault.digitronics-electro.workers.dev" maxlength="2048" required></label><label>One-time enrollment code<input name="enrollmentCode" autocomplete="off" maxlength="128" required></label><label>Master password<input name="password" type="password" autocomplete="current-password" maxlength="1024" required></label>';
  if (kind === 'confirm-delete') return `<p class="warning">Delete this login from MyVault? This change will be encrypted immediately.</p><input name="confirmed" type="hidden" value="true">`;
  return `<label>Name<input name="title" maxlength="200" required autofocus></label><label>Website origin<input name="url" type="url" maxlength="2048" value="${escapeHtml(origin ?? '')}" required></label><label>Username or email<input name="username" maxlength="500" autocomplete="username" required></label><label>Password<input name="password" type="password" maxlength="5000" autocomplete="new-password" required></label><label>Authenticator secret (optional)<input name="totpSecret" type="password" maxlength="500" autocomplete="off"></label>`;
}

function html(kind: SecureDialogKind, nonce: string, origin?: string): string {
  const title = kind === 'unlock' ? 'Unlock MyVault' : kind === 'pair' ? 'Connect MyVault' : kind === 'confirm-delete' ? 'Confirm deletion' : 'Save in MyVault';
  const action = kind === 'confirm-delete' ? 'Delete login' : kind === 'unlock' ? 'Unlock' : kind === 'pair' ? 'Connect securely' : 'Encrypt and save';
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; form-action 'none'; base-uri 'none'"><meta name="viewport" content="width=device-width"><title>${title}</title><style nonce="${nonce}">:root{color-scheme:dark;font-family:system-ui;background:#0b0d12;color:#f7f8fb}body{margin:0;padding:28px}h1{font-size:22px;margin:0 0 8px}p{color:#aeb6c8;line-height:1.5}form{display:grid;gap:16px;margin-top:22px}label{display:grid;gap:7px;font-size:13px;color:#c9cfdb}input{box-sizing:border-box;width:100%;padding:11px 12px;border-radius:8px;border:1px solid #394052;background:#161a23;color:#fff}input:focus{outline:2px solid #818cf8;outline-offset:2px}.actions{display:flex;justify-content:flex-end;gap:10px;margin-top:8px}button{padding:10px 16px;border-radius:8px;border:0;font-weight:700;background:#252b38;color:#fff}button[type=submit]{background:#4f46e5}.danger button[type=submit]{background:#be123c}.warning{color:#fecdd3}</style></head><body><h1>${title}</h1><p>This isolated window sends its value directly to the trusted vault broker. Browser pages and the main interface cannot read it.</p><form class="${kind === 'confirm-delete' ? 'danger' : ''}">${fields(kind, origin)}<div class="actions"><button id="cancel" type="button">Cancel</button><button type="submit">${action}</button></div></form><script nonce="${nonce}">const form=document.querySelector('form');document.querySelector('#cancel').addEventListener('click',()=>window.secureVault.cancel());form.addEventListener('submit',(event)=>{event.preventDefault();const raw=Object.fromEntries(new FormData(form));if(raw.confirmed==='true')raw.confirmed=true;window.secureVault.submit(raw)});window.addEventListener('beforeunload',()=>window.secureVault.cancel())</script></body></html>`;
}

export class SecureVaultDialogs {
  private readonly pending = new Map<string, PendingDialog>();

  constructor(private readonly parent: () => BrowserWindow | undefined) {
    ipcMain.on('vault-secure:submit', (event, nonce: unknown, value: unknown) => this.finish(event.sender.id, nonce, value));
    ipcMain.on('vault-secure:cancel', (event, nonce: unknown) => this.cancel(event.sender.id, nonce));
  }

  open(kind: SecureDialogKind, origin?: string): Promise<SecureDialogValue | undefined> {
    const nonce = randomBytes(24).toString('base64url');
    const options: BrowserWindowConstructorOptions = {
      parent: this.parent(), modal: true, show: false, width: 500, height: kind === 'edit-login' ? 650 : 430,
      resizable: false, minimizable: false, maximizable: false, backgroundColor: '#0b0d12', title: 'MyVault',
      webPreferences: {
        preload: join(import.meta.dirname, 'secure-preload.cjs'), contextIsolation: true, sandbox: true,
        nodeIntegration: false, webSecurity: true, devTools: false,
        additionalArguments: [`--vault-dialog-nonce=${nonce}`, `--vault-dialog-kind=${kind}`],
      },
    };
    const window = new BrowserWindow(options);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    return new Promise((resolve) => {
      const timeout = setTimeout(() => this.settle(nonce, undefined), 120_000);
      timeout.unref();
      this.pending.set(nonce, { window, kind, resolve, used: false, timeout });
      window.on('closed', () => this.settle(nonce, undefined));
      void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html(kind, nonce, origin))}`).then(() => window.show());
    });
  }

  closeAll(): void {
    for (const nonce of [...this.pending.keys()]) this.settle(nonce, undefined);
  }

  private finish(senderId: number, nonce: unknown, value: unknown): void {
    if (typeof nonce !== 'string') return;
    const pending = this.pending.get(nonce);
    if (!pending || pending.used || pending.window.webContents.id !== senderId) return;
    pending.used = true;
    try {
      this.settle(nonce, parseSecureDialogValue(pending.kind, value));
    } catch {
      this.settle(nonce, undefined);
    }
  }

  private cancel(senderId: number, nonce: unknown): void {
    if (typeof nonce !== 'string') return;
    const pending = this.pending.get(nonce);
    if (pending?.window.webContents.id === senderId) this.settle(nonce, undefined);
  }

  private settle(nonce: string, value: SecureDialogValue | undefined): void {
    const pending = this.pending.get(nonce);
    if (!pending) return;
    this.pending.delete(nonce);
    clearTimeout(pending.timeout);
    if (!pending.window.isDestroyed()) pending.window.destroy();
    pending.resolve(value);
  }
}
