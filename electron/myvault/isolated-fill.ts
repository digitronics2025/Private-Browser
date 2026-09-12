import type { WebContents } from 'electron';

export const VAULT_ISOLATED_WORLD_ID = 1007;

export interface LoginFormShape { hasUsername: boolean; hasPassword: boolean }
export interface CapturedLogin { username: string; password: string }

function literal(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export async function fillLoginInIsolatedWorld(contents: WebContents, username: string, password: string): Promise<void> {
  const result = await contents.executeJavaScriptInIsolatedWorld(VAULT_ISOLATED_WORLD_ID, [{ code: `(() => {
    const setValue = (element, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!setter) return false;
      setter.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    const visible = (element) => !element.disabled && !element.readOnly && element.getClientRects().length > 0;
    const passwordField = [...document.querySelectorAll('input[type="password"], input[autocomplete="current-password"]')].find(visible);
    const usernameField = [...document.querySelectorAll('input[autocomplete="username"], input[type="email"], input[name*="user" i], input[name*="email" i]')].find(visible);
    if (!(passwordField instanceof HTMLInputElement)) throw new Error('No recognized password field was found');
    if (usernameField instanceof HTMLInputElement) setValue(usernameField, ${literal(username)});
    setValue(passwordField, ${literal(password)});
    return true;
  })()` }], true);
  if (result !== true) throw new Error('The page did not accept the credential fill');
}

export async function fillTotpInIsolatedWorld(contents: WebContents, code: string): Promise<void> {
  const result = await contents.executeJavaScriptInIsolatedWorld(VAULT_ISOLATED_WORLD_ID, [{ code: `(() => {
    const field = [...document.querySelectorAll('input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="code" i]')]
      .find((element) => !element.disabled && !element.readOnly && element.getClientRects().length > 0);
    if (!(field instanceof HTMLInputElement)) throw new Error('No recognized one-time-code field was found');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('The one-time-code field is not writable');
    setter.call(field, ${literal(code)});
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()` }], true);
  if (result !== true) throw new Error('The page did not accept the one-time-code fill');
}

export async function inspectLoginFormShape(contents: WebContents): Promise<LoginFormShape> {
  return contents.executeJavaScriptInIsolatedWorld(VAULT_ISOLATED_WORLD_ID, [{ code: `(() => ({
    hasUsername: Boolean(document.querySelector('input[autocomplete="username"], input[type="email"], input[name*="user" i], input[name*="email" i]')),
    hasPassword: Boolean(document.querySelector('input[type="password"], input[autocomplete="current-password"], input[autocomplete="new-password"]'))
  }))()` }], true) as Promise<LoginFormShape>;
}

/** Called only after a user Save/Update intent. No automatic post-submit capture exists. */
export async function captureLoginInIsolatedWorld(contents: WebContents): Promise<CapturedLogin> {
  const result = await contents.executeJavaScriptInIsolatedWorld(VAULT_ISOLATED_WORLD_ID, [{ code: `(() => {
    const allowed = (element) => element instanceof HTMLInputElement && !element.disabled && !element.readOnly
      && !['cc-number','cc-csc','cc-exp','one-time-code'].includes(element.autocomplete);
    const password = [...document.querySelectorAll('input[type="password"], input[autocomplete="current-password"], input[autocomplete="new-password"]')].find(allowed);
    const username = [...document.querySelectorAll('input[autocomplete="username"], input[type="email"], input[name*="user" i], input[name*="email" i]')].find(allowed);
    if (!(password instanceof HTMLInputElement)) throw new Error('No recognized password field was found');
    return { username: username instanceof HTMLInputElement ? username.value.slice(0, 500) : '', password: password.value.slice(0, 5000) };
  })()` }], true) as unknown;
  if (!result || typeof result !== 'object') throw new Error('The page did not return a login');
  const value = result as Partial<CapturedLogin>;
  if (typeof value.username !== 'string' || typeof value.password !== 'string' || !value.password) throw new Error('The page did not return a login');
  return { username: value.username, password: value.password };
}
