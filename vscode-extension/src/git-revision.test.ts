import { mkdtemp, mkdir, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { gitRevisionSchema } from '@private-browser/bridge-protocol';
import { gitRevisionForWorkspace, revisionReportNote, type GitRepositoryView } from './git-revision.js';

const commit = 'a'.repeat(40);

function repository(path: string, state: Partial<GitRepositoryView['state']> = {}): GitRepositoryView {
  return {
    rootUri: { scheme: 'file', fsPath: path },
    state: {
      HEAD: { name: 'topic/review', commit, upstream: { remote: 'team' } },
      remotes: [
        { name: 'origin', fetchUrl: 'https://github.com/example/clone.git' },
        { name: 'team', fetchUrl: 'git@github.com:organization/project.git' },
      ],
      indexChanges: [1], workingTreeChanges: [1, 2], untrackedChanges: [1, 2, 3], mergeChanges: [1],
      ...state,
    },
  };
}

it('reports only the approved repository, using worktree counts and the configured upstream', async () => {
  const root = await mkdtemp(join(tmpdir(), 'private-browser-revision-'));
  const nested = join(root, 'nested');
  await mkdir(nested);
  try {
    expect(await gitRevisionForWorkspace(root, [repository(nested)])).toBeNull();
    const status = gitRevisionSchema.parse(await gitRevisionForWorkspace(root, [repository(nested), repository(root)]));
    expect(status).toEqual({ branch: 'topic/review', commit, githubRepository: 'organization/project', staged: 1, unstaged: 2, untracked: 3, conflicts: 1 });
    expect(revisionReportNote(status)).toContain(commit + ', working tree has changes.');
    const detached = await gitRevisionForWorkspace(root, [repository(root, {
      HEAD: { commit },
      remotes: [{ name: 'origin', fetchUrl: 'https://example@github.com/organization/project.git' }],
    })]);
    expect(detached).toMatchObject({ branch: undefined, commit, githubRepository: undefined });
    const invalid = await gitRevisionForWorkspace(root, [repository(root, {
      HEAD: { name: 'feature\u202e-display', commit: 'bad' },
      remotes: [{ name: 'origin', fetchUrl: 'https://github.com.example.test/org/repo.git' }],
    })]);
    expect(invalid).toMatchObject({ branch: 'feature-display', commit: undefined, githubRepository: undefined });
  } finally {
    await rmdir(nested);
    await rmdir(root);
  }
});
