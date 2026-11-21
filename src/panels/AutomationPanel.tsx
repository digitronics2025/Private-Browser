import { useEffect, useState } from 'react';
import { Play, Plus, Shield, Zap } from 'lucide-react';
import type { AccountSpaceId, BrowserRoutine, BrowserSnapshot, BrowserTab, RoutineRunResult, TabSetInput } from '../../electron/types';
import { MAX_ROUTINE_ITEMS } from '../../electron/browser-routines';
import { canSaveTabInSet } from '../../electron/tab-sets';
import { EmptyState, PanelHeader } from './common';

const completedTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

interface TabSetDraft {
  accountSpaceId: AccountSpaceId;
  kind: TabSetInput['kind'];
  tabs: BrowserTab[];
  selected: Set<string>;
  name: string;
}

export function AutomationPanel({ state, onToast }: {
  state: BrowserSnapshot;
  onToast: (message: string, kind?: 'ok' | 'error') => void;
}) {
  const [draft, setDraft] = useState<BrowserRoutine>();
  const [busy, setBusy] = useState(false);
  const [lastRun, setLastRun] = useState<{ id: string; result: RoutineRunResult }>();
  const [tabSet, setTabSet] = useState<TabSetDraft>();
  useEffect(() => { setTabSet(undefined); }, [state.activeAccountSpaceId]);
  const eligibleTabs = state.tabs.filter((tab) => canSaveTabInSet(tab, state.activeAccountSpaceId));
  const accounts = state.accountSpaces.filter((account) => account.workspaceId !== 'banking');
  const nameOf = (id: AccountSpaceId) => {
    const account = accounts.find((item) => item.id === id);
    const workspace = state.workspaces.find((item) => item.id === account?.workspaceId);
    return account ? (workspace?.name ?? account.workspaceId) + ' / ' + account.label : 'Unavailable Account Space';
  };
  if (state.activeWorkspaceId === 'banking') return <div className="side-panel"><EmptyState icon={Shield} text="Routines are unavailable in Banking." /></div>;

  const operate = async (action: () => Promise<void>) => {
    setBusy(true);
    try { await action(); }
    catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setBusy(false); }
  };
  const newLink = () => ({ url: '', accountSpaceId: state.activeAccountSpaceId });
  const moveLink = (index: number, offset: number) => {
    if (!draft) return;
    const next = index + offset;
    const links = draft.links.slice();
    [links[index], links[next]] = [links[next], links[index]];
    setDraft({ ...draft, links, focusIndex: draft.focusIndex === index ? next : draft.focusIndex === next ? index : draft.focusIndex });
  };
  const removeLink = (index: number) => {
    if (!draft) return;
    const links = draft.links.filter((_, position) => position !== index);
    const focusIndex = draft.focusIndex > index ? draft.focusIndex - 1 : Math.min(draft.focusIndex, links.length - 1);
    setDraft({ ...draft, links, focusIndex });
  };
  const editLink = (index: number, field: 'url' | 'accountSpaceId', value: string) => {
    if (!draft) return;
    setDraft({ ...draft, links: draft.links.map((link, position) => position === index ? { ...link, [field]: value } : link) });
  };
  const start = (routine: BrowserRoutine) => void operate(async () => {
    setLastRun({ id: routine.id, result: await window.privateBrowser.runRoutine(routine.id) });
  });
  const previewTabs = (kind: TabSetInput['kind']) => {
    const tabs = eligibleTabs.map((tab) => ({ ...tab }));
    const selected = new Set(tabs.slice(0, MAX_ROUTINE_ITEMS).map((tab) => tab.id));
    setTabSet({ accountSpaceId: state.activeAccountSpaceId, kind, tabs, selected, name: '' });
  };
  const visibleSet = tabSet?.accountSpaceId === state.activeAccountSpaceId ? tabSet : undefined;

  return <div className="side-panel">
    <PanelHeader icon={Zap} eyebrow="Account Spaces" title="Routines" />
    {visibleSet ? <form className="settings-card routine-form" onSubmit={(event) => {
      event.preventDefault();
      const { accountSpaceId, kind, name, tabs, selected } = visibleSet;
      void operate(async () => {
        const saved = await window.privateBrowser.saveTabSet({ accountSpaceId, kind, name,
          tabs: tabs.filter((tab) => selected.has(tab.id)).map(({ id, url }) => ({ id, url })),
        });
        setTabSet(undefined);
        onToast(kind === 'routine' ? 'Routine saved with ' + saved + ' tabs.'
          : saved ? saved + (saved === 1 ? ' bookmark added.' : ' bookmarks added.') : 'The selected pages are already in this folder.');
      });
    }}>
      <label>{visibleSet.kind === 'routine' ? 'Routine name' : 'Bookmarks bar folder'}<input required maxLength={80}
        value={visibleSet.name} onChange={(event) => setTabSet({ ...visibleSet, name: event.target.value })} /></label>
      <fieldset className="routine-checklist">
        <legend>Tabs in {nameOf(visibleSet.accountSpaceId)}</legend>
        <p role="status">{visibleSet.selected.size} selected (up to {MAX_ROUTINE_ITEMS})</p>
        {visibleSet.tabs.map((tab) => {
          const checked = visibleSet.selected.has(tab.id);
          return <label key={tab.id}>
            <input type="checkbox" checked={checked} disabled={busy || (!checked && visibleSet.selected.size >= MAX_ROUTINE_ITEMS)}
              onChange={(event) => {
                const selected = new Set(visibleSet.selected);
                if (event.currentTarget.checked) selected.add(tab.id);
                else selected.delete(tab.id);
                setTabSet({ ...visibleSet, selected });
              }} />
            <span>{tab.title || 'Untitled page'}<small>{tab.url}</small></span>
          </label>;
        })}
      </fieldset>
      <div className="panel-actions">
        <button type="submit" disabled={busy || !visibleSet.selected.size || !visibleSet.name.trim()}>
          {visibleSet.kind === 'routine' ? 'Save routine' : 'Add bookmarks'}
        </button>
        <button type="button" disabled={busy} onClick={() => setTabSet(undefined)}>Cancel</button>
      </div>
    </form> : draft ? <form className="settings-card routine-form" onSubmit={(event) => {
      event.preventDefault();
      void operate(async () => { await window.privateBrowser.saveRoutine(draft); setDraft(undefined); });
    }}>
      <label>Routine name <input required maxLength={80} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
      <fieldset>
        <legend>Links in opening order</legend>
        {draft.links.map((link, index) => <div className="routine-form-row" key={index}>
          <label>Web address {index + 1}<input required maxLength={4096} placeholder="https://example.com" value={link.url} onChange={(event) => editLink(index, 'url', event.target.value)} /></label>
          <label>Account Space {index + 1}<select value={link.accountSpaceId} onChange={(event) => editLink(index, 'accountSpaceId', event.target.value)}>
            {!accounts.some((account) => account.id === link.accountSpaceId) && <option value={link.accountSpaceId}>Unavailable Account Space</option>}
            {accounts.map((account) => <option key={account.id} value={account.id}>{nameOf(account.id)}</option>)}
          </select></label>
          <div className="panel-actions">
            <button type="button" disabled={index === 0} aria-label={'Move link ' + (index + 1) + ' up'} onClick={() => moveLink(index, -1)}>Up</button>
            <button type="button" disabled={index === draft.links.length - 1} aria-label={'Move link ' + (index + 1) + ' down'} onClick={() => moveLink(index, 1)}>Down</button>
            <button type="button" disabled={draft.links.length === 1} aria-label={'Remove link ' + (index + 1)} onClick={() => removeLink(index)}>Remove</button>
          </div>
        </div>)}
        <div className="panel-actions"><button type="button" disabled={draft.links.length === MAX_ROUTINE_ITEMS} onClick={() => setDraft({ ...draft, links: [...draft.links, newLink()] })}>Add link</button></div>
        <label>Focus when run<select value={draft.focusIndex} onChange={(event) => setDraft({ ...draft, focusIndex: Number(event.target.value) })}>
          {draft.links.map((link, index) => <option value={index} key={index}>{index + 1}. {link.url || 'Untitled link'}</option>)}
        </select></label>
      </fieldset>
      <fieldset>
        <legend>Checklist</legend>
        {draft.checklist.map((item, index) => <div className="routine-form-row" key={index}>
          <label>Checklist item {index + 1}<input required maxLength={120} value={item.label} onChange={(event) => {
            setDraft({ ...draft, checklist: draft.checklist.map((row, position) => position === index ? { label: event.target.value } : row) });
          }} /></label>
          <div className="panel-actions"><button type="button" aria-label={'Remove checklist item ' + (index + 1)}
            onClick={() => setDraft({ ...draft, checklist: draft.checklist.filter((_, position) => position !== index) })}>Remove</button></div>
        </div>)}
        <div className="panel-actions"><button type="button" disabled={draft.checklist.length === MAX_ROUTINE_ITEMS}
          onClick={() => setDraft({ ...draft, checklist: [...draft.checklist, { label: '' }] })}>Add checklist item</button></div>
      </fieldset>
      <div className="panel-actions"><button type="submit" disabled={busy}>Save routine</button><button type="button" disabled={busy} onClick={() => setDraft(undefined)}>Cancel</button></div>
    </form> : <>
      <div className="panel-actions">
        <button type="button" onClick={() => setDraft({ id: crypto.randomUUID(), name: '', links: [newLink()], focusIndex: 0, checklist: [] })}><Plus size={14} /> New routine</button>
        <button type="button" disabled={!eligibleTabs.length} onClick={() => previewTabs('routine')}>Save open tabs as a routine</button>
        <button type="button" disabled={!eligibleTabs.length} onClick={() => previewTabs('bookmarks')}>Bookmark this set</button>
      </div>
      <div className="automation-list">{(state.routines ?? []).map((routine) => <details key={routine.id} className="settings-card routine-details">
        <summary>{routine.name}</summary>
        <ol className="routine-preview">
          {routine.links.map((link, index) => <li key={index}>
            <strong>{link.url}</strong><small>{nameOf(link.accountSpaceId)}{index === routine.focusIndex ? ' · Focus' : ''}</small>
          </li>)}
        </ol>
        <div className="panel-actions">
          <button type="button" disabled={busy} onClick={() => start(routine)}><Play size={14} /> Run routine</button>
          <button type="button" disabled={busy} onClick={() => setDraft(structuredClone(routine))}>Edit</button>
          <button type="button" disabled={busy} className="danger" onClick={() => {
            if (window.confirm('Delete the routine “' + routine.name + '”?')) void operate(() => window.privateBrowser.deleteRoutine(routine.id));
          }}>Delete</button>
        </div>
        {lastRun?.id === routine.id && <div role="status" className="routine-result">
          <p>{lastRun.result.opened} added · {lastRun.result.reused} reused · {lastRun.result.skipped.length} skipped</p>
          {lastRun.result.skipped.map((index) => <p key={index}>Link {index + 1} could not be opened in its selected Account Space.</p>)}
          {lastRun.result.focusUnavailable && <p>The selected page could not take focus.</p>}
        </div>}
        {routine.checklist.length > 0 && <fieldset className="routine-checklist">
          <legend>Checklist</legend>
          {routine.checklist.map((item, index) => <label key={index}>
            <input type="checkbox" disabled={busy} checked={Boolean(item.done)}
              onChange={(event) => { const checked = event.currentTarget.checked; void operate(() => window.privateBrowser.markRoutineChecklist(routine.id, index, checked)); }} />
            <span>{item.label}{item.completedAt && <small>Last done {completedTime.format(new Date(item.completedAt))}</small>}</span>
          </label>)}
          <div className="panel-actions"><button type="button" disabled={busy || !routine.checklist.some((item) => item.done)}
            onClick={() => void operate(() => window.privateBrowser.resetRoutineChecklist(routine.id))}>Reset checklist</button></div>
        </fieldset>}
      </details>)}</div>
    </>}
  </div>;
}
