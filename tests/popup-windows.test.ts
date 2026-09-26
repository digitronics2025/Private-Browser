import { describe, expect, it } from 'vitest';
import { popupTitle, popupWindowResponse, wantsPopupWindow } from '../electron/popup-windows';

describe('popup windows', () => {
  it('opens a real window only for a window.open popup request', () => {
    expect(wantsPopupWindow('new-window')).toBe(true);
    for (const disposition of ['default', 'foreground-tab', 'background-tab', 'other'] as const) {
      expect(wantsPopupWindow(disposition)).toBe(false);
    }
  });

  it('always leads the title with the host the popup is showing', () => {
    expect(popupTitle('https://pay.google.com/gp/p/ui/pay?x=1', 'Google Pay')).toBe('pay.google.com — Google Pay');
    expect(popupTitle('https://accounts.google.com/', 'accounts.google.com')).toBe('accounts.google.com');
    expect(popupTitle('https://evil.example/', '  ')).toBe('evil.example');
    expect(popupTitle('not a url', 'Sign in to your bank')).toBe('Popup — Sign in to your bank');
  });

  it('builds a hardened window that closes with its opener', () => {
    const parent = {} as Parameters<typeof popupWindowResponse>[0];
    const response = popupWindowResponse(parent);
    expect(response.action).toBe('allow');
    expect(response.outlivesOpener).toBe(false);
    expect(response.overrideBrowserWindowOptions?.parent).toBe(parent);
    expect(response.overrideBrowserWindowOptions?.webPreferences).toEqual({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    });
    expect(response.overrideBrowserWindowOptions?.webPreferences).not.toHaveProperty('preload');
  });
});
