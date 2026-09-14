import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function readTree(directory: string): string {
  return readdirSync(directory).map((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return readTree(path);
    return /\.tsx?$/.test(name) ? readFileSync(path, 'utf8') : '';
  }).join('\n');
}

const renderer = readTree(fileURLToPath(new URL('../src', import.meta.url)));
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const preload = readFileSync(new URL('../electron/preload.cts', import.meta.url), 'utf8');

describe('Account Space renderer contract', () => {
  it('replaces the old DR shortcut with an accessible Account Space switcher', () => {
    expect(renderer).not.toContain('title="Personal workspace"');
    expect(renderer).toContain('aria-haspopup="menu"');
    expect(renderer).toContain('Manage Account Spaces');
    expect(renderer).toContain('Ctrl + Shift + ← / →');
  });

  it('renders only tabs, bookmarks and history from the active Account Space', () => {
    expect(app).toContain('tab.accountSpaceId === state.activeAccountSpaceId');
    expect(app).toContain('item.accountSpaceId === state.activeAccountSpaceId');
  });

  it('hides native page content under menus, account and permission overlays', () => {
    expect(app).toContain('setOverlayOpen(overlayOpen)');
    expect(app).toMatch(/const overlayOpen = overlayCount > 0 \|\| accountManagerOpen \|\| vaultFullOpen \|\| Boolean\(state\?\.pendingPermission\) \|\| Boolean\(state\?\.recovery\);/);
    expect(preload).toContain("ipcRenderer.invoke('browser:set-overlay-open', open)");
    expect(styles).toMatch(/\.modal-backdrop \{[^}]*z-index: 60/);
  });

  it('keeps security warnings visible in the address bar', () => {
    expect(renderer).toContain("{warning === 'idn' ? 'Check domain' : 'Not secure'}");
    expect(renderer).toContain('className="security-chip" role="status"');
  });

  it('has explicit connection, permission, destructive and recovery states', () => {
    expect(renderer).toContain('Website status:');
    expect(renderer).toContain("onRespond('allow-once'");
    expect(renderer).toContain('DELETE_ACCOUNT_SPACE');
    expect(renderer).toContain('performRecoveryAction');
    expect(renderer).toContain('It is not a second Windows authentication boundary');
  });

  it('includes mobile layout, reduced-motion and forced-colour behavior', () => {
    expect(styles).toContain('@media (max-width: 850px)');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(styles).toContain('@media (forced-colors: active)');
  });
});
