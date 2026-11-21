import { execFileSync, spawnSync } from 'node:child_process';

const commitPattern = /^[0-9a-f]{40}$/;
const noteDirectory = 'docs/desktop-release-notes';
const notePathPattern = /^docs\/desktop-release-notes\/[a-z0-9]+(?:-[a-z0-9]+)*\.txt$/;
const fallback = 'This release includes maintenance updates.';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function desktopReleaseNotes(revision, previousRevision, cwd = process.cwd()) {
  if (!commitPattern.test(revision)) throw new Error('Invalid installer release revision');
  // A restored stable release can be several commits behind the candidate.
  // Compare with the active release at publication time so skipped CI runs do
  // not omit their highlights. First-parent comparison handles first releases.
  const activeIsAncestor = commitPattern.test(previousRevision ?? '') && revision !== previousRevision
    && spawnSync('git', ['merge-base', '--is-ancestor', previousRevision, revision], { cwd, stdio: 'ignore' }).status === 0;
  const parents = git(['rev-list', '--parents', '-n', '1', revision], cwd).trim().split(' ');
  const before = activeIsAncestor ? previousRevision : parents[1];
  const paths = before ? git(['diff', '--name-only', '-z', '--no-renames', '--diff-filter=A', before, revision, '--', noteDirectory], cwd)
    : git(['ls-tree', '-r', '--name-only', '-z', revision, '--', noteDirectory], cwd);
  const notes = new Set();
  for (const filename of paths.split('\0').filter((path) => notePathPattern.test(path)).sort()) {
    const note = git(['show', revision + ':' + filename], cwd).trim().replace(/\s+/gu, ' ');
    if (note && note.length <= 350) notes.add(note);
  }
  return [...notes].slice(0, 15).join(' ') || fallback;
}
