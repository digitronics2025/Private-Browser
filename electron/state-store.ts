import { randomUUID } from 'node:crypto';
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
    bookmarkBarVisible: true,
  };
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
    bookmarks: Array.isArray(input.bookmarks) ? input.bookmarks
      .filter((item) => workspaceIds.has(item.workspaceId) && isAllowedRemoteUrl(item.url))
      .slice(0, 25_000)
      .map((item, index) => ({
        id: typeof item.id === 'string' ? item.id : randomUUID(),
        title: typeof item.title === 'string' ? item.title.slice(0, 500) : item.url,
        url: item.url,
        workspaceId: item.workspaceId,
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
        location: item.location === 'other' ? 'other' as const : 'bar' as const,
        folderPath: Array.isArray(item.folderPath)
          ? item.folderPath.filter((part): part is string => typeof part === 'string').slice(0, 20).map((part) => part.slice(0, 200))
          : [],
        order: Number.isSafeInteger(item.order) && item.order >= 0 ? item.order : index,
        orderPath: Array.isArray(item.orderPath)
          ? item.orderPath.filter((part): part is number => Number.isSafeInteger(part) && part >= 0).slice(0, 21)
          : [Number.isSafeInteger(item.order) && item.order >= 0 ? item.order : index],
      })) : [],
    history: Array.isArray(input.history) ? input.history.filter((item) => workspaceIds.has(item.workspaceId) && isAllowedRemoteUrl(item.url)).slice(0, 10_000) : [],
    privacyLog: Array.isArray(input.privacyLog) ? input.privacyLog.slice(0, 100) : [],
    trackerBlocking: input.trackerBlocking !== false,
    bookmarkBarVisible: input.bookmarkBarVisible !== false,
  };
}
