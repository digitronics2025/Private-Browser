import { ArrowLeft, Settings } from 'lucide-react';
import type { BrowserSnapshot } from '../../electron/types';
import { PanelHeader } from './common';

export function SetupGuide({ state, isDefault, chromeImported, firstLaunch, onAccounts, onImport, onDefault, onVault, onExit, onFinish }: {
  state: BrowserSnapshot;
  isDefault: boolean | null;
  chromeImported: boolean;
  firstLaunch: boolean;
  onAccounts: () => void;
  onImport: () => void;
  onDefault: () => void;
  onVault: () => void;
  onExit: () => void;
  onFinish: () => void;
}) {
  const account = state.accountSpaces.find((item) => item.id === state.activeAccountSpaceId);
  const protectedSpace = state.activeWorkspaceId === 'banking';
  const vaultStatus = protectedSpace || state.activeWorkspaceId === 'development' ? undefined : state.setupVaultStatus;
  const items = [
    { title: 'Account Spaces', detail: account?.locked ? 'Current Account Space is locked' : account ? account.label + ' is ready' : 'Choose an Account Space',
      action: 'Manage Account Spaces', run: onAccounts, disabled: protectedSpace },
    { title: 'Chrome data', detail: chromeImported ? 'A Chrome import has run' : 'Optional bookmarks and history import',
      action: 'Choose Chrome data', run: onImport, disabled: protectedSpace },
    { title: 'Default browser', detail: isDefault === true ? 'Ready in Windows' : isDefault === false ? 'Optional Windows setting' : 'Checking Windows association…',
      action: 'Open Windows Default Apps', run: onDefault, disabled: protectedSpace },
    { title: 'MyVault', detail: vaultStatus === 'unlocked' ? 'Unlocked and ready' : vaultStatus === 'locked' ? 'Paired and locked'
      : vaultStatus === 'unconfigured' ? 'Optional vault pairing' : vaultStatus ? 'Review vault status' : 'Unavailable in this Account Space',
      action: 'Open MyVault', run: onVault, disabled: !vaultStatus || protectedSpace },
    { title: 'Google tools', detail: account?.googleConnection === 'connected' ? 'Connected for this Account Space' : 'Optional tools with separate permissions',
      action: 'Review Google tools', run: onAccounts, disabled: protectedSpace },
  ];
  return <div className="side-panel setup-guide" aria-label="Setup guide">
    <PanelHeader icon={Settings} eyebrow="Settings" title="Setup guide" />
    <button type="button" className="text-button" onClick={onExit}><ArrowLeft size={14} /> Back to Settings</button>
    <p>Browsing is ready. Open any step when you need it.</p>
    <ul>
      {items.map((item) => <li className="settings-card" key={item.title}>
        <div><strong>{item.title}</strong><p>{item.detail}</p></div>
        <button type="button" className="secondary-button" onClick={item.run} disabled={item.disabled}>{item.action}</button>
      </li>)}
    </ul>
    <div className="panel-actions">
      <button type="button" className="primary-button" onClick={onFinish}>Done</button>
      {firstLaunch && <button type="button" className="text-button" onClick={onFinish}>Skip setup</button>}
    </div>
  </div>;
}
