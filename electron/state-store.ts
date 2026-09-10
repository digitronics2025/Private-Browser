import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PersistedState, Workspace, WorkspaceId } from './types.js';

export const WORKSPACES: Workspace[] = [
  { id: 'digitronics', name: 'Digitronics', color: '#5b8cff', icon: 'D', protected: false },
  { id: 'tenten', name: 'TenTen', color: '#ffbd59', icon: 'T', protected: false },
  { id: 'development', name: 'Development', color: '#a78bfa', icon: '</>', protected: false },
  { id: 'personal', name: 'Personal', color: '#4fd1a5', icon: 'P', protected: false },
  { id: 'banking', name: 'Banking', color: '#ff6b7a', icon: '$', protected: true },
];

export function createDefaultState(): PersistedState {
  const tabs = WORKSPACES.map((workspace) => ({
    id: randomUUID(),
    workspaceId: workspace.id,
    title: 'New tab',
    url: 'private://home',
    isHome: true,
  }));
  return {
    version: 1,
    activeWorkspaceId: 'digitronics',
    tabs,
    activeTabByWorkspace: Object.fromEntries(tabs.map((tab) => [tab.workspaceId, tab.id])) as Record<WorkspaceId, string>,
    bookmarks: [],
    history: [],
    privacyLog: [],
    trackerBlocking: true,
  };
}

export class StateStore {
  private state: PersistedState;

  constructor(private readonly filePath: string) {
    this.state = this.load();
  }

  get(): PersistedState {
    return structuredClone(this.state);
  }

  update(mutator: (state: PersistedState) => void): PersistedState {
    mutator(this.state);
    this.save();
    return this.get();
  }

  private load(): PersistedState {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as PersistedState;
      if (parsed.version !== 1 || !Array.isArray(parsed.tabs)) throw new Error('Unsupported state');
      return parsed;
    } catch {
      return createDefaultState();
    }
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(temporaryPath, this.filePath);
  }
}
