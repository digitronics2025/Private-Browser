import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const preload = readFileSync(new URL('../electron/preload.cts', import.meta.url), 'utf8');

describe('Account Space renderer contract', () => {
  it('replaces the old DR shortcut with an accessible Account Space switcher', () => {
    expect(app).not.toContain('title="Personal workspace"');
    expect(app).toContain('aria-haspopup="menu"');
    expect(app).toContain('Manage Account Spaces');
    expect(app).toContain('Ctrl + Shift + ← / →');
  });

  it('renders only tabs, bookmarks and history from the active Account Space', () => {
    expect(app).toContain('tab.accountSpaceId === state.activeAccountSpaceId');
    expect(app).toContain('item.accountSpaceId === state.activeAccountSpaceId');
  });

  it('hides native page content under account and permission overlays', () => {
    expect(app).toContain('setOverlayOpen(modalOpen)');
    expect(preload).toContain("ipcRenderer.invoke('browser:set-overlay-open', open)");
    expect(styles).toMatch(/\.modal-backdrop \{[^}]*z-index: 60/);
  });

  it('has explicit connection, permission, destructive and recovery states', () => {
    expect(app).toContain('Website status:');
    expect(app).toContain("onRespond('allow-once'");
    expect(app).toContain('DELETE_ACCOUNT_SPACE');
    expect(app).toContain('performRecoveryAction');
    expect(app).toContain('It is not a second Windows authentication boundary');
  });

  it('includes mobile layout and reduced-motion behavior', () => {
    expect(styles).toContain('@media (max-width: 850px)');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
