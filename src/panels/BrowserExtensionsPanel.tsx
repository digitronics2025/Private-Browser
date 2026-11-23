import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Plus, Shield, Trash2 } from 'lucide-react';
import type { AccountSpaceId, WorkspaceId } from '../../electron/types';
import type { BrowserExtensionReviewTicket, BrowserExtensionSummary } from '../../electron/browser-extension-store';
import { PanelHeader } from './common';

export function BrowserExtensionsPanel({ accountSpaceId, accountLabel, workspaceId, onToast }: {
  accountSpaceId: AccountSpaceId;
  accountLabel: string;
  workspaceId: WorkspaceId;
  onToast: (message: string, kind?: 'ok' | 'error') => void;
}) {
  const eligible = workspaceId !== 'banking' && workspaceId !== 'development';
  const [items, setItems] = useState<BrowserExtensionSummary[]>([]);
  const [review, setReview] = useState<BrowserExtensionReviewTicket>();
  const [selected, setSelected] = useState<string[]>([]);
  const [accessDrafts, setAccessDrafts] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const next = await window.privateBrowser.listBrowserExtensions();
    setItems(next);
    setAccessDrafts(Object.fromEntries(next.map((item) => [item.id, item.allowedOrigins])));
  };
  useEffect(() => {
    if (eligible) void refresh().catch((error: unknown) => onToast(error instanceof Error ? error.message : 'Could not load extensions.', 'error'));
  }, [accountSpaceId, eligible]);

  const inspect = async () => {
    setBusy(true);
    try {
      const next = await window.privateBrowser.inspectBrowserExtension();
      if (!next) return;
      setReview(next);
      setSelected([]);
    } catch (error) { onToast(error instanceof Error ? error.message : 'Could not review this extension.', 'error'); }
    finally { setBusy(false); }
  };

  const install = async () => {
    if (!review || selected.length === 0) return;
    setBusy(true);
    try {
      await window.privateBrowser.installBrowserExtension(review.reviewId, selected);
      setReview(undefined);
      await refresh();
      onToast('Extension added to this Account Space.');
    } catch (error) { onToast(error instanceof Error ? error.message : 'Could not install the extension.', 'error'); }
    finally { setBusy(false); }
  };

  const saveSites = async (item: BrowserExtensionSummary) => {
    setBusy(true);
    try {
      await window.privateBrowser.setBrowserExtensionSites(item.id, accessDrafts[item.id] ?? []);
      await refresh();
      onToast('Extension site access updated.');
    } catch (error) { onToast(error instanceof Error ? error.message : 'Could not update site access.', 'error'); await refresh(); }
    finally { setBusy(false); }
  };

  const remove = async (item: BrowserExtensionSummary) => {
    if (!window.confirm(`Remove ${item.name} and its access from ${accountLabel}?`)) return;
    setBusy(true);
    try {
      await window.privateBrowser.removeBrowserExtension(item.id);
      await refresh();
      onToast('Extension removed.');
    } catch (error) { onToast(error instanceof Error ? error.message : 'Could not remove the extension.', 'error'); }
    finally { setBusy(false); }
  };

  const toggle = (origins: string[], origin: string, checked: boolean) => checked
    ? [...new Set([...origins, origin])]
    : origins.filter((item) => item !== origin);

  return <div className="side-panel browser-extensions-panel">
    <PanelHeader icon={Shield} eyebrow={accountLabel} title="Extensions" />
    {!eligible ? <section className="settings-card"><strong>Extensions are disabled here.</strong><p>Banking and Development do not load browser extensions.</p></section> : <>
      <section className="settings-card">
        <div className="settings-row"><span><Shield size={17} /></span><div><strong>Private Browser extension support</strong><small>Unpacked Manifest V3 content-script extensions are isolated to this Account Space.</small></div><button type="button" disabled={busy} onClick={() => void inspect()}><Plus size={15} /> Add</button></div>
        <p>Extensions can read and change pages on sites you select. Site grants and extension storage stay in this Account Space. Extension files are copied locally; Private Browser does not download or auto-update them.</p>
        <p>Only exact HTTPS site access and the reviewed permissions <code>storage</code>, <code>scripting</code> and <code>activeTab</code> are supported. Browser-data access, broad wildcards, toolbar popups, Manifest V2, Chrome Web Store packages, and Banking/Development access are refused.</p>
      </section>
      <section className="settings-card" aria-label="Legacy stock checker status">
        <strong>Jumia + MarjaneMall Stock Checker · Version 0.5.2 remains blocked</strong>
        <p>This legacy extension requests broad seller-site access and stores an Accounting token in extension storage. Private Browser will not load or migrate it.</p>
      </section>

      {review && <section className="settings-card extension-review" aria-label="Review extension access">
        <h3>Review before adding</h3>
        <strong>{review.name} · {review.version}</strong>
        {review.description && <p>{review.description}</p>}
        <p>Choose each site where its content scripts may run. No site is selected by default.</p>
        <fieldset><legend>Requested HTTPS sites</legend>
          {review.requestedOrigins.map((origin) => <label key={origin} className="extension-origin"><input type="checkbox" checked={selected.includes(origin)} onChange={(event) => setSelected(toggle(selected, origin, event.target.checked))} /> {origin}</label>)}
        </fieldset>
        <p>Extension permissions · {review.permissions.length ? review.permissions.join(', ') : 'none'}</p>
        <div className="panel-actions"><button type="button" className="primary" disabled={busy || selected.length === 0} onClick={() => void install()}><Check size={15} /> Add to {accountLabel}</button><button type="button" disabled={busy} onClick={() => setReview(undefined)}>Cancel</button></div>
      </section>}

      {items.map((item) => {
        const draft = accessDrafts[item.id] ?? item.allowedOrigins;
        const changed = draft.length !== item.allowedOrigins.length || draft.some((origin) => !item.allowedOrigins.includes(origin));
        return <section className="settings-card installed-extension" key={item.id}>
          <div className="settings-row"><span><Shield size={17} /></span><div><strong>{item.name}</strong><small>Version {item.version} · {item.enabled ? 'Enabled' : 'No sites allowed'}</small></div><button type="button" className="toolbar-button small" aria-label={`Remove ${item.name}`} title="Remove extension" disabled={busy} onClick={() => void remove(item)}><Trash2 size={15} /></button></div>
          <fieldset><legend>Site access</legend>
            {item.requestedOrigins.map((origin) => <label key={origin} className="extension-origin"><input type="checkbox" checked={draft.includes(origin)} onChange={(event) => setAccessDrafts((current) => ({ ...current, [item.id]: toggle(current[item.id] ?? item.allowedOrigins, origin, event.target.checked) }))} /> {origin}</label>)}
          </fieldset>
          <p className="extension-permissions"><AlertTriangle size={14} /> Permissions · {item.permissions.length ? item.permissions.join(', ') : 'none'}</p>
          <button type="button" disabled={busy || !changed} onClick={() => void saveSites(item)}>Save site access</button>
        </section>;
      })}
    </>}
  </div>;
}
