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
import { requireBrowserSettingsPatch } from './browser-settings.js';
import { requireUiPreferencesPatch } from './ui-preferences.js';

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
    case 'browser:set-overlay-open':
      exact(args, 1); requireBoolean(args[0]); return;
    case 'browser:set-layout': {
      exact(args, 1);
      const layout = requireObject(args[0]);
      for (const side of ['top', 'left', 'right', 'bottom'] as const) requireBoundedNumber(layout[side], 'layout inset', 0, 4000);
      return;
    }
    case 'ui:set-preferences':
      exact(args, 1); requireUiPreferencesPatch(args[0]); return;
    case 'settings:set':
      exact(args, 1); requireBrowserSettingsPatch(args[0]); return;
    case 'browser:home':
      exact(args, 0); return;
    case 'browser:move-tab':
      exact(args, 2); requireBoundedText(args[0], 'tab identifier', 200); requireIndex(args[1]); return;
    case 'browser:zoom':
      exact(args, 1); if (!['in', 'out', 'reset'].includes(String(args[0]))) throw new Error('Invalid zoom direction'); return;
    case 'browser:find':
      exact(args, 3); requireBoundedText(args[0], 'find text', 1000); requireBoolean(args[1]); requireBoolean(args[2]); return;
    case 'browser:set-tab-muted':
      exact(args, 2); requireBoundedText(args[0], 'tab identifier', 200); requireBoolean(args[1]); return;
    case 'bookmarks:move':
      exact(args, 3); requireBookmarkLevel(args[0]); requireBookmarkKey(args[1]); requireIndex(args[2]); return;
    case 'bookmarks:rename':
      exact(args, 2); requireBoundedText(args[0], 'bookmark identifier', 200); requireNonEmptyText(args[1], 'bookmark name', 500); return;
    case 'bookmarks:remove':
    case 'browser:open-bookmark':
      exact(args, 1); requireBoundedText(args[0], 'bookmark identifier', 200); return;
    case 'bookmarks:rename-folder':
      exact(args, 3); requireBookmarkLevel(args[0]); requireNonEmptyText(args[1], 'folder name', 200); requireNonEmptyText(args[2], 'folder name', 200); return;
    case 'bookmarks:remove-folder':
      exact(args, 2); requireBookmarkLevel(args[0]); requireNonEmptyText(args[1], 'folder name', 200); return;
    case 'shortcuts:set': {
      exact(args, 2); requireAccountSpaceId(args[0]);
      if (args[1] === null) return;
      if (!Array.isArray(args[1]) || args[1].length > 12) throw new Error('Invalid shortcut list');
      for (const tile of args[1]) {
        const input = requireObject(tile);
        requireNonEmptyText(input.id, 'shortcut identifier', 64);
        requireBoundedText(input.title, 'shortcut name', 100);
        const url = requireBoundedText(input.url, 'shortcut URL', 4096);
        if (!isAllowedRemoteUrl(url)) throw new Error('Shortcuts must be HTTP or HTTPS pages');
      }
      return;
    }
    case 'browser:import-chrome': {
      exact(args, 1);
      const input = requireObject(args[0]);
      requireBoundedText(input.profileId, 'Chrome profile identifier', 200);
      requireWorkspaceId(input.workspaceId);
      requireAccountSpaceId(input.accountSpaceId);
      requireBoolean(input.bookmarks);
      requireBoolean(input.history);
      return;
    }
    case 'recovery:act':
      between(args, 1, 2);
      if (!['retry', 'open-backup-location', 'restore-v1', 'fresh-start'].includes(String(args[0]))) throw new Error('Invalid recovery action');
      if (args[1] !== undefined) requireBoundedText(args[1], 'recovery confirmation', 64);
      return;
    case 'control-center:status':
    case 'control-center:disconnect':
    case 'control-center:repositories':
    case 'control-center:tasks':
      exact(args, 0); return;
    case 'control-center:pair':
      exact(args, 1); if (typeof args[0] !== 'string' || !/^\d{8}$/.test(args[0])) throw new Error('The pairing code has eight digits'); return;
    case 'control-center:send': {
      exact(args, 1); const input = requireExactKeys(args[0], ['approvalToken', 'repositoryId', 'note']);
      requireUuid(input.approvalToken, 'approval'); requireNonEmptyText(input.repositoryId, 'repository', 100); requireNonEmptyText(input.note, 'note', 2000); return;
    }
    case 'control-center:recheck': {
      exact(args, 1); const input = requireExactKeys(args[0], ['approvalToken', 'taskId']);
      requireUuid(input.approvalToken, 'approval');
      if (typeof input.taskId !== 'string' || !/^TASK-\d{1,8}$/.test(input.taskId)) throw new Error('Invalid Control Center task'); return;
    }
    // Channels that take one identifier chosen from state the renderer was given.
    case 'browser:activate-tab':
    case 'browser:close-tab':
    case 'browser:open-download':
    case 'browser:show-download':
    case 'vault:autofill':
    case 'vault:copy-password':
    case 'vault:copy-totp':
    case 'vault:request-delete':
    case 'developer:bridge-select-project':
      exact(args, 1); requireNonEmptyText(args[0], 'identifier', 200); return;
    case 'browser:switch-account-space':
      exact(args, 1); requireAccountSpaceId(args[0]); return;
    case 'browser:switch-workspace':
      exact(args, 1); requireWorkspaceId(args[0]); return;
    case 'browser:navigate':
      exact(args, 1); requireBoundedText(args[0], 'address', 4096); return;
    case 'browser:new-tab':
      between(args, 0, 3);
      if (args[0] !== undefined) requireWorkspaceId(args[0]);
      if (args[1] !== undefined) requireBoundedText(args[1], 'address', 4096);
      if (args[2] !== undefined) requireAccountSpaceId(args[2]); return;
    case 'ai:approve-preview':
      exact(args, 1); requireUuid(args[0], 'preview'); return;
    case 'ai:ask':
      exact(args, 2); requireNonEmptyText(args[0], 'approval', 200); requireBoundedText(args[1], 'question', 2000); return;
    case 'ai:configure-provider': {
      exact(args, 1); const input = requireExactKeys(args[0], ['endpoint', 'model', 'apiKey']);
      requireBoundedText(input.endpoint, 'provider address', 2048); requireBoundedText(input.model, 'model', 200); requireBoundedText(input.apiKey, 'API key', 4096); return;
    }
    case 'updates:configure': {
      exact(args, 1); const input = requireExactKeys(args[0], ['endpoint', 'accessToken']);
      requireBoundedText(input.endpoint, 'service address', 2048); requireBoundedText(input.accessToken, 'access token', 4096); return;
    }
    case 'developer:bridge-action':
      between(args, 1, 2); requireNonEmptyText(args[0], 'VS Code action', 40);
      if (args[1] !== undefined && JSON.stringify(requireObject(args[1])).length > 256 * 1024) throw new Error('VS Code action payload is too large'); return;
    case 'developer:bridge-disconnect':
    case 'developer:inspect-page':
      between(args, 0, 1); if (args[0] !== undefined) requireBoolean(args[0]); return;
    case 'developer:prepare-ai-preview': {
      exact(args, 1); const input = requireExactKeys(args[0], ['includeDom', 'includeScreenshot']);
      requireBoolean(input.includeDom); requireBoolean(input.includeScreenshot); return;
    }
    case 'developer:toggle-tools':
      exact(args, 1); if (!['right', 'bottom', 'detach'].includes(String(args[0]))) throw new Error('Invalid DevTools position'); return;
    case 'system:copy':
      exact(args, 1); requireBoundedText(args[0], 'copied text', 2 * 1024 * 1024); return;
    case 'vault:copy-generated':
      exact(args, 1); if (!['password', 'passphrase', 'pin'].includes(String(args[0]))) throw new Error('Invalid generated credential kind'); return;
    case 'vault:resolve-conflict':
      exact(args, 1); if (args[0] !== 'cloud' && args[0] !== 'local') throw new Error('Choose the cloud or local vault explicitly'); return;
    case 'vault:open-editor':
      between(args, 0, 1); if (args[0] !== undefined) requireBoundedText(args[0], 'origin', 2048); return;
    default:
      if (NO_ARGUMENT_CHANNELS.has(channel)) { exact(args, 0); return; }
      // Every channel is listed; one that is not is refused rather than
      // passed through unchecked (F-49).
      throw new Error('Unknown browser command');
  }
}

