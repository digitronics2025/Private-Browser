import { useState } from 'react';
import type { VaultEntryDecision, VaultEntryDifference } from '../../electron/myvault/conflict-items';

export default function VaultConflictChoices({ entries, disabled, onApply }: {
  entries: VaultEntryDifference[];
  disabled: boolean;
  onApply: (decisions: VaultEntryDecision[]) => void;
}) {
  const [selected, setSelected] = useState<Record<string, VaultEntryDecision['keep']>>({});
  const date = (value: string) => new Date(value).toLocaleString();
  return <details>
    <summary>Choose entries individually</summary>
    <p>Choose a version for each differing entry. An absent version removes that entry from the merged vault.</p>
    {entries.map((entry) => <label key={entry.id}>{entry.local?.title || entry.cloud?.title || 'Vault entry'}
      <select value={selected[entry.id] ?? ''} disabled={disabled}
        onChange={(event) => {
          const value = event.currentTarget.value;
          setSelected((current) => {
            const next = { ...current };
            if (value === 'local' || value === 'cloud') next[entry.id] = value;
            else delete next[entry.id];
            return next;
          });
        }}>
        <option value="">Choose a copy</option>
        <option value="local">{entry.local ? `This computer · ${entry.local.title} · ${date(entry.local.updatedAt)}` : 'Absent on this computer · Remove entry'}</option>
        <option value="cloud">{entry.cloud ? `Cloud · ${entry.cloud.title} · ${date(entry.cloud.updatedAt)}` : 'Absent in the cloud · Remove entry'}</option>
      </select>
    </label>)}
    <button type="button" disabled={disabled || entries.some(({ id }) => !selected[id])}
      onClick={() => onApply(entries.map(({ id }) => ({ id, keep: selected[id] })))}>Apply entry choices</button>
  </details>;
}
