import type { AccountSpaceSummary } from '../../electron/types';

export function accountInitials(account: AccountSpaceSummary): string {
  return (account.displayName ?? account.label).split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'AS';
}

export function AccountAvatar({ account }: { account: AccountSpaceSummary }) {
  return account.avatarDataUrl
    ? <img className="account-avatar-image" src={account.avatarDataUrl} alt="" />
    : <span className={`account-avatar-fallback account-${account.color}`}>{accountInitials(account)}</span>;
}

/** Only states the user must act on earn a badge; routine states stay quiet. */
export function accountNeedsAction(account: AccountSpaceSummary): boolean {
  return account.googleConnection === 'reconnect-required' || account.googleConnection === 'partial-scopes' || account.googleConnection === 'account-corrupt';
}

export function connectionLabel(account: AccountSpaceSummary): string {
  if (account.kind !== 'google') return 'Local browsing only';
  return `Google ${account.googleConnection.replaceAll('-', ' ')}`;
}
