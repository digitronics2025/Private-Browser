import type { CSSProperties } from 'react';
import { LockKeyhole, Settings, UserPlus } from 'lucide-react';
import type { AccountSpaceId, BrowserSnapshot, WorkspaceId } from '../../electron/types';
import { AccountAvatar, connectionLabel } from '../lib/accounts';
import { MenuHeading, MenuItem, MenuSeparator, MenuSurface } from './Menu';

export function ProfileMenu({ anchor, state, onClose, onSwitchAccount, onSwitchWorkspace, onManage, onLock }: {
  anchor: HTMLElement | null;
  state: BrowserSnapshot;
  onClose: () => void;
  onSwitchAccount: (id: AccountSpaceId) => void;
  onSwitchWorkspace: (id: WorkspaceId) => void;
  onManage: () => void;
  onLock: (id: AccountSpaceId) => void;
}) {
  const workspace = state.workspaces.find((item) => item.id === state.activeWorkspaceId)!;
  const active = state.accountSpaces.find((account) => account.id === state.activeAccountSpaceId)!;
  const accounts = state.accountSpaces.filter((account) => account.workspaceId === state.activeWorkspaceId).sort((a, b) => a.order - b.order);
  const unlocked = accounts.filter((account) => !account.locked);
  return (
    <MenuSurface anchor={anchor} placement="bottom-end" label="Account Spaces" className="profile-menu" onClose={onClose}>
      <div className={`profile-card ring-${active.color}`}>
        <AccountAvatar account={active} />
        <div>
          <strong>{active.displayName ?? active.label}</strong>
          <small>{active.email ?? 'Local browsing only'}</small>
          <span className="profile-chips">
            {active.kind === 'google' && <span className={`status-chip status-${active.googleConnection}`}>{connectionLabel(active)}</span>}
            {active.locked && <span className="status-chip">Locked</span>}
            {workspace.protected && <span className="status-chip protected"><LockKeyhole size={11} /> Protected</span>}
          </span>
        </div>
      </div>
      <MenuHeading>Spaces</MenuHeading>
      <div className="workspace-row">
        {state.workspaces.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitemradio"
            aria-checked={item.id === state.activeWorkspaceId}
            aria-label={`Switch to ${item.name}`}
            title={item.name}
            className={`workspace-chip ${item.id === state.activeWorkspaceId ? 'active' : ''}`}
            style={{ '--workspace-color': item.color } as CSSProperties}
            onClick={() => onSwitchWorkspace(item.id)}
          >
            <span className="workspace-chip-icon" aria-hidden="true">{item.protected ? <LockKeyhole size={13} /> : item.icon}</span>
            <span className="workspace-chip-name">{item.name}</span>
          </button>
        ))}
      </div>
      <MenuHeading><span>Account Spaces in {workspace.name}</span><small>Ctrl + Shift + ← / →</small></MenuHeading>
      {accounts.map((account) => (
        <MenuItem
          key={account.id}
          role="menuitemradio"
          checked={account.id === state.activeAccountSpaceId}
          disabled={account.locked}
          className="account-item"
          leading={<AccountAvatar account={account} />}
          label={<><strong>{account.label}</strong><small>{account.email ?? (account.locked ? 'Operationally locked' : 'Local browsing only')}</small></>}
          trailing={<i className={`connection-dot status-${account.googleConnection}`} aria-label={account.googleConnection} />}
          onSelect={() => onSwitchAccount(account.id)}
        />
      ))}
      <MenuSeparator />
      <MenuItem icon={Settings} className="manage-accounts" label={<><strong>Manage Account Spaces</strong><small>Identity, access, backup and isolation</small></>} onSelect={onManage} />
      <MenuItem icon={UserPlus} label="Add Account Space" onSelect={onManage} />
      {!active.locked && unlocked.length > 1 && <MenuItem icon={LockKeyhole} label={`Lock ${active.label}`} hint="Closes its pages and connections" onSelect={() => onLock(active.id)} />}
    </MenuSurface>
  );
}
