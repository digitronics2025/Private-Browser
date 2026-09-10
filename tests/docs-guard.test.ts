// docs-systems v1.0.0 — test-runner wrapper.
//
// Makes the docs guard fail the same build everything else fails. The guard is
// a plain Node script with no dependencies; this file only makes it visible to
// the runner the repo already has.

import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('docs/systems stays cheap to read', () => {
  it('passes scripts/docs-guard.mjs', () => {
    let output = '';
    let failed = false;
    try {
      output = execFileSync('node', ['scripts/docs-guard.mjs'], { encoding: 'utf8' });
    } catch (err) {
      failed = true;
      output = String((err as { stdout?: string }).stdout || err);
    }
    // The guard's own message states the fix, including the exact new ratchet
    // number. Surfacing it verbatim beats re-wording it here and going stale.
    expect(failed ? output : '', output).toBe('');
  });
});
