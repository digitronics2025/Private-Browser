import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

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
      loadBrowserProcessSpecificV8Snapshot: false,
    }));
  });

  it('packages the Agent CLI and requires explicit approval before public release', () => {
    expect(pkg.build.extraResources).toContainEqual({ from: 'build/private-browser-agent', to: 'private-browser-agent' });
    const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const publish = workflow.split('  windows-installer:')[1]?.split('    steps:')[0];
    expect(publish).toContain("github.event_name == 'push'");
    expect(publish).toContain('vars.PRIVATE_BROWSER_AGENT_MODE_RELEASE_APPROVED == github.sha');
  });
});
