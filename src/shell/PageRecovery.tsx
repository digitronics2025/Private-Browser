import { useState } from 'react';
import { RotateCw } from 'lucide-react';
import type { BrowserTab, TabProblem } from '../../electron/types';
import { SafeDiagnostics } from '../panels/SafeDiagnostics';

const reasons: Record<TabProblem, string> = {
  crashed: 'The tab stopped responding. You can reload it or go back.',
  certificate: 'The site’s certificate could not be verified.',
  offline: 'Check your internet connection and try again.',
  network: 'The site did not load. Check the address or try again.',
};

export function PageRecovery({ tab, onReload, onBack }: {
  tab: BrowserTab;
  onReload: () => void;
  onBack: () => void;
}) {
  const title = tab.problem === 'crashed' ? 'Page crashed' : tab.problem ? 'Page could not load' : 'Tab restore paused';
  const detail = tab.problem ? reasons[tab.problem] : 'This saved tab will load when you resume it.';
  return <div className="page-surface page-recovery">
    <section className="recovery-card" aria-labelledby="page-recovery-title">
      <h2 id="page-recovery-title">{title}</h2>
      <p role="status">{detail}</p>
      <div className="recovery-actions">
        <button type="button" className="primary-button" onClick={onReload}><RotateCw size={16} />{tab.problem ? 'Reload page' : 'Resume tab'}</button>
        {tab.problem && <button type="button" className="toolbar-button" disabled={!tab.canGoBack} onClick={onBack}>Back</button>}
      </div>
      {tab.problem && <SafeDiagnostics reason={tab.problem === 'certificate' ? 'PB-RECOVERY-CERTIFICATE' : 'PB-RECOVERY-PAGE'} />}
    </section>
  </div>;
}

export function StartupRecovery({ tabs, failedTabId, onRestore }: {
  tabs: BrowserTab[];
  failedTabId: string;
  onRestore: (ids: string[]) => Promise<void>;
}) {
  const [selected, setSelected] = useState(() => new Set(tabs.filter((tab) => tab.id !== failedTabId && !tab.restorePaused).map((tab) => tab.id)));
  const [busy, setBusy] = useState(false);
  const submit = async (ids: string[]) => {
    setBusy(true);
    try { await onRestore(ids); } finally { setBusy(false); }
  };
  return <div className="page-surface page-recovery">
    <section className="recovery-card" aria-labelledby="startup-recovery-title">
      <h2 id="startup-recovery-title">Choose which tabs to restore</h2>
      <p>A tab failed during two startup attempts. Choose the tabs to keep ready. Paused tabs stay saved.</p>
      <fieldset className="startup-tab-list" disabled={busy}>
        <legend>Saved tabs</legend>
        {tabs.map((tab) => <label key={tab.id}>
          <input type="checkbox" checked={selected.has(tab.id)} onChange={(event) => {
            const checked = event.currentTarget.checked;
            setSelected((previous) => {
              const next = new Set(previous);
              if (checked) next.add(tab.id);
              else next.delete(tab.id);
              return next;
            });
          }} />
          <span>{tab.isHome ? 'New tab' : tab.title || tab.url}{tab.id === failedTabId && ' (startup failed)'}</span>
        </label>)}
      </fieldset>
      <div className="recovery-actions">
        <button type="button" className="primary-button" disabled={busy || !selected.size} onClick={() => void submit(tabs.filter((tab) => selected.has(tab.id)).map((tab) => tab.id))}>Restore selected tabs</button>
        <button type="button" className="primary-button" disabled={busy} onClick={() => void submit([])}>Start with a new tab</button>
      </div>
      <SafeDiagnostics reason="PB-RECOVERY-STARTUP" />
    </section>
  </div>;
}
