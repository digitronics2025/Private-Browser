import type { BrowserTab, TabBatchScope, TabGroup, TabOrganizationAction } from './types.js';

export function orderAccountTabs<T extends Pick<BrowserTab, 'id' | 'pinned' | 'groupId'>>(tabs: readonly T[]): T[] {
  const grouped = new Map<string, T[]>();
  for (const tab of tabs) {
    if (!tab.pinned && tab.groupId) {
      const members = grouped.get(tab.groupId) ?? [];
      members.push(tab);
      grouped.set(tab.groupId, members);
    }
  }
  const ordered = tabs.filter((tab) => tab.pinned);
  for (const tab of tabs) {
    if (tab.pinned) continue;
    if (!tab.groupId) ordered.push(tab);
    else {
      const members = grouped.get(tab.groupId);
      if (members) ordered.push(...members);
      grouped.delete(tab.groupId);
    }
  }
  return ordered;
}

export function organizeTabs<T extends BrowserTab>(
  tabs: readonly T[],
  groups: readonly TabGroup[],
  action: TabOrganizationAction,
  newGroupId: string,
): { tabs: T[]; groups: TabGroup[] } {
  const nextTabs = tabs.map((tab) => ({ ...tab }));
  const nextGroups = groups.map((group) => ({ ...group }));
  if (action.kind === 'collapse-group') {
    const group = nextGroups.find((candidate) => candidate.id === action.groupId);
    if (!group) throw new Error('Tab group is unavailable in this Account Space');
    group.collapsed = action.collapsed;
  } else {
    const tab = nextTabs.find((candidate) => candidate.id === action.tabId);
    if (!tab) throw new Error('Tab is unavailable in this Account Space');
    if (action.kind === 'pin') {
      tab.pinned = action.pinned || undefined;
      if (tab.pinned) tab.groupId = undefined;
    } else if (action.kind === 'create-group') {
      if (nextGroups.length >= 100) throw new Error('This Account Space has too many tab groups');
      nextGroups.push({ id: newGroupId, name: action.name.trim(), collapsed: false });
      tab.pinned = undefined;
      tab.groupId = newGroupId;
    } else {
      if (action.groupId && !nextGroups.some((group) => group.id === action.groupId)) throw new Error('Tab group is unavailable in this Account Space');
      if (action.groupId) tab.pinned = undefined;
      tab.groupId = action.groupId ?? undefined;
    }
  }
  return { tabs: orderAccountTabs(nextTabs), groups: nextGroups.filter((group) => nextTabs.some((tab) => tab.groupId === group.id)) };
}

export function keepTabBlockIndex(tabs: readonly BrowserTab[], tab: BrowserTab, toIndex: number): number {
  if (!tab.pinned && !tab.groupId) return toIndex;
  const indices = tabs.flatMap((candidate, index) =>
    (tab.pinned ? candidate.pinned : candidate.groupId === tab.groupId) ? [index] : []);
  return Math.max(indices[0] ?? 0, Math.min(toIndex, indices.at(-1) ?? toIndex));
}

export function replaceAccountTabOrder<T extends BrowserTab>(tabs: T[], accountSpaceId: string, ordered: T[]): T[] {
  let index = 0;
  return tabs.map((tab) => tab.accountSpaceId === accountSpaceId ? ordered[index++]! : tab);
}

export function tabBatchTargets<T extends BrowserTab>(tabs: readonly T[], id: string, scope: TabBatchScope): T[] {
  const index = tabs.findIndex((tab) => tab.id === id);
  const anchor = tabs[index];
  if (!anchor || anchor.workspaceId === 'banking') return [];
  return tabs.filter((tab, position) => {
    if (tab.pinned || tab.accountSpaceId !== anchor.accountSpaceId) return false;
    if (scope === 'right') return position > index;
    if (scope === 'group') return Boolean(anchor.groupId) && anchor.groupId === tab.groupId;
    return tab.id !== id;
  });
}
