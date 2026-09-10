import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PersistedState, Workspace, WorkspaceId } from './types.js';
import { isAllowedRemoteUrl } from './security.js';

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
      return sanitizeState(parsed);
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

export function sanitizeState(input: PersistedState): PersistedState {
  const workspaceIds = new Set(WORKSPACES.map((workspace) => workspace.id));
  const defaults = createDefaultState();
  const tabs = input.tabs
    .filter((tab) => workspaceIds.has(tab.workspaceId) && typeof tab.id === 'string')
    .filter((tab) => tab.url === 'private://home' || isAllowedRemoteUrl(tab.url))
    .slice(0, 100)
    .map((tab) => ({
      id: tab.id,
      workspaceId: tab.workspaceId,
      title: typeof tab.title === 'string' ? tab.title.slice(0, 500) : 'New tab',
      url: tab.url,
      isHome: tab.url === 'private://home' || Boolean(tab.isHome),
    }));

  for (const workspace of WORKSPACES) {
    if (!tabs.some((tab) => tab.workspaceId === workspace.id)) {
      tabs.push(defaults.tabs.find((tab) => tab.workspaceId === workspace.id)!);
    }
  }

  const activeTabByWorkspace: PersistedState['activeTabByWorkspace'] = {};
  for (const workspace of WORKSPACES) {
    const requested = input.activeTabByWorkspace?.[workspace.id];
    activeTabByWorkspace[workspace.id] = tabs.some((tab) => tab.id === requested && tab.workspaceId === workspace.id)
      ? requested
      : tabs.find((tab) => tab.workspaceId === workspace.id)!.id;
  }

  const validWorkspace = workspaceIds.has(input.activeWorkspaceId) ? input.activeWorkspaceId : 'digitronics';
  return {
    version: 1,
    activeWorkspaceId: validWorkspace,
    tabs,
    activeTabByWorkspace,
    bookmarks: Array.isArray(input.bookmarks) ? input.bookmarks.filter((item) => workspaceIds.has(item.workspaceId) && isAllowedRemoteUrl(item.url)).slice(0, 1000) : [],
    history: Array.isArray(input.history) ? input.history.filter((item) => workspaceIds.has(item.workspaceId) && isAllowedRemoteUrl(item.url)).slice(0, 500) : [],
    privacyLog: Array.isArray(input.privacyLog) ? input.privacyLog.slice(0, 100) : [],
    trackerBlocking: input.trackerBlocking !== false,
  };
}
