import type { FillContext } from './fill-capability.js';

/**
 * Electron-free half of the login picker: session bookkeeping, placement and
 * markup. Kept apart from `fill-picker.ts` so the security rules can be tested
 * without a window.
 */

export const FILL_PICKER_ROW_HEIGHT = 52;
export const FILL_PICKER_FOOTER_HEIGHT = 44;
export const FILL_PICKER_PADDING = 6;
export const FILL_PICKER_MIN_WIDTH = 280;
export const FILL_PICKER_MAX_WIDTH = 420;
const FIELD_GAP = 4;

/** Row index the overlay sends for "Manage logins…". */
export const FILL_PICKER_MANAGE_INDEX = -1;

export interface FillPickerRow {
  entryId: string;
  username: string;
  title: string;
}

export interface Rect { x: number; y: number; width: number; height: number }

export type FillPickerChoice =
  | { kind: 'entry'; context: FillContext; entryId: string }
  | { kind: 'manage'; context: FillContext };

interface Session {
  nonce: string;
  senderId: number;
  context: FillContext;
  entryIds: string[];
  used: boolean;
}

/**
 * At most one picker exists. A choice is honoured once, only from the overlay
 * view that was opened for it, only with that view's nonce and only for an
 * index the main process itself put on screen. The overlay never learns an
 * entry id; it can only point at a row.
 */
export class FillPickerSessions {
  private session?: Session;

  /** The nonce is minted by the caller because the overlay view needs it at creation. */
  open(context: FillContext, entryIds: string[], senderId: number, nonce: string): void {
    if (nonce.length < 16) throw new Error('A login picker needs an unguessable nonce');
    this.session = { nonce, senderId, context, entryIds: [...entryIds], used: false };
  }

  get current(): Readonly<Pick<Session, 'context' | 'senderId'>> & { rows: number } | undefined {
    const session = this.session;
    return session && { context: session.context, senderId: session.senderId, rows: session.entryIds.length };
  }

  /** Resolve a click from the overlay, consuming the session whatever the outcome. */
  take(senderId: number, nonce: unknown, index: unknown): FillPickerChoice | undefined {
    const session = this.session;
    if (!session || session.used || session.senderId !== senderId || nonce !== session.nonce) return undefined;
    session.used = true;
    this.session = undefined;
    if (index === FILL_PICKER_MANAGE_INDEX) return { kind: 'manage', context: session.context };
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= session.entryIds.length) return undefined;
    return { kind: 'entry', context: session.context, entryId: session.entryIds[index]! };
  }

  /** Resolve the keyboard-highlighted row; the page keeps focus, so Enter arrives in main. */
  takeIndex(index: number): FillPickerChoice | undefined {
    const session = this.session;
    if (!session || session.used) return undefined;
    return this.take(session.senderId, session.nonce, index);
  }

  clear(): void {
    this.session = undefined;
  }
}

export function fillPickerHeight(rows: number): number {
  return rows * FILL_PICKER_ROW_HEIGHT + FILL_PICKER_FOOTER_HEIGHT + FILL_PICKER_PADDING * 2;
}

/**
 * Window-space bounds for the overlay: under the field like Chrome, flipped
 * above it when there is no room below, and always inside the page view.
 * Returns undefined when the field is scrolled out of sight or the page view
 * is too small to hold the list.
 */
export function fillPickerBounds(field: Rect, zoomFactor: number, page: Rect, rows: number): Rect | undefined {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  const top = field.y * zoom;
  const bottom = (field.y + field.height) * zoom;
  if (bottom <= 0 || top >= page.height) return undefined;
  const height = fillPickerHeight(rows);
  const width = Math.round(Math.min(Math.max(field.width * zoom, FILL_PICKER_MIN_WIDTH), FILL_PICKER_MAX_WIDTH, page.width));
  if (width < FILL_PICKER_MIN_WIDTH || height > page.height) return undefined;
  const x = page.x + Math.min(Math.max(field.x * zoom, 0), page.width - width);
  const below = bottom + FIELD_GAP;
  const above = top - FIELD_GAP - height;
  const offset = below + height <= page.height ? below : above >= 0 ? above : Math.max(0, page.height - height);
  return { x: Math.round(x), y: Math.round(page.y + offset), width, height };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}

function initial(row: FillPickerRow): string {
  const source = (row.username || row.title || '?').trim();
  return escapeHtml((Array.from(source)[0] ?? '?').toUpperCase());
}

/** Static markup; the only script wires clicks and the highlight to the preload. */
export function fillPickerHtml(rows: FillPickerRow[], cspNonce: string): string {
  const items = rows.map((row, index) => `<li><button type="button" class="row" data-index="${index}" tabindex="-1"><span class="badge" aria-hidden="true">${initial(row)}</span><span class="text"><span class="user">${row.username ? escapeHtml(row.username) : '<em>No username</em>'}</span><span class="dots" aria-label="saved password">••••••••••</span></span></button></li>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${cspNonce}'; script-src 'nonce-${cspNonce}'; form-action 'none'; base-uri 'none'"><title>Saved logins</title><style nonce="${cspNonce}">:root{color-scheme:dark;font-family:system-ui,'Segoe UI',sans-serif}*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden;background:transparent}body{padding:${FILL_PICKER_PADDING}px 0;background:#1b1f27;border:1px solid #394052;border-radius:10px;color:#f7f8fb;user-select:none}ul{list-style:none;margin:0;padding:0}.row{display:flex;align-items:center;gap:12px;width:100%;height:${FILL_PICKER_ROW_HEIGHT}px;padding:0 14px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:default}.row:hover,.row[aria-selected=true]{background:#2a3040}.badge{flex:none;display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:#12342f;color:#2dd4bf;font-weight:700;font-size:13px}.text{display:grid;min-width:0}.user{font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.user em{color:#aeb6c8;font-style:normal}.dots{font-size:11px;letter-spacing:1px;color:#8b93a7}.manage{display:flex;align-items:center;width:100%;height:${FILL_PICKER_FOOTER_HEIGHT}px;padding:0 14px;border:0;border-top:1px solid #2c3242;background:transparent;color:#5eead4;font:inherit;font-size:13px;text-align:left;cursor:default}.manage:hover{background:#2a3040}</style></head><body><ul role="listbox" aria-label="Saved logins for this site">${items}</ul><button type="button" class="manage" tabindex="-1">Manage logins…</button><script nonce="${cspNonce}">const rows=[...document.querySelectorAll('.row')];rows.forEach((row)=>row.addEventListener('mousedown',(event)=>{event.preventDefault();window.fillPicker.choose(Number(row.dataset.index))}));document.querySelector('.manage').addEventListener('mousedown',(event)=>{event.preventDefault();window.fillPicker.choose(${FILL_PICKER_MANAGE_INDEX})});window.fillPicker.onHighlight((index)=>rows.forEach((row,i)=>row.setAttribute('aria-selected',String(i===index))));</script></body></html>`;
}
