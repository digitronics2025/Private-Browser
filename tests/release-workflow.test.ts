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

  // F-41: an app change whose run never published must still ship with the next push.
  it('decides "docs only" against the commit production runs, not the previous push', () => {
    const changes = step('Detect whether this push changes the application');
    expect(changes).toContain('/api/v1/releases/public/latest');
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
    expect(step('Record the release being replaced')).toContain('/api/v1/releases/public/latest');
    const verify = step('Verify authenticated download end to end');
    expect(verify).toContain('PREVIOUS_RELEASE_ID: ${{ steps.previous.outputs.id }}');
    expect(verify).toContain('node cloudflare/scripts/activate-release.mjs "$PREVIOUS_RELEASE_ID"');
    expect(verify.trim().endsWith('exit 1')).toBe(true);
  });

  // F-42: distribution is public, so an installer carrying the shared token is never published.
  it('refuses to publish an installer built with the bundled download token', () => {
    const configured = step('Detect publishing configuration');
    expect(configured).toContain('PRIVATE_BROWSER_BUNDLE_UPDATE_TOKEN: ${{ vars.PRIVATE_BROWSER_BUNDLE_UPDATE_TOKEN }}');
    const guard = configured.indexOf('"$PRIVATE_BROWSER_BUNDLE_UPDATE_TOKEN" == "true"');
    expect(guard).toBeGreaterThan(-1);
    expect(configured.slice(guard, configured.indexOf('fi', guard))).toContain('ready=false');
    expect(guard).toBeLessThan(configured.indexOf('ready=true'));
    expect(step('Upload installer to private R2 bucket')).toContain("if: steps.configured.outputs.ready == 'true'");
  });
});
