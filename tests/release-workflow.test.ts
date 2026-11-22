import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');

function step(name: string): string {
  const start = workflow.indexOf(`- name: ${name}`);
  if (start < 0) throw new Error(`Missing workflow step: ${name}`);
  const next = workflow.indexOf('\n      - ', start + 1);
  return workflow.slice(start, next < 0 ? undefined : next);
}

describe('release workflow', () => {
  // F-21 / F-41: cancelling a main-branch run could stop it between the R2
  // upload and the D1 registration; only pull-request runs may be cancelled.
  it('never cancels a run on main', () => {
    const top = workflow.slice(0, workflow.indexOf('\njobs:'));
    expect(top).toMatch(/cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
    expect(top).not.toMatch(/cancel-in-progress: true/);
  });

  it('requires the owner-approved main commit before production publication', () => {
    const publish = workflow.slice(workflow.indexOf('  publish-cloudflare-release:'));
    const eligibility = publish.slice(0, publish.indexOf('\n    concurrency:'));
    expect(eligibility).toContain("github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(eligibility).toContain('&& vars.PRIVATE_BROWSER_AGENT_MODE_RELEASE_APPROVED == github.sha');
  });

  // F-41: an app change whose run never published must still ship with the next push.
  it('decides "docs only" against the commit production runs, not the previous push', () => {
    const changes = step('Detect whether this push changes the application');
    expect(changes).toContain('cloudflare/scripts/read-active-release.mjs');
    expect(changes).toContain('merge-base --is-ancestor');
    expect(changes.indexOf('commitSha')).toBeLessThan(changes.indexOf('github.event.before'));
  });

  // F-55: nothing that runs before the credentialed steps gets to execute
  // dependency install scripts, and every action is pinned to a commit.
  it('installs the publish job without dependency scripts and pins every action', () => {
    const publish = workflow.slice(workflow.indexOf('  publish-cloudflare-release:'));
    expect(publish).toContain('- run: npm ci --ignore-scripts');
    // Only wrangler's engine packages may run install scripts, and nothing else.
    expect(publish.match(/- run: npm (?:ci|install|rebuild)[^\r\n]*/g)).toEqual(['- run: npm ci --ignore-scripts', '- run: npm rebuild workerd esbuild']);
    for (const file of ['ci.yml', 'deploy-cloudflare.yml', 'codeql.yml']) {
      const text = readFileSync(join(process.cwd(), '.github/workflows', file), 'utf8');
      for (const [, reference] of text.matchAll(/uses: (\S+)/g)) expect(reference, `${file}: ${reference}`).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  // F-50: a release that fails its live check is replaced by the one before it.
  it('restores the previous release when live verification fails', () => {
    expect(step('Record the release being replaced')).toContain('cloudflare/scripts/read-active-release.mjs');
    const verify = step('Verify authenticated download end to end');
    expect(verify).toContain('PREVIOUS_RELEASE_ID: ${{ steps.previous.outputs.id }}');
    expect(verify).toContain('node cloudflare/scripts/activate-release.mjs "$PREVIOUS_RELEASE_ID"');
    expect(verify.trim().endsWith('exit 1')).toBe(true);
  });

  it('reads and verifies private candidate bytes before stable activation', () => {
    const stage = step('Verify candidate bytes from private R2');
    expect(stage).toContain('id: staged');
    expect(stage).toContain('wrangler r2 object get "private-browser-releases/$OBJECT_KEY" --file "$candidate_file" --remote');
    expect(stage).toContain('verify-release-candidate.mjs "$INSTALLER_PATH" "$candidate_file"');
    expect(stage).toContain('verified=true');
    expect(stage).toContain('$GITHUB_STEP_SUMMARY');
    expect(workflow.indexOf(stage)).toBeLessThan(workflow.indexOf(step('Publish D1 release metadata')));
    expect(step('Publish D1 release metadata')).toContain("steps.staged.outputs.verified == 'true'");
    expect(step('Verify authenticated download end to end')).toContain('Stable installer verified');
  });

  it('gates the installer artifact on a smoke test of the installed candidate', () => {
    const smoke = step('Exercise the installed Windows release candidate');
    expect(smoke).toContain('Start-Process -FilePath $installer.FullName');
    expect(smoke).toContain('playwright.packaged.config.ts');
    expect(smoke).toContain('Get-FileHash -LiteralPath $installer.FullName');
    expect(smoke.trim()).toMatch(/if \(\$testExit -ne 0\) \{ exit \$testExit \}$/);
    expect(workflow.indexOf(smoke)).toBeGreaterThan(workflow.indexOf(step('Build hardened Windows installer')));
    expect(workflow.indexOf(smoke)).toBeLessThan(workflow.indexOf('name: private-browser-windows'));
  });

  it('excludes credential bootstrapping from the build and checks the live feed before an upload', () => {
    const { build } = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    expect(JSON.stringify(build.extraResources)).not.toContain('private-browser-update.json');
    expect(workflow).not.toContain('write-update-bootstrap');
    expect(workflow).not.toContain('PRIVATE_BROWSER_BUNDLE_UPDATE_TOKEN');
    const configured = step('Detect publishing configuration');
    expect(configured).toContain('PRIVATE_BROWSER_RELEASE_VERIFY_DEVICE: ${{ secrets.PRIVATE_BROWSER_RELEASE_VERIFY_DEVICE }}');
    expect(configured.indexOf('read-active-release.mjs')).toBeLessThan(configured.indexOf('ready=true'));
    expect(step('Upload installer to private R2 bucket')).toContain("if: steps.configured.outputs.ready == 'true'");
  });

  it('reuses test builds while keeping the security suites and final versioned build', () => {
    const { scripts } = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    expect(scripts['test:e2e']).toBe('npm run build && npm run test:e2e:only');
    expect(scripts.check).toContain('npm run build && npm run test:e2e:only && npm run test:electron:ci');
    expect(step('Exercise real Electron Account Space isolation')).toContain('npm run test:electron');
    expect(step('Verify Electron MyVault boundary')).toContain('npm run test:e2e:only');
    expect(step('Build hardened Windows installer')).toContain('npm run dist');
    expect(scripts.dist).toContain('npm run build');
    expect(step('Summarize affected release paths')).toContain('$GITHUB_STEP_SUMMARY');
  });
});
