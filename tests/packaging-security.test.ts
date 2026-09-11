import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');

describe('packaged application security', () => {
  it('pins Electron and hardens the executable fuse wire', () => {
    expect(pkg.devDependencies.electron).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.build.asar).toBe(true);
    expect(pkg.build.electronFuses).toEqual(expect.objectContaining({
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
    }));
  });

  it('builds and bundles the VS Code companion instead of downloading code at runtime', () => {
    expect(pkg.scripts['vscode:package']).toContain('vsce package');
    expect(pkg.scripts.dist).toContain('npm run vscode:package');
    expect(pkg.build.extraResources).toContainEqual(expect.objectContaining({
      from: 'build/private-browser-vscode-bridge.vsix',
      to: 'agent-tools/private-browser-vscode-bridge.vsix',
    }));
  });

  it('requires VS Code Workspace Trust before starting an agent task', () => {
    expect(main).toContain("if (!editor.workspaceTrusted) throw new Error('Trust the connected VS Code workspace");
  });
});
