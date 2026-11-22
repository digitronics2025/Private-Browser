import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { BrowserWindow, ipcMain, type BrowserWindowConstructorOptions } from 'electron';
import { normalizeAuthenticatorSecret, parseSecureDialogValue, SECURE_CREDENTIAL_PRESETS, type SecureCredentialPreset, type SecureDialogKind, type SecureDialogValue } from './secure-dialog-contract.js';

type GenerateCredential = (preset: SecureCredentialPreset) => string;
interface LoginLabel { title: string; username: string }

interface PendingDialog {
  window: BrowserWindow;
  kind: SecureDialogKind;
  resolve: (value: SecureDialogValue | undefined) => void;
  used: boolean;
  timeout: NodeJS.Timeout;
  generate?: GenerateCredential;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}

function generatorFields(): string {
  const options = Object.entries(SECURE_CREDENTIAL_PRESETS)
    .map(([key, preset]) => `<option value="${key}">${escapeHtml(preset.label)}</option>`).join('');
  return `<details><summary>Generate a credential</summary><label>Preset<select id="credential-preset">${options}</select></label><button id="generate-credential" type="button">Generate</button><p id="generation-status" role="status"></p></details>`;
}

const generatorScript = `
const password = form.elements.namedItem('password');
const generate = document.querySelector('#generate-credential');
const preset = document.querySelector('#credential-preset');
const status = document.querySelector('#generation-status');
const save = form.querySelector('[type=submit]');
password.addEventListener('input', () => {
  save.textContent = 'Encrypt and save';
  status.textContent = '';
});
generate.addEventListener('click', async () => {
  generate.disabled = true;
  save.disabled = true;
  status.textContent = '';
  try {
    password.value = await window.secureVault.generate(preset.value);
    save.textContent = 'Save generated login';
    status.textContent = 'Credential generated in this editor. Save when the login details are ready.';
  } catch {
    status.textContent = 'Could not generate a credential for this page. Check that MyVault is unlocked and the current page is secure.';
  } finally {
    generate.disabled = false;
    save.disabled = false;
  }
});
`;

const authenticatorScript = `
const normalizeSecret = ${normalizeAuthenticatorSecret.toString()};
const authenticator = form.elements.namedItem('totpSecret');
const feedback = document.querySelector('#authenticator-feedback');
authenticator.addEventListener('input', () => {
  let message = '';
  try { normalizeSecret(authenticator.value); }
  catch { message = 'Enter a valid Base32 authenticator secret.'; }
  authenticator.setCustomValidity(message);
  feedback.textContent = message;
});
`;

