import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CURRENT_SCHEMA_VERSION, type VaultItem, type VaultPayload } from './types.js';

export interface VaultEntryDecision { id: string; keep: 'local' | 'cloud' }
export interface VaultEntryDifference {
  id: string;
  local?: { title: string; type: VaultItem['type']; updatedAt: string };
  cloud?: { title: string; type: VaultItem['type']; updatedAt: string };
}

export const MAX_CONFLICT_ENTRY_CHOICES = 100;

interface EntryChoice { metadata: VaultEntryDifference; local?: VaultItem; cloud?: VaultItem }

/** Item-by-item selection is available only when the rest of the vault is identical. */
export function planVaultEntrySelection(local: VaultPayload, cloud: VaultPayload): { identical: VaultItem[]; choices: EntryChoice[] } | undefined {
  const { items: localItems, updatedAt: _localAt, unreadablePasskeys: localUnreadable, ...localRest } = local;
  const { items: cloudItems, updatedAt: _cloudAt, unreadablePasskeys: cloudUnreadable, ...cloudRest } = cloud;
  if (local.schemaVersion !== CURRENT_SCHEMA_VERSION || cloud.schemaVersion !== CURRENT_SCHEMA_VERSION || localUnreadable || cloudUnreadable
    || !isDeepStrictEqual(localRest, cloudRest)) return undefined;
  const localById = new Map(localItems.map((item) => [item.id, item]));
  const cloudById = new Map(cloudItems.map((item) => [item.id, item]));
  if (localById.size !== localItems.length || cloudById.size !== cloudItems.length) return undefined;
  const choices: EntryChoice[] = [];
  const identical: VaultItem[] = [];
  const safe = (item?: VaultItem) => item && { title: item.title, type: item.type, updatedAt: item.updatedAt };
  for (const itemId of new Set([...localById.keys(), ...cloudById.keys()])) {
    const a = localById.get(itemId);
    const b = cloudById.get(itemId);
    if (a && b && isDeepStrictEqual(a, b)) {
      identical.push(a);
      continue;
    }
    const id = createHash('sha256').update(`myvault-item:${itemId}`).digest('hex');
    choices.push({ metadata: { id, local: safe(a), cloud: safe(b) }, local: a, cloud: b });
    if (choices.length > MAX_CONFLICT_ENTRY_CHOICES) return undefined;
  }
  return choices.length ? { identical, choices } : undefined;
}

export function reconcileVaultItems(local: VaultPayload, cloud: VaultPayload, decisions: VaultEntryDecision[]): VaultPayload {
  const plan = planVaultEntrySelection(local, cloud);
  if (!plan || decisions.length !== plan.choices.length) throw new Error('Review and choose a version for every affected MyVault entry.');
  const selection = new Map(decisions.map(({ id, keep }) => [id, keep]));
  if (selection.size !== decisions.length) throw new Error('A MyVault entry was selected more than once.');
  const items = [...plan.identical];
  for (const entry of plan.choices) {
    const keep = selection.get(entry.metadata.id);
    if (keep !== 'local' && keep !== 'cloud') throw new Error('A MyVault entry choice is missing.');
    const item = keep === 'local' ? entry.local : entry.cloud;
    if (item) items.push(item);
  }
  const localIds = new Set(local.items.map(({ id }) => id));
  const order = new Map([...local.items, ...cloud.items.filter(({ id }) => !localIds.has(id))].map(({ id }, index) => [id, index]));
  items.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return { ...local, items };
}
