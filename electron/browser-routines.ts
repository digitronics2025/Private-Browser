import { requireAccountSpaceId } from './account-space-validation.js';
import { isAllowedRemoteUrl, parseWebAddress, stripTrackingParameters } from './security.js';
import type { AccountSpaceId, BrowserRoutine, RoutineLink, WorkspaceId } from './types.js';

export const MAX_ROUTINES = 30;
export const MAX_ROUTINE_ITEMS = 20;

const PRESETS: Array<{ id: string; name: string; workspaceId: WorkspaceId; urls: string[] }> = [
  { id: 'morning', name: 'Morning command center', workspaceId: 'digitronics', urls: ['https://digitronics.ma/', 'https://business.facebook.com/', 'https://web.whatsapp.com/'] },
  { id: 'development-stack', name: 'Development stack', workspaceId: 'development', urls: ['https://github.com/digitronics2025', 'https://dash.cloudflare.com/'] },
  { id: 'marketplaces', name: 'Marketplace check', workspaceId: 'tenten', urls: ['https://vendorhub.jumia.ma/', 'https://www.marjanemall.ma/'] },
];

export function defaultBrowserRoutines(accounts: Partial<Record<WorkspaceId, AccountSpaceId>>): BrowserRoutine[] {
  return PRESETS.flatMap(({ id, name, workspaceId, urls }) => {
    const accountSpaceId = accounts[workspaceId];
    return accountSpaceId ? [{ id, name, links: urls.map((url) => ({ accountSpaceId, url })), focusIndex: urls.length - 1, checklist: [] }] : [];
  });
}

export function canonicalRoutineUrl(url: string): string {
  return stripTrackingParameters(new URL(url).toString());
}

export function requireBrowserRoutine(value: unknown): BrowserRoutine {
  const input = object(value);
  const id = text(input.id, 'routine ID', 100);
  const name = text(input.name, 'routine name', 80);
  if (!Array.isArray(input.links) || input.links.length < 1 || input.links.length > MAX_ROUTINE_ITEMS) throw new Error('Add between 1 and 20 links');
  const links: RoutineLink[] = input.links.map((value) => {
    const item = object(value);
    const parsed = parseWebAddress(text(item.url, 'web address', 4096));
    if (!parsed || !isAllowedRemoteUrl(parsed)) throw new Error('Routine links must be HTTP or HTTPS addresses');
    return { accountSpaceId: requireAccountSpaceId(item.accountSpaceId), url: canonicalRoutineUrl(parsed) };
  });
  if (!Number.isSafeInteger(input.focusIndex) || Number(input.focusIndex) < 0 || Number(input.focusIndex) >= links.length) throw new Error('Choose a tab to focus');
  if (!Array.isArray(input.checklist) || input.checklist.length > MAX_ROUTINE_ITEMS) throw new Error('A routine can have up to 20 checklist items');
  const checklist = input.checklist.map((value) => {
    const item = object(value);
    const label = text(item.label, 'checklist item', 120);
    const completedAt = typeof item.completedAt === 'string' && item.completedAt.length <= 30 && Number.isFinite(Date.parse(item.completedAt))
      ? new Date(item.completedAt).toISOString() : undefined;
    return { label, done: item.done === true, completedAt };
  });
  return { id, name, links, focusIndex: Number(input.focusIndex), checklist };
}

export function sanitizeBrowserRoutines(value: unknown): BrowserRoutine[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = new Set<string>();
  return value.slice(0, MAX_ROUTINES).flatMap((item) => {
    try {
      const routine = requireBrowserRoutine(item);
      if (ids.has(routine.id)) return [];
      ids.add(routine.id);
      return [routine];
    } catch {
      return [];
    }
  });
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Enter a valid ' + field);
  return value.trim();
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid routine');
  return value as Record<string, unknown>;
}
