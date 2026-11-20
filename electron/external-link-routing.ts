import { WORKSPACES } from './state-store.js';
import type { AccountSpaceId, AccountSpaceSummary, RuntimeBrowserStateV2 } from './types.js';

export function isAvailableRegularAccount(state: RuntimeBrowserStateV2, account: AccountSpaceSummary): boolean {
  return !account.locked
    && Boolean(state.activeTabByAccountSpace[account.id])
    && state.recovery?.accountSpaceId !== account.id
    && state.accountHealth.every((health) =>
      health.accountSpaceId !== account.id || health.status !== 'account-corrupt')
    && WORKSPACES.some((workspace) => workspace.id === account.workspaceId && !workspace.protected);
}

export function externalLinkAccounts(state: RuntimeBrowserStateV2): AccountSpaceSummary[] {
  return state.accountSpaces.filter((account) => isAvailableRegularAccount(state, account));
}

export function preferredExternalLinkAccount(
  state: RuntimeBrowserStateV2,
  eligible = externalLinkAccounts(state),
): AccountSpaceId | undefined {
  const activeId = state.activeAccountSpaceByWorkspace[state.activeWorkspaceId];
  if (eligible.some((account) => account.id === activeId)) return activeId;
  const recentId = state.lastExternalLinkAccountSpaceId;
  if (eligible.some((account) => account.id === recentId)) return recentId;
  return eligible.length === 1 ? eligible[0].id : undefined;
}
