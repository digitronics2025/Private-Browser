import {
  requireAccountColor,
  requireAccountLabel,
  requireAccountSpaceId,
  requireBoundedStringArray,
  requireBoundedText,
  requireGoogleModules,
  requirePermissionDecision,
  requireWorkspaceId,
} from './account-space-validation.js';
import type { ExternalBrowserId } from './types.js';
import { isAllowedRemoteUrl } from './security.js';

const EXTERNAL_BROWSERS = new Set<ExternalBrowserId>(['edge', 'chrome', 'firefox']);

export function validateIpcArguments(channel: string, args: unknown[]): void {
  switch (channel) {
    case 'accounts:add-local':
      exact(args, 3); requireWorkspaceId(args[0]); requireAccountLabel(args[1]); requireAccountColor(args[2]); return;
    case 'accounts:update':
      between(args, 1, 3); requireAccountSpaceId(args[0]);
      if (args[1] !== undefined) requireAccountLabel(args[1]);
      if (args[2] !== undefined) requireAccountColor(args[2]); return;
    case 'accounts:reorder':
      exact(args, 2); requireWorkspaceId(args[0]);
      if (!Array.isArray(args[1]) || args[1].length > 50) throw new Error('Invalid Account Space order');
      args[1].forEach(requireAccountSpaceId); return;
    case 'accounts:open-in':
      exact(args, 2); requireAccountSpaceId(args[0]); requireRemoteOrHomeUrl(args[1]); return;
    case 'accounts:set-locked':
      exact(args, 2); requireAccountSpaceId(args[0]); requireBoolean(args[1]); return;
    case 'accounts:disconnect-google':
      between(args, 1, 2); requireAccountSpaceId(args[0]); if (args[1] !== undefined) requireBoolean(args[1]); return;
    case 'accounts:clear-data':
    case 'google:cancel':
    case 'google:gmail-overview':
    case 'google:contacts-list':
    case 'backup:create-recovery':
    case 'backup:disable':
      exact(args, 1); requireAccountSpaceId(args[0]); return;
    case 'google:gmail-overview-run':
    case 'google:contacts-list-run':
      exact(args, 2); requireAccountSpaceId(args[0]); requireUuid(args[1], 'operation'); return;
    case 'accounts:delete':
      exact(args, 2); requireAccountSpaceId(args[0]);
      if (args[1] !== 'DELETE_ACCOUNT_SPACE') throw new Error('Exact Account Space deletion confirmation is required'); return;
    case 'permissions:respond':
      between(args, 2, 3); requireUuid(args[0], 'permission prompt'); requirePermissionDecision(args[1]);
      if (args[2] !== undefined) requireBoundedText(args[2], 'display source identifier', 512); return;
    case 'google:configure':
      exact(args, 1); requireBoundedText(args[0], 'Google client identifier', 512); return;
    case 'google:connect':
      exact(args, 3); requireAccountSpaceId(args[0]); requireGoogleModules(args[1]); requireExternalBrowser(args[2]); return;
    case 'google:gmail-search':
    case 'google:drive-list':
    case 'google:calendar-list':
      between(args, 1, 3); requireAccountSpaceId(args[0]);
      if (args[1] !== undefined) requireBoundedText(args[1], 'Google search query', 500);
      if (channel === 'google:drive-list' && args[2] !== undefined) requireBoolean(args[2]); return;
    case 'google:gmail-search-run':
    case 'google:calendar-list-run':
      between(args, 2, 3); requireAccountSpaceId(args[0]); requireUuid(args[1], 'operation'); if (args[2] !== undefined) requireBoundedText(args[2], 'Google search query', 500); return;
    case 'google:drive-list-run':
      between(args, 2, 4); requireAccountSpaceId(args[0]); requireUuid(args[1], 'operation'); if (args[2] !== undefined) requireBoundedText(args[2], 'Google search query', 500); if (args[3] !== undefined) requireBoolean(args[3]); return;
    case 'google:gmail-prepare-send':
      between(args, 2, 3); requireAccountSpaceId(args[0]); requireGmailSend(args[1]); optionalRevision(args[2]); return;
    case 'google:gmail-send':
      between(args, 4, 5); requireAccountSpaceId(args[0]); requireUuid(args[1], 'operation'); requireGmailSend(args[2]); requireUuid(args[3], 'confirmation'); optionalRevision(args[4]); return;
    case 'google:drive-create':
      exact(args, 3); requireAccountSpaceId(args[0]); requireUuid(args[1], 'operation'); requireDriveCreate(args[2]); return;
    case 'google:drive-prepare-share':
      between(args, 4, 5); requireAccountSpaceId(args[0]); requireIdentifier(args[1]); requireEmail(args[2]); requireRole(args[3]); optionalRevision(args[4]); return;
    case 'google:drive-share':
      between(args, 6, 7); requireAccountSpaceId(args[0]); requireUuid(args[1], 'operation'); requireIdentifier(args[2]); requireEmail(args[3]); requireRole(args[4]); requireUuid(args[5], 'confirmation'); optionalRevision(args[6]); return;
    case 'google:calendar-prepare-write':
      between(args, 3, 4); requireAccountSpaceId(args[0]); requireCalendarAction(args[1]); requireCalendarInput(args[2]); optionalRevision(args[3]); return;
    case 'google:calendar-write':
      between(args, 5, 6); requireAccountSpaceId(args[0]); requireUuid(args[1], 'operation'); requireCalendarAction(args[2]); requireCalendarInput(args[3]); requireUuid(args[4], 'confirmation'); optionalRevision(args[5]); return;
    case 'backup:verify-enable':
      exact(args, 4); requireAccountSpaceId(args[0]); requireBoundedText(args[1], 'recovery code', 64); requireBoolean(args[2]); requireBoolean(args[3]); return;
    case 'backup:upload':
      between(args, 2, 3); requireAccountSpaceId(args[0]); requireUuid(args[1], 'operation');
      if (args[2] !== undefined && args[2] !== 'merge' && args[2] !== 'overwrite') throw new Error('Invalid backup conflict decision'); return;
    case 'backup:restore':
      between(args, 2, 3); requireAccountSpaceId(args[0]); requireUuid(args[1], 'operation'); if (args[2] !== undefined) requireBoundedText(args[2], 'recovery code', 64); return;
    case 'operations:cancel':
      exact(args, 1); requireUuid(args[0], 'operation'); return;
    default:
      return;
  }
}

