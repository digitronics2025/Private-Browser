import type { WebContents } from 'electron';

export const VAULT_ISOLATED_WORLD_ID = 1007;

export interface LoginFormShape { hasUsername: boolean; hasPassword: boolean }
export interface CapturedLogin { username: string; password: string }
export type AutomaticFillResult = 'filled' | 'no-login-form' | 'occupied' | 'new-password-form';
export interface FocusedLoginField {
  kind: 'username' | 'password';
  rect: { x: number; y: number; width: number; height: number };
}

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

/**
 * Chrome-style fill for normal sign-in forms. Unlike deliberate manual fill,
 * this refuses new-password/multi-password forms and never overwrites a value
 * the page or user already placed in either recognized field.
 */
export async function fillLoginAutomaticallyInIsolatedWorld(
  contents: WebContents,
  username: string,
  password: string,
): Promise<AutomaticFillResult> {
  const result = await contents.executeJavaScriptInIsolatedWorld(VAULT_ISOLATED_WORLD_ID, [{ code: `(() => {
    const visible = (element) => element instanceof HTMLInputElement
      && !element.disabled && !element.readOnly && element.getClientRects().length > 0;
    const newPasswordFields = [...document.querySelectorAll('input[autocomplete="new-password"]')].filter(visible);
    if (newPasswordFields.length) return 'new-password-form';
    const passwordFields = [...document.querySelectorAll('input[type="password"], input[autocomplete="current-password"]')]
      .filter((element) => visible(element) && element.autocomplete !== 'new-password');
    if (passwordFields.length !== 1) return 'no-login-form';
    const usernameField = [...document.querySelectorAll('input[autocomplete="username"], input[type="email"], input[name*="user" i], input[name*="email" i]')]
      .find(visible);
    const passwordField = passwordFields[0];
    if (!(passwordField instanceof HTMLInputElement)) return 'no-login-form';
    if (passwordField.value) return 'occupied';
    if (usernameField instanceof HTMLInputElement && usernameField.value
      && usernameField.value.normalize('NFKC').trim() !== ${literal(username.normalize('NFKC').trim())}) return 'occupied';
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) return 'no-login-form';
    const setValue = (element, value) => {
      setter.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    };
    if (usernameField instanceof HTMLInputElement && !usernameField.value) setValue(usernameField, ${literal(username)});
    setValue(passwordField, ${literal(password)});
    return 'filled';
  })()` }], true) as unknown;
  if (result === 'filled' || result === 'no-login-form' || result === 'occupied' || result === 'new-password-form') return result;
  return 'no-login-form';
}

/**
 * Which recognized sign-in field the user just focused, and where it sits in
 * the page viewport (CSS pixels). Uses the same selectors and refusals as
 * automatic fill, so the picker never offers logins on a signup or
 * change-password form. Only the main frame is inspected: focus inside an
 * iframe makes `activeElement` the frame itself, which is not a match.
 */
export async function probeFocusedLoginField(contents: WebContents): Promise<FocusedLoginField | undefined> {
  const result = await contents.executeJavaScriptInIsolatedWorld(VAULT_ISOLATED_WORLD_ID, [{ code: `(() => {
    const visible = (element) => element instanceof HTMLInputElement
      && !element.disabled && !element.readOnly && element.getClientRects().length > 0;
    const field = document.activeElement;
    if (!visible(field)) return null;
    if ([...document.querySelectorAll('input[autocomplete="new-password"]')].some(visible)) return null;
    const passwordFields = [...document.querySelectorAll('input[type="password"], input[autocomplete="current-password"]')].filter(visible);
    if (passwordFields.length !== 1) return null;
    const usernameField = [...document.querySelectorAll('input[autocomplete="username"], input[type="email"], input[name*="user" i], input[name*="email" i]')]
      .find(visible);
    const kind = field === passwordFields[0] ? 'password' : field === usernameField ? 'username' : null;
    if (!kind) return null;
    const rect = field.getBoundingClientRect();
    return { kind, x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  })()` }], true) as unknown;
  return parseFocusedLoginField(result);
}

/** The probe runs beside page script, so its shape is checked like any page-sourced value. */
export function parseFocusedLoginField(value: unknown): FocusedLoginField | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== 'username' && candidate.kind !== 'password') return undefined;
  const numbers = [candidate.x, candidate.y, candidate.width, candidate.height];
  if (!numbers.every((number) => typeof number === 'number' && Number.isFinite(number))) return undefined;
  const [x, y, width, height] = numbers as number[];
  if (width <= 0 || height <= 0) return undefined;
  return { kind: candidate.kind, rect: { x, y, width, height } };
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