function fields(kind: SecureDialogKind, origin?: string, generator = false, label?: LoginLabel): string {
  if (kind === 'enroll-download-device') return '<p>Enter the one-time enrollment code supplied by the download service owner. This device keeps its own Windows-protected credential.</p><label>Download enrollment code<input name="code" type="password" autocomplete="off" maxlength="128" pattern="pbenr_[a-f0-9\\-]{36}_[A-Za-z0-9_\\-]{43}" required autofocus></label>';
  if (kind === 'export-browsing' || kind === 'restore-browsing') {
    const exporting = kind === 'export-browsing';
    return `<p>${exporting ? 'Choose a separate passphrase of at least 16 characters. Keep it apart from the recovery file. You will need both when you restore.' : 'Enter the passphrase you chose when you exported this recovery file.'}</p><label>Recovery passphrase<input name="password" type="password" autocomplete="off" minlength="16" maxlength="1024" required autofocus></label>${exporting ? '<label>Repeat passphrase<input name="confirmPassword" type="password" autocomplete="off" minlength="16" maxlength="1024" required></label>' : ''}`;
  }
  if (kind === 'enroll-hello') return '<p>Confirm the master password once. Windows Hello will then ask for your face, fingerprint or PIN, and after that it can unlock MyVault on this computer.</p><label>Master password<input name="password" type="password" autocomplete="current-password" maxlength="1024" required autofocus></label>';
  if (kind === 'unlock') return '<label>Master password<input name="password" type="password" autocomplete="current-password" maxlength="1024" required autofocus></label>';
  if (kind === 'pair') return '<label>MyVault address<input name="endpoint" type="url" value="https://myvault.digitronics-electro.workers.dev" maxlength="2048" required></label><label>One-time enrollment code<input name="enrollmentCode" autocomplete="off" maxlength="128" required></label><label>Master password<input name="password" type="password" autocomplete="current-password" maxlength="1024" required></label>';
  if (kind === 'confirm-delete') return `<p class="warning">Delete this login from MyVault? This change will be encrypted immediately.</p><input name="confirmed" type="hidden" value="true">`;
  if (kind === 'confirm-fill') return `<p class="warning">Fill a login into this complete origin?<br><strong>${escapeHtml(origin ?? '')}</strong></p><input name="confirmed" type="hidden" value="true">`;
  if (kind === 'confirm-capture') return `<p>Save the login captured once for:<br><strong>${escapeHtml(origin ?? '')}</strong></p><input name="confirmed" type="hidden" value="true">`;
  if (kind === 'confirm-replace') return `<p class="warning">A changed login already exists. Replace it with the legacy record for:<br><strong>${escapeHtml(origin ?? '')}</strong></p><input name="confirmed" type="hidden" value="true">`;
  if (kind === 'confirm-cleanup') return '<p class="warning">Delete the old OS-encrypted Private Browser vault? The verified migration backup will remain.</p><input name="confirmed" type="hidden" value="true">';
  const updating = kind === 'update-login';
  return `<label>Name<input name="title" maxlength="200" value="${escapeHtml(label?.title ?? '')}" required autofocus></label><label>Website origin<input name="url" type="url" maxlength="2048" value="${escapeHtml(origin ?? '')}" required></label><label>Username or email<input name="username" maxlength="500" value="${escapeHtml(label?.username ?? '')}" autocomplete="username" required></label><label>${updating ? 'New password (optional)' : 'Password'}<input name="password" type="password" maxlength="5000" autocomplete="new-password" ${updating ? '' : 'required'}></label>${generator ? generatorFields() : ''}<label>${updating ? 'New authenticator secret (optional)' : 'Authenticator secret (optional)'}<input name="totpSecret" type="password" maxlength="500" autocomplete="off" aria-describedby="authenticator-feedback"><span id="authenticator-feedback" role="status"></span></label>${updating ? '<p>Leave the replacement fields empty to keep the saved password and authenticator secret.</p>' : ''}`;
}

function html(kind: SecureDialogKind, nonce: string, origin?: string, generator = false, label?: LoginLabel): string {
  const enrolling = kind === 'enroll-download-device';
  const browsing = kind === 'export-browsing' || kind === 'restore-browsing';
  const title = enrolling ? 'Enroll this device' : kind === 'export-browsing' ? 'Protect recovery file' : kind === 'restore-browsing' ? 'Unlock recovery file' : kind === 'unlock' ? 'Unlock MyVault' : kind === 'enroll-hello' ? 'Turn on Windows Hello' : kind === 'pair' ? 'Connect MyVault' : kind === 'confirm-delete' ? 'Confirm deletion' : kind === 'confirm-fill' ? 'Confirm Banking fill' : kind === 'confirm-capture' ? 'Confirm captured login' : kind === 'confirm-replace' ? 'Resolve changed login' : kind === 'confirm-cleanup' ? 'Remove legacy vault' : kind === 'update-login' ? 'Update saved login' : 'Save in MyVault';
  const action = enrolling ? 'Enroll device' : browsing ? 'Continue' : kind === 'confirm-delete' ? 'Delete login' : kind === 'confirm-fill' ? 'Fill this origin' : kind === 'confirm-capture' ? 'Encrypt and save' : kind === 'confirm-replace' ? 'Replace login' : kind === 'confirm-cleanup' ? 'Delete old ciphertext' : kind === 'unlock' ? 'Unlock' : kind === 'enroll-hello' ? 'Continue to Windows Hello' : kind === 'pair' ? 'Connect securely' : 'Encrypt and save';
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; form-action 'none'; base-uri 'none'"><meta name="viewport" content="width=device-width"><title>${title}</title><style nonce="${nonce}">:root{color-scheme:dark;font-family:system-ui;background:#0b0d12;color:#f7f8fb}body{margin:0;padding:28px}h1{font-size:22px;margin:0 0 8px}p{color:#aeb6c8;line-height:1.5}form{display:grid;gap:16px;margin-top:22px}label{display:grid;gap:7px;font-size:13px;color:#c9cfdb}details{border:1px solid #394052;border-radius:8px;padding:9px}details label,details button{margin-top:9px}summary{cursor:pointer}input,select{box-sizing:border-box;width:100%;padding:11px 12px;border-radius:8px;border:1px solid #394052;background:#161a23;color:#fff}input:focus{outline:2px solid #818cf8;outline-offset:2px}.actions{display:flex;justify-content:flex-end;gap:10px;margin-top:8px}button{padding:10px 16px;border-radius:8px;border:0;font-weight:700;background:#252b38;color:#fff}button[type=submit]{background:#4f46e5}.danger button[type=submit]{background:#be123c}.warning{color:#fecdd3}</style></head><body><h1>${title}</h1><p>${enrolling ? 'Private Browser exchanges the code through the configured download service.' : browsing ? 'Your passphrase stays in this trusted dialog and the local recovery process.' : 'This isolated window sends its value directly to the trusted vault broker. Browser pages and the main interface cannot read it.'}</p><form class="${kind === 'confirm-delete' ? 'danger' : ''}">${fields(kind, origin, generator, label)}<div class="actions"><button id="cancel" type="button">Cancel</button><button type="submit">${action}</button></div></form><script nonce="${nonce}">const form=document.querySelector('form');form.elements.namedItem('confirmPassword')?.addEventListener('input',(event)=>event.currentTarget.setCustomValidity(''));form.elements.namedItem('password')?.addEventListener('input',()=>form.elements.namedItem('confirmPassword')?.setCustomValidity(''));document.querySelector('#cancel').addEventListener('click',()=>window.secureVault.cancel());form.addEventListener('submit',(event)=>{event.preventDefault();const raw=Object.fromEntries(new FormData(form));const confirm=form.elements.namedItem('confirmPassword');if(confirm&&raw.password!==raw.confirmPassword){confirm.setCustomValidity('Enter the same passphrase twice.');confirm.reportValidity();return;}if(raw.confirmed==='true')raw.confirmed=true;window.secureVault.submit(raw)});window.addEventListener('beforeunload',()=>window.secureVault.cancel());\n${generator ? generatorScript : ""}${(kind === "edit-login" || kind === "update-login") ? authenticatorScript : ""}</script></body></html>`;
}