function exact(args: unknown[], count: number): void { if (args.length !== count) throw new Error('Invalid browser command arguments'); }
function between(args: unknown[], minimum: number, maximum: number): void { if (args.length < minimum || args.length > maximum) throw new Error('Invalid browser command arguments'); }
function requireBoolean(value: unknown): asserts value is boolean { if (typeof value !== 'boolean') throw new Error('Expected a boolean'); }
function requireObject(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object'); return value as Record<string, unknown>; }
function requireUuid(value: unknown, field: string): string { const text = requireBoundedText(value, field, 64); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) throw new Error(`Invalid ${field} identifier`); return text; }
function requireRemoteOrHomeUrl(value: unknown): void { const text = requireBoundedText(value, 'URL', 4096); if (text !== 'private://home' && !isAllowedRemoteUrl(text)) throw new Error('Only HTTP and HTTPS pages are allowed'); }
function requireExternalBrowser(value: unknown): void { if (typeof value !== 'string' || !EXTERNAL_BROWSERS.has(value as ExternalBrowserId)) throw new Error('Invalid external browser'); }
function requireIdentifier(value: unknown): void { const text = requireBoundedText(value, 'Google resource identifier', 512); if (!/^[a-zA-Z0-9_@.=-]+$/.test(text)) throw new Error('Invalid Google resource identifier'); }
function requireEmail(value: unknown): void { const text = requireBoundedText(value, 'email address', 320); if (!/^\S+@\S+\.\S+$/.test(text) || /[\r\n]/.test(text)) throw new Error('Invalid email address'); }
function requireRole(value: unknown): void { if (value !== 'reader' && value !== 'writer') throw new Error('Invalid Drive role'); }
function optionalRevision(value: unknown): void { if (value !== undefined) requireBoundedText(value, 'source revision', 256); }

function requireGmailSend(value: unknown): void {
  const input = requireObject(value);
  const recipients = requireBoundedStringArray(input.to, 'Gmail recipients');
  if (recipients.length === 0) throw new Error('At least one recipient is required');
  recipients.forEach(requireEmail);
  requireBoundedStringArray(input.cc ?? [], 'Gmail copy recipients').forEach(requireEmail);
  requireBoundedText(input.subject, 'Gmail subject', 998);
  requireBoundedText(input.body, 'Gmail body');
}

function requireDriveCreate(value: unknown): void {
  const input = requireObject(value);
  requireBoundedText(input.name, 'Drive file name', 255);
  if (!['document', 'spreadsheet', 'folder'].includes(String(input.kind))) throw new Error('Invalid Drive file kind');
}

function requireCalendarAction(value: unknown): void { if (!['create', 'update', 'delete'].includes(String(value))) throw new Error('Invalid calendar action'); }

function requireCalendarInput(value: unknown): void {
  const input = requireObject(value);
  requireBoundedText(input.summary, 'Calendar summary', 500);
  requireBoundedText(input.description ?? '', 'Calendar description', 16 * 1024);
  requireBoundedText(input.start, 'Calendar start', 100);
  requireBoundedText(input.end, 'Calendar end', 100);
  requireBoundedStringArray(input.attendees ?? [], 'Calendar attendees').forEach(requireEmail);
  if (input.createMeet !== undefined) requireBoolean(input.createMeet);
  if (input.calendarId !== undefined) requireIdentifier(input.calendarId);
  if (input.eventId !== undefined) requireIdentifier(input.eventId);
}
