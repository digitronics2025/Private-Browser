export const notesPanelCommands = ['status', 'backup', 'search', 'pinned', 'recent'] as const;
export type NotesPanelCommand = typeof notesPanelCommands[number];
export type NotesPanelRequest = { kind: NotesPanelCommand } | { kind: 'draft'; title: string; text: string; source?: string };

export interface NotesPanelStatus {
  mode: 'personal' | 'protected' | 'unknown';
  sync: 'local-only' | 'offline' | 'idle' | 'syncing' | 'error' | 'conflict';
  lastSuccessfulSyncAt?: string;
  drafts: number;
  pending: number;
}

export interface NotesDraftReview {
  id: string;
  accountSpaceId: string;
  tabId: string;
  title: string;
  text: string;
  source: string;
  redactions: number;
  expiresAt: number;
}

export interface NotesDraftChoice {
  id: string;
  title: string;
  text: string;
  includeSource: boolean;
}

export function notesBridgeScript(expectedOrigin: string, request: NotesPanelRequest): string {
  return '(() => { if (location.origin !== ' + JSON.stringify(expectedOrigin) + ') return null;'
    + ' const command = window.__easyCopyNotesBrowserV1;'
    + ' if (typeof command !== "function") return null;'
    + ' return Promise.race([command(' + JSON.stringify(request) + '), new Promise(resolve => setTimeout(() => resolve({ ok: false }), 1500))]); })()';
}

export function notesStatus(result: unknown): NotesPanelStatus | undefined {
  if (!result || typeof result !== 'object' || !('status' in result)) return;
  if (!result.status || typeof result.status !== 'object') return;
  const { mode, sync, lastSuccessfulSyncAt, drafts, pending } = result.status as Partial<NotesPanelStatus>;
  if (!mode || !['personal', 'protected', 'unknown'].includes(mode) || !sync
    || !['local-only', 'offline', 'idle', 'syncing', 'error', 'conflict'].includes(sync)
    || typeof drafts !== 'number' || !Number.isSafeInteger(drafts) || drafts < 0 || drafts > 50_000
    || typeof pending !== 'number' || !Number.isSafeInteger(pending) || pending < 0 || pending > 50_000) return;
  const validTime = typeof lastSuccessfulSyncAt === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(lastSuccessfulSyncAt)
    && Number.isFinite(Date.parse(lastSuccessfulSyncAt));
  return { mode, sync, drafts, pending, ...(validTime ? { lastSuccessfulSyncAt } : {}) };
}
