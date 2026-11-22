import { ipcRenderer } from 'electron';
import type { WordPressLoginFlow } from './wordpress-save.js';

let armed: { nonce: string; flow: WordPressLoginFlow } | undefined;
let gesture: { form: HTMLFormElement; at: number } | undefined;

if (process.isMainFrame) {
  ipcRenderer.on('wordpress-save:arm', (_event, configuration: typeof armed) => {
    armed = configuration;
    gesture = undefined;
  });

  document.addEventListener('pointerdown', (event) => {
    if (!armed || !event.isTrusted || !(event.target instanceof Element)) return;
    const button = event.target.closest('button, input[type="submit"]');
    if ((button instanceof HTMLButtonElement || button instanceof HTMLInputElement) && button.type === 'submit' && button.form) {
      gesture = { form: button.form, at: performance.now() };
    }
  }, true);
  document.addEventListener('keydown', (event) => {
    if (!armed || !event.isTrusted || event.key !== 'Enter' || !(event.target instanceof HTMLInputElement) || !event.target.form) return;
    gesture = { form: event.target.form, at: performance.now() };
  }, true);

  document.addEventListener('submit', (event) => {
    const config = armed;
    const form = event.target;
    if (!config || !event.isTrusted || !(form instanceof HTMLFormElement) || gesture?.form !== form
      || performance.now() - gesture.at > 1500 || form.method !== 'post' || !['', '_self'].includes(form.target)) return;
    const { nonce, flow } = config;
    const action = new URL(form.action);
    if (location.origin !== flow.origin || location.pathname !== flow.formPath || action.origin !== flow.origin
      || action.pathname !== flow.formPath || form.id !== (flow.kind === 'signin' ? 'loginform' : 'your-profile')) return;
    const username = form.elements.namedItem(flow.kind === 'signin' ? 'log' : 'user_login');
    const password = form.elements.namedItem(flow.kind === 'signin' ? 'pwd' : 'pass1');
    if (!(username instanceof HTMLInputElement) || username.disabled || !(password instanceof HTMLInputElement)
      || password.disabled || password.readOnly || password.type !== 'password' || !password.value) return;
    if (flow.kind === 'password-change') {
      const repeat = form.elements.namedItem('pass2');
      if (!(repeat instanceof HTMLInputElement) || repeat.value !== password.value) return;
    }
    armed = undefined;
    gesture = undefined;
    ipcRenderer.send('wordpress-save:submitted', nonce, username.value.slice(0, 500), password.value.slice(0, 5000));
  }, true);
}
