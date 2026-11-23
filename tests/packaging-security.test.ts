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
    const releaseGate = workflow.split('  verify:')[1]?.split('  windows-installer:')[0];
    const windows = workflow.split('  windows-installer:')[1]?.split('    steps:')[0];
    expect(releaseGate).toContain("github.event_name == 'workflow_dispatch' && inputs.publish");
    expect(releaseGate).toContain('APPROVED_SHA: ${{ vars.PRIVATE_BROWSER_AGENT_MODE_RELEASE_APPROVED }}');
    expect(releaseGate).toContain('"$APPROVED_SHA" != "$GITHUB_SHA"');
    expect(windows).toContain("needs.verify.outputs.production == 'true' && 'production-release'");
  });
});