/** Channels that carry no arguments at all. */
const NO_ARGUMENT_CHANNELS: ReadonlySet<string> = new Set([
  'ai:clear-provider', 'ai:prepare-preview', 'ai:provider-status', 'ai:revoke', 'app:quit', 'bookmarks:export',
  'browser:back', 'browser:forward', 'browser:freeze-content', 'browser:get-state', 'browser:hard-reload',
  'browser:import-chrome-passwords', 'browser:list-chrome-profiles', 'browser:print', 'browser:reload',
  'browser:reopen-closed-tab', 'browser:stop', 'browser:stop-find', 'browser:toggle-bookmark', 'browser:toggle-bookmark-bar',
  'browser:toggle-fullscreen', 'browser:toggle-tracker-blocking', 'developer:bridge-pair', 'developer:bridge-projects',
  'developer:bridge-status', 'developer:capture-diagnostics', 'developer:clear-diagnostics', 'developer:install-extension',
  'google:clear-configuration', 'system:is-default-browser', 'system:set-default-browser', 'updates:check', 'updates:clear',
  'updates:open-page', 'updates:status', 'vault:acknowledge-recovery', 'vault:cleanup-legacy', 'vault:conflict-review',
  'vault:form-shape', 'vault:hello-disable', 'vault:hello-enable', 'vault:hello-unlock', 'vault:list', 'vault:lock',
  'vault:migrate-legacy', 'vault:migration-status', 'vault:reconnect', 'vault:request-pairing', 'vault:request-unlock',
  'vault:save-from-page', 'vault:sync',
]);

/** An object carrying exactly these keys: an extra field is refused, never passed along. */
function requireExactKeys(value: unknown, keys: string[]): Record<string, unknown> {
  const input = requireObject(value);
  const extra = Object.keys(input).filter((key) => !keys.includes(key));
  if (extra.length) throw new Error('Unexpected field');
  return input;
}

function requireBoundedNumber(value: unknown, field: string, minimum: number, maximum: number): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`Invalid ${field}`); return value; }
function requireIndex(value: unknown): void { if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 25_000) throw new Error('Invalid position'); }
function requireNonEmptyText(value: unknown, field: string, maximum: number): string { const text = requireBoundedText(value, field, maximum); if (!text.trim()) throw new Error(`A ${field} is required`); return text; }
function requireBookmarkLevel(value: unknown): void {
  const input = requireObject(value);
  if (input.location !== 'bar' && input.location !== 'other') throw new Error('Invalid bookmark location');
  if (!Array.isArray(input.path) || input.path.length > 20) throw new Error('Invalid bookmark folder path');
  input.path.forEach((part) => requireBoundedText(part, 'folder name', 200));
}
function requireBookmarkKey(value: unknown): void {
  const input = requireObject(value);
  if (input.kind === 'bookmark') requireBoundedText(input.id, 'bookmark identifier', 200);
  else if (input.kind === 'folder') requireNonEmptyText(input.name, 'folder name', 200);
  else throw new Error('Invalid bookmark entry');
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
