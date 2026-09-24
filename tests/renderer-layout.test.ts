import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
const profileMenu = readFileSync(new URL('../src/shell/ProfileMenu.tsx', import.meta.url), 'utf8');

describe('browser chrome geometry', () => {
  it('derives the page rectangle from one shared calculation in both processes', () => {
    expect(app).toContain("from '../electron/chrome-layout'");
    expect(app).toContain('computeChromeLayout(');
    expect(app).toContain('setLayout(committedLayout.insets)');
    expect(main).toContain("from './chrome-layout.js'");
    expect(main).toContain('private layout: Layout = { ...DEFAULT_CONTENT_INSETS }');
    expect(main).toContain('contentBounds(insets, width, height)');
  });

  it('no longer duplicates the old fixed offsets anywhere', () => {
    for (const source of [app, main, styles]) {
      expect(source).not.toMatch(/\b(158|128|366)px\b/);
      expect(source).not.toMatch(/top:\s*(158|128)\b/);
    }
  });

  it('positions every page-adjacent surface from the shared custom properties', () => {
    expect(styles).toMatch(/\.page-surface, \.new-tab-page \{[^}]*top: var\(--chrome-top\);[^}]*right: var\(--side-panel-w\);/);
    expect(styles).toMatch(/\.side-panel-shell \{[^}]*top: var\(--chrome-top\);[^}]*width: var\(--side-panel-w\);/);
    expect(styles).toContain('--chrome-top');
  });

  it('keeps the draggable tab strip free of interactive drag regions', () => {
    expect(styles).toMatch(/\.tab-strip \{[^}]*-webkit-app-region: drag;/);
    expect(styles).toMatch(/\.tab-strip button, \.tab-strip \.browser-tab \{ -webkit-app-region: no-drag; \}/);
    expect(main).toContain('height: CHROME.tabStrip');
  });

  it('shows the window even when ready-to-show fires before the chrome finishes loading', () => {
    const listen = main.indexOf("this.window.once('ready-to-show'");
    const load = main.indexOf('await this.window.loadURL(devUrl ?? productionUrl)');
    expect(listen).toBeGreaterThan(-1);
    expect(listen).toBeLessThan(load);
    expect(main).toContain('if (!this.window.isDestroyed() && !this.window.isVisible()) this.window.show();');
  });

  it('opens the window maximised before the chrome loads', () => {
    const maximize = main.indexOf('this.window.maximize();');
    expect(maximize).toBeGreaterThan(-1);
    expect(maximize).toBeLessThan(main.indexOf('await this.window.loadURL(devUrl ?? productionUrl)'));
  });

  it('moves workspace switching into the profile menu', () => {
    expect(app).not.toContain('<WorkspaceRail');
    expect(styles).not.toContain('.workspace-rail');
    expect(profileMenu).toContain('aria-label={`Switch to ${item.name}`}');
  });
});
