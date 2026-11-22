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
    const windows = workflow.slice(workflow.indexOf('  windows-installer:'));
    const approval = step('Validate exact-commit release approval');
    expect(workflow).toContain('default: false');
    expect(approval).toContain("github.event_name == 'workflow_dispatch' && inputs.publish");
    expect(approval).toContain('vars.PRIVATE_BROWSER_AGENT_MODE_RELEASE_APPROVED');
    expect(approval).toContain('github.ref_protected');
    expect(approval).toContain('"$GITHUB_REF" != refs/heads/main || "$PROTECTED_REF" != true || "$APPROVED_SHA" != "$GITHUB_SHA"');
    expect(windows).toContain("needs.verify.outputs.production == 'true'");
    expect(windows).toContain("'production-release' || 'windows-verification'");
    expect(step('Publish installer from private R2')).toContain("if: env.PRIVATE_BROWSER_STABLE_BUILD == 'true'");
  });

  // F-41: an app change whose run never published must still ship with the next push.
  it('decides "docs only" against the commit production runs, not the previous push', () => {
    const changes = step('Detect whether this push changes the application');
    expect(changes).toContain('cloudflare/scripts/read-active-release.mjs');
    expect(changes).toContain('merge-base --is-ancestor');
    expect(changes.indexOf('commitSha')).toBeLessThan(changes.indexOf('github.event.before'));
  });

  it('pins every workflow action and keeps Worker deploy credentials out of Actions', () => {
    for (const file of ['ci.yml', 'deploy-cloudflare.yml', 'codeql.yml']) {
      const text = readFileSync(join(process.cwd(), '.github/workflows', file), 'utf8');
      for (const [, reference] of text.matchAll(/uses: (\S+)/g)) expect(reference, `${file}: ${reference}`).toMatch(/@[0-9a-f]{40}$/);
      if (file === 'deploy-cloudflare.yml') expect(text).not.toContain('secrets.');
    }
  });

  it('requires a signed candidate, verifies private R2 bytes and suspends a failed release without an eligible restore', () => {
    const packaging = step('Build hardened Windows installer');
    const loadSigner = step('Load approved Windows signing certificate');
    const signed = step('Verify signed app and installer');
    const stage = step('Stage and verify private R2 objects');
    const publish = step('Publish installer from private R2');
    expect(loadSigner).toContain('if: env.PRIVATE_BROWSER_STABLE_BUILD');
    expect(loadSigner).toContain('import-windows-publisher.ps1');
    expect(packaging).toContain('steps.signer.outputs.thumbprint');
    expect(packaging).not.toContain('secrets.');
    expect(step('Remove production signing certificate')).toContain('-DeleteKey');
    expect(signed).toContain('record-windows-publisher.ps1');
    expect(signed).toContain('win-unpacked/Private Browser.exe');
    expect(stage).toContain('verify-release-candidate.mjs "$installer" "$candidate_dir/candidate.exe"');
    expect(stage).toContain("put-object --bucket");
    expect(stage).toContain("--if-none-match '*'");
    expect(stage).toContain('get-object --bucket');
    expect(stage).toContain('cmp --silent');
    expect(stage).not.toContain('PRODUCTION_RELEASE_AUTOMATION_KEY');
    expect(publish).not.toContain('PRODUCTION_RELEASE_R2_');
    expect(publish).toContain('git ls-remote --exit-code origin refs/heads/main');
    expect(stage.indexOf('Main advanced after release approval')).toBeLessThan(stage.indexOf('put-object --bucket'));
    expect(publish.indexOf('read-active-release.mjs')).toBeLessThan(publish.indexOf('publish-release.mjs'));
    expect(workflow.indexOf(stage)).toBeLessThan(workflow.indexOf(publish));
    expect(publish).toContain('live.commitSha !== process.env.GITHUB_SHA || live.sha256 !== process.argv[3]');
    expect(publish).toContain('Check that exact release in D1 before retrying.');
    expect(publish).toContain('verify-live-release.mjs');
    expect(publish).toContain('activate-release.mjs "$previous_id" "$published_id"');
    expect(publish).toContain('suspend-release.mjs "$published_id"');
    expect(workflow.indexOf(signed)).toBeLessThan(workflow.indexOf(publish));
  });

  it('smoke-tests the exact installer and excludes binaries from public artifact uploads', () => {
    const smoke = step('Exercise the installed Windows release candidate');
    expect(smoke).toContain('Start-Process -FilePath $installer.FullName');
    expect(smoke).toContain('playwright.packaged.config.ts');
    expect(smoke).toContain('Get-FileHash -LiteralPath $installer.FullName');
    expect(smoke.trim()).toMatch(/if \(\$testExit -ne 0\) \{ exit \$testExit \}$/);
    expect(workflow.indexOf(smoke)).toBeGreaterThan(workflow.indexOf(step('Build hardened Windows installer')));
    expect(workflow.indexOf(smoke)).toBeLessThan(workflow.indexOf(step('Stage and verify private R2 objects')));
    expect(step('Keep signed release evidence')).not.toMatch(/\.exe|\.vsix/);
    expect(workflow).not.toContain('name: private-browser-windows');
  });

  it('excludes credential bootstrapping from the build', () => {
    const { build } = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    expect(JSON.stringify(build.extraResources)).not.toContain('private-browser-update.json');
    expect(workflow).not.toContain('write-update-bootstrap');
    expect(workflow).not.toContain('PRIVATE_BROWSER_BUNDLE_UPDATE_TOKEN');
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
