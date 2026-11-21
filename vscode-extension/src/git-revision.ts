import { realpath } from 'node:fs/promises';
import { relative } from 'node:path';
import type { GitRevision } from '@private-browser/bridge-protocol';

export interface GitRepositoryView {
  readonly rootUri: { readonly scheme: string; readonly fsPath: string };
  readonly state: {
    readonly HEAD: { readonly name?: string; readonly commit?: string; readonly upstream?: { readonly remote: string } } | undefined;
    readonly remotes: ReadonlyArray<{ readonly name: string; readonly fetchUrl?: string }>;
    readonly mergeChanges: readonly unknown[];
    readonly indexChanges: readonly unknown[];
    readonly workingTreeChanges: readonly unknown[];
    readonly untrackedChanges: readonly unknown[];
  };
}

function githubRepository(remote?: string): string | undefined {
  if (!remote || remote.length > 512) return undefined;
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([a-z\d-]{1,39})\/([a-z\d_.-]{1,104})\/?$/i.exec(remote);
  if (!match) return undefined;
  const repo = match[2].replace(/\.git$/i, '');
  if (!repo || repo === '.' || repo === '..' || repo.length > 100) return undefined;
  return match[1] + '/' + repo;
}

export async function gitRevisionForWorkspace(workspace: string, repositories: readonly GitRepositoryView[]): Promise<GitRevision | null> {
  const root = await realpath(workspace);
  for (const repository of repositories) {
    if (repository.rootUri.scheme !== 'file') continue;
    const path = await realpath(repository.rootUri.fsPath).catch(() => null);
    if (!path || relative(root, path) !== '') continue;
    const state = repository.state;
    const preferredRemote = state.HEAD?.upstream?.remote ?? 'origin';
    const remote = state.remotes.find(({ name }) => name === preferredRemote);
    const branch = state.HEAD?.name?.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 256) || undefined;
    const commit = state.HEAD?.commit?.toLowerCase();
    return {
      branch,
      commit: commit && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit) ? commit : undefined,
      githubRepository: githubRepository(remote?.fetchUrl),
      staged: state.indexChanges.length,
      unstaged: state.workingTreeChanges.length,
      untracked: state.untrackedChanges.length,
      conflicts: state.mergeChanges.length,
    };
  }
  return null;
}

export function revisionReportNote(revision: GitRevision): string {
  const branch = revision.branch ?? (revision.commit ? 'detached HEAD' : 'unknown branch');
  const changes = revision.staged + revision.unstaged + revision.untracked + revision.conflicts;
  return 'Git at report start: ' + branch + ', ' + (revision.commit ?? 'no commit')
    + (changes ? ', working tree has changes.' : ', clean working tree.');
}
