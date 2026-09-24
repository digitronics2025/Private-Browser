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
