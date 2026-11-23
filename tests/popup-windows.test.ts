import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAllowedPopupOpeningAddress, popupAddressType, PopupReview, popupTitle, popupWindowResponse, wantsPopupWindow } from '../electron/popup-windows';

const request = { webContentsId: 4, url: 'https://wallet.example/charge', resourceType: 'mainFrame', method: 'POST' };

function pendingReview() {
  const show = vi.fn();
  const destroy = vi.fn();
  const child = Object.assign(new EventEmitter(), { webContents: { id: 4 }, show, destroy, isDestroyed: () => false });
  let answer!: (approved: boolean) => void;
  const decision = new Promise<boolean>((resolve) => { answer = resolve; });
  const ask = vi.fn(() => decision);
  const finish = vi.fn();
  const current = vi.fn(() => true);
  const review = new PopupReview();
  review.start(child as unknown as BrowserWindow, { url: request.url + '#step', method: 'POST', ask, finish, current });
  const continueRequest = vi.fn();
  return { review, continueRequest, current, ask, answer, finish, show, destroy };
}

afterEach(() => vi.useRealTimers());

describe('popup windows', () => {
  it('opens a real window only for a window.open popup request', () => {
    expect(wantsPopupWindow('new-window')).toBe(true);
    for (const disposition of ['default', 'foreground-tab', 'background-tab', 'other'] as const) {
      expect(wantsPopupWindow(disposition)).toBe(false);
    }
  });

  it('accepts only empty/about:blank as non-HTTP(S) popup opening addresses', () => {
    expect(popupAddressType('')).toBe('empty');
    expect(popupAddressType('about:blank')).toBe('about:blank');
    expect(popupAddressType('https://accounts.google.com/signin?code=secret')).toBe('https');
    expect(popupAddressType('file:///private')).toBe('other');
    expect(isAllowedPopupOpeningAddress('')).toBe(true);
    expect(isAllowedPopupOpeningAddress('about:blank')).toBe(true);
    expect(isAllowedPopupOpeningAddress('https://accounts.google.com/')).toBe(true);
    expect(isAllowedPopupOpeningAddress('about:srcdoc')).toBe(false);
    expect(isAllowedPopupOpeningAddress('file:///private')).toBe(false);
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

  it('expires a held request and discards its later approval', async () => {
    vi.useFakeTimers();
    const fixture = pendingReview();
    const wrong = vi.fn();
    expect(fixture.review.hold({ ...request, webContentsId: 9 }, wrong)).toBe(false);
    expect(fixture.review.hold({ ...request, method: 'GET' }, wrong)).toBe(true);
    expect(wrong).toHaveBeenCalledExactlyOnceWith(false);
    expect(fixture.review.hold(request, fixture.continueRequest)).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fixture.ask.mock.calls[0]).toEqual([expect.objectContaining({ aborted: true })]);
    expect(fixture.continueRequest).toHaveBeenCalledExactlyOnceWith(false);
    expect(fixture.finish).toHaveBeenCalledExactlyOnceWith('expired');
    fixture.answer(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.show).not.toHaveBeenCalled();
    expect(fixture.destroy).toHaveBeenCalledOnce();
  });

  it('rejects Continue after the original page context changes', async () => {
    vi.useFakeTimers();
    const fixture = pendingReview();
    expect(fixture.review.hold(request, fixture.continueRequest)).toBe(true);
    fixture.current.mockReturnValue(false);
    fixture.answer(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.continueRequest).toHaveBeenCalledExactlyOnceWith(false);
    expect(fixture.finish).toHaveBeenCalledExactlyOnceWith('changed');
    expect(fixture.show).not.toHaveBeenCalled();
  });

  it('holds the first safe HTTPS navigation after a blank opening until its permission decision', async () => {
    const show = vi.fn();
    const destroy = vi.fn();
    const child = Object.assign(new EventEmitter(), { webContents: { id: 4 }, show, destroy, isDestroyed: () => false });
    let answer!: (approved: boolean) => void;
    const decision = new Promise<boolean>((resolve) => { answer = resolve; });
    const finish = vi.fn();
    const reply = vi.fn();
    const review = new PopupReview();
    review.start(child as unknown as BrowserWindow, {
      url: 'about:blank', method: 'GET', ask: () => decision, finish, current: () => true,
    });
    expect(review.hold({ webContentsId: 4, url: 'https://accounts.google.com/signin?code=synthetic', resourceType: 'mainFrame', method: 'GET' }, reply)).toBe(true);
    expect(review.hold({ webContentsId: 4, url: 'file:///private', resourceType: 'mainFrame', method: 'GET' }, vi.fn())).toBe(true);
    answer(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(reply).toHaveBeenCalledExactlyOnceWith(true);
    expect(show).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledExactlyOnceWith('continued');
  });
});
