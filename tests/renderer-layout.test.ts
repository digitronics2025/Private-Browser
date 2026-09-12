import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');

describe('browser chrome layout', () => {
  it('uses the full left edge and keeps the renderer and main-process layout in sync', () => {
    expect(app).toContain('setLayout({ top: state.bookmarkBarVisible ? 158 : 128, left: 0, right: sidebarOpen ? 366 : 0, bottom: 0 })');
    expect(main).toContain('layout: Layout = { top: 158, left: 0, right: 366, bottom: 0 }');
    expect(styles).toMatch(/\.dashboard \{[^}]*left: 0;[^}]*right: 366px;/);
    expect(styles).toMatch(/\.bookmark-bar \{[^}]*left: 0;[^}]*right: 366px;/);
  });

  it('moves the workspace switcher into the right sidebar', () => {
    expect(app).not.toContain('<WorkspaceRail');
    expect(styles).not.toContain('.workspace-rail');
    expect(app).toContain('<WorkspaceSwitcher state={state}');
    expect(app).toMatch(/<aside className="sidebar">[\s\S]*<WorkspaceSwitcher state=\{state\}/);
  });
});