export class SecureVaultDialogs {
  private readonly pending = new Map<string, PendingDialog>();

  constructor(private readonly parent: () => BrowserWindow | undefined) {
    ipcMain.on('vault-secure:submit', (event, nonce: unknown, value: unknown) => this.finish(event.sender.id, nonce, value));
    ipcMain.on('vault-secure:cancel', (event, nonce: unknown) => this.cancel(event.sender.id, nonce));
    ipcMain.handle('vault-secure:generate', (event, nonce: unknown, preset: unknown) => {
      const pending = typeof nonce === 'string' ? this.pending.get(nonce) : undefined;
      if (!pending?.generate || pending.used || pending.kind !== 'edit-login' || pending.window.webContents.id !== event.sender.id
        || event.senderFrame !== event.sender.mainFrame || typeof preset !== 'string' || !Object.hasOwn(SECURE_CREDENTIAL_PRESETS, preset)) {
        throw new Error('Credential generation is unavailable in this window');
      }
      return pending.generate(preset as SecureCredentialPreset);
    });
  }

  open(kind: SecureDialogKind, origin?: string, generate?: GenerateCredential, label?: LoginLabel): Promise<SecureDialogValue | undefined> {
    const nonce = randomBytes(24).toString('base64url');
    const options: BrowserWindowConstructorOptions = {
      parent: this.parent(), modal: true, show: false, width: 500, height: kind === 'edit-login' || kind === 'update-login' ? 650 : 430,
      resizable: false, minimizable: false, maximizable: false, backgroundColor: '#0b0d12', title: 'MyVault',
      webPreferences: {
        preload: join(import.meta.dirname, 'secure-preload.cjs'), contextIsolation: true, sandbox: true,
        nodeIntegration: false, webSecurity: true, devTools: false,
        additionalArguments: [`--vault-dialog-nonce=${nonce}`, `--vault-dialog-kind=${kind}`, ...(generate ? ['--vault-dialog-generator'] : [])],
      },
    };
    const window = new BrowserWindow(options);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    return new Promise((resolve) => {
      const timeout = setTimeout(() => this.settle(nonce, undefined), 120_000);
      timeout.unref();
      this.pending.set(nonce, { window, kind, resolve, used: false, timeout, generate });
      window.on('closed', () => this.settle(nonce, undefined));
      void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html(kind, nonce, origin, Boolean(generate), label))}`).then(() => window.show());
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
