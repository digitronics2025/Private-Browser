import { useEffect, useRef, useState } from 'react';
import type { BrowsingPrivacyAction } from '../../electron/browsing-protection';
import type { BrowserSnapshot } from '../../electron/types';
import { HISTORY_RETENTION_DAYS } from '../../electron/ui-preferences';

export default function BrowsingPrivacySettings({ state, onToast, reveal, onReveal }: {
  state: BrowserSnapshot;
  onToast: (message: string, style: 'ok' | 'error') => void;
  reveal: boolean;
  onReveal: () => void;
}) {
  const section = useRef<HTMLFieldSetElement>(null);
  const busy = useRef(false);
  const [working, setWorking] = useState(false);
  const protection = state.browsingProtection;
  const disabled = working || protection === undefined || state.activeWorkspaceId === 'banking'
    || state.accountSpaces.find(({ id }) => id === state.activeAccountSpaceId)?.locked !== false;
  useEffect(() => {
    if (reveal) {
      section.current?.scrollIntoView({ block: 'nearest' });
      onReveal();
    }
  }, [reveal, onReveal]);
  const run = async (action: BrowsingPrivacyAction, value?: number | boolean) => {
    if (busy.current) return;
    busy.current = true;
    setWorking(true);
    try {
      if (await window.privateBrowser.changeBrowsingPrivacy(state.activeAccountSpaceId, action, value)) {
        const messages: Record<BrowsingPrivacyAction, string> = {
          protect: 'Local browsing encryption is enabled.', export: 'Encrypted recovery file saved.', restore: 'Browsing data merged.',
          retention: 'History retention updated.', log: 'Privacy log setting updated.',
        };
        onToast(messages[action], 'ok');
      }
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'The browsing privacy setting could not be updated.', 'error');
    } finally {
      busy.current = false;
      setWorking(false);
    }
  };
  return <fieldset ref={section} className="settings-card screen-privacy-settings" disabled={disabled}>
    <legend>Browsing privacy</legend>
    <p>Encryption ties this browser's tabs, bookmarks and history to this device. Keep an encrypted recovery file and its passphrase for each Account Space you need to move.</p>
    {protection === 'on' ? <p role="status">Local browsing encryption is on.</p>
      : protection === 'unavailable' ? <p role="status">This device cannot open the local encryption key. A recovery file can be restored in an accessible Account Space.</p>
        : <button type="button" onClick={() => void run('protect')}>{protection === 'pending' ? 'Retry encryption' : 'Enable browsing encryption'}</button>}
    <div className="panel-actions">
      <button type="button" onClick={() => void run('export')}>Export recovery file</button>
      <button type="button" onClick={() => void run('restore')}>Restore recovery file</button>
    </div>
    <label>Keep browsing history
      <select value={state.ui.historyRetentionDays ?? 0} onChange={(event) => void run('retention', Number(event.currentTarget.value))}>
        {HISTORY_RETENTION_DAYS.map((days) => <option key={days} value={days}>{days ? `${days} days` : 'No time limit'}</option>)}
      </select>
    </label>
    <label><input type="checkbox" checked={Boolean(state.ui.minimalPrivacyLog)} onChange={(event) => void run('log', event.currentTarget.checked)} /> Show only event type and time in the privacy log</label>
  </fieldset>;
}
