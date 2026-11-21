import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { desktopReleaseNotes } from '../cloudflare/scripts/desktop-release-notes.mjs';

it('uses new notes from the exact candidate and includes changes that missed a release', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'browser-release-notes-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: fixture, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = () => {
    git('add', '.');
    git('-c', 'user.name=Release Test', '-c', 'user.email=release-test@example.test', 'commit', '-m', 'Fixture change');
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init');
    const notes = join(fixture, 'docs', 'desktop-release-notes');
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, 'previous.txt'), 'An old published note.');
    const active = commit();
    writeFileSync(join(notes, 'first.txt'), 'Pinned tabs stay in the current Account Space.');
    const missed = commit();
    writeFileSync(join(notes, 'second.txt'), 'Review your bookmarks before bulk deletion.');
    const candidate = commit();
    writeFileSync(join(notes, 'second.txt'), 'An uncommitted replacement.');
    expect(desktopReleaseNotes(candidate, active, fixture)).toBe(
      'Pinned tabs stay in the current Account Space. Review your bookmarks before bulk deletion.',
    );
    expect(desktopReleaseNotes(candidate, missed, fixture)).toBe('Review your bookmarks before bulk deletion.');
    expect(desktopReleaseNotes(candidate, undefined, fixture)).toBe('Review your bookmarks before bulk deletion.');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
