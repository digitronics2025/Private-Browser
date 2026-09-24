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
import type { DeveloperBridgeAction, DevToolsMode, ExternalBrowserId, StateRecoveryAction } from './types.js';
import { isAllowedRemoteUrl } from './security.js';
import { requireUiPreferencesPatch } from './ui-preferences.js';

const EXTERNAL_BROWSERS = new Set<ExternalBrowserId>(['edge', 'chrome', 'firefox']);
const DEVTOOLS_MODES = new Set<DevToolsMode>(['right', 'bottom', 'detach']);
const RECOVERY_ACTIONS = new Set<StateRecoveryAction>(['retry', 'open-backup-location', 'restore-v1', 'fresh-start']);
const DEVELOPER_BRIDGE_ACTIONS = new Set<DeveloperBridgeAction>([
  'project.open', 'source.open',
  'server.discover', 'server.start', 'server.stop', 'server.restart',
  'inspect.page', 'inspect.open-source',
  'test.run', 'test.cancel', 'test.rerun', 'test.save-artifact',
  'ai.handoff', 'ai.apply-edits',
  'reports.list', 'reports.get', 'reports.delete', 'reports.clear', 'reports.open', 'reports.retention',
]);
const GENERATED_CREDENTIAL_KINDS = new Set(['password', 'passphrase', 'pin']);

/** Validates the argument list of one channel. Throws on anything malformed. */
type ArgumentsValidator = (args: unknown[]) => void;

/** Channels whose handler takes no arguments at all. */
const none: ArgumentsValidator = (args) => exact(args, 0);

/**
 * Every channel the trusted chrome may invoke, and the shape of its arguments.
 *
 * This table is the IPC surface. `handle()` in `main.ts` only accepts a key of
 * it, `validateIpcArguments` refuses any channel that is not here, and
 * `tests/ipc-parity.test.ts` proves the preload, the handlers and this table
 * name exactly the same channels. Validators bound shapes and sizes; business
 * rules (membership, workspace policy) stay in the controller as a second
 * boundary.
 */
export const IPC_CHANNEL_VALIDATORS = {
  'browser:get-state': none,
  'browser:navigate': (args) => { exact(args, 1); requireBoundedText(args[0], 'address', 65_536); },
  'browser:back': none,
  'browser:forward': none,
  'browser:reload': none,
  'browser:stop': none,
  'browser:new-tab': (args) => {
    between(args, 0, 3);
    if (args[0] !== undefined) requireWorkspaceId(args[0]);
    if (args[1] !== undefined) requireRemoteOrHomeUrl(args[1]);
    if (args[2] !== undefined) requireAccountSpaceId(args[2]);
  },
  'browser:close-tab': (args) => { exact(args, 1); requireIdentifierText(args[0], 'tab identifier'); },
  'browser:activate-tab': (args) => { exact(args, 1); requireIdentifierText(args[0], 'tab identifier'); },
  'browser:switch-workspace': (args) => { exact(args, 1); requireWorkspaceId(args[0]); },
  'browser:switch-account-space': (args) => { exact(args, 1); requireAccountSpaceId(args[0]); },
  'accounts:add-local': (args) => { exact(args, 3); requireWorkspaceId(args[0]); requireAccountLabel(args[1]); requireAccountColor(args[2]); },
  'accounts:update': (args) => {
    between(args, 1, 3); requireAccountSpaceId(args[0]);
    if (args[1] !== undefined) requireAccountLabel(args[1]);
    if (args[2] !== undefined) requireAccountColor(args[2]);
  },
  'accounts:reorder': (args) => {
    exact(args, 2); requireWorkspaceId(args[0]);
    if (!Array.isArray(args[1]) || args[1].length > 50) throw new Error('Invalid Account Space order');
    args[1].forEach(requireAccountSpaceId);
  },
  'accounts:open-in': (args) => { exact(args, 2); requireAccountSpaceId(args[0]); requireRemoteOrHomeUrl(args[1]); },
  'accounts:set-locked': (args) => { exact(args, 2); requireAccountSpaceId(args[0]); requireBoolean(args[1]); },
  'accounts:disconnect-google': (args) => { between(args, 1, 2); requireAccountSpaceId(args[0]); if (args[1] !== undefined) requireBoolean(args[1]); },
  'accounts:clear-data': (args) => { exact(args, 1); requireAccountSpaceId(args[0]); },
  'accounts:delete': (args) => {
    exact(args, 2); requireAccountSpaceId(args[0]);
    if (args[1] !== 'DELETE_ACCOUNT_SPACE') throw new Error('Exact Account Space deletion confirmation is required');
  },
  'permissions:respond': (args) => {
    between(args, 2, 3); requireUuid(args[0], 'permission prompt'); requirePermissionDecision(args[1]);
    if (args[2] !== undefined) requireBoundedText(args[2], 'display source identifier', 512);
  },
  'google:configure': (args) => { exact(args, 1); requireBoundedText(args[0], 'Google client identifier', 512); },
  'google:clear-configuration': none,
  'google:connect': (args) => { exact(args, 3); requireAccountSpaceId(args[0]); requireGoogleModules(args[1]); requireExternalBrowser(args[2]); },
  'google:cancel': (args) => { exact(args, 1); requireAccountSpaceId(args[0]); },
  'google:gmail-overview-run': (args) => { exact(args, 2); requireAccountSpaceId(args[0]); requireUuid(args[1], 'operation'); },
  'google:gmail-search-run': (args) => { between(args, 2, 3); requireAccountSpaceId(args[0]); requireUuid(args[1], 'operation'); if (args[2] !== undefined) requireBoundedText(args[2], 'Google search query', 500); },
  'google:gmail-prepare-send': (args) => { between(args, 2, 3); requireAccountSpaceId(args[0]); requireGmailSend(args[1]); optionalRevision(args[2]); },
  'google:gmail-send': (args) => { between(args, 4, 5); requireAccountSpaceId(args[0]); requireUuid(args[1], 'operation'); requireGmailSend(args[2]); requireUuid(args[3], 'confirmation'); optionalRevision(args[4]); },
  'google:drive-list-run': (args) => { between(args, 2, 4); requireAccountSpaceId(args[0]); requireUuid(args[1], 'operation'); if (args[2] !== undefined) requireBoundedText(args[2], 'Google search query', 500); if (args[3] !== undefined) requireBoolean(args[3]); },
  'google:drive-create': (args) => { exact(args, 3); requireAccountSpaceId(args[0]); requireUuid(args[1], 'operation'); requireDriveCreate(args[2]); },
  'google:drive-prepare-share': (args) => { between(args, 4, 5); requireAccountSpaceId(args[0]); requireIdentifier(args[1]); requireEmail(args[2]); requireRole(args[3]); optionalRevision(args[4]); },
  'google:drive-share': (args) => { between(args, 6, 7); requireAccountSpaceId(args[0]); requireUuid(args[1], 'operation'); requireIdentifier(args[2]); requireEmail(args[3]); requireRole(args[4]); requireUuid(args[5], 'confirmation'); optionalRevision(args[6]); },
  'google:calendar-list-run': (args) => { between(args, 2, 3); requireAccountSpaceId(args[0]); requireUuid(args[1], 'operation'); if (args[2] !== undefined) requireBoundedText(args[2], 'Google search query', 500); },
  'google:calendar-prepare-write': (args) => { between(args, 3, 4); requireAccountSpaceId(args[0]); requireCalendarAction(args[1]); requireCalendarInput(args[2]); optionalRevision(args[3]); },
  'google:calendar-write': (args) => { between(args, 5, 6); requireAccountSpaceId(args[0]); requireUuid(args[1], 'operation'); requireCalendarAction(args[2]); requireCalendarInput(args[3]); requireUuid(args[4], 'confirmation'); optionalRevision(args[5]); },
  'google:contacts-list-run': (args) => { exact(args, 2); requireAccountSpaceId(args[0]); requireUuid(args[1], 'operation'); },
  'backup:create-recovery': (args) => { exact(args, 1); requireAccountSpaceId(args[0]); },
  'backup:verify-enable': (args) => { exact(args, 4); requireAccountSpaceId(args[0]); requireBoundedText(args[1], 'recovery code', 64); requireBoolean(args[2]); requireBoolean(args[3]); },
  'backup:upload': (args) => {
    between(args, 2, 3); requireAccountSpaceId(args[0]); requireUuid(args[1], 'operation');
    if (args[2] !== undefined && args[2] !== 'merge' && args[2] !== 'overwrite') throw new Error('Invalid backup conflict decision');
  },
  'backup:restore': (args) => { between(args, 2, 3); requireAccountSpaceId(args[0]); requireUuid(args[1], 'operation'); if (args[2] !== undefined) requireBoundedText(args[2], 'recovery code', 64); },
  'backup:disable': (args) => { exact(args, 1); requireAccountSpaceId(args[0]); },
  'operations:cancel': (args) => { exact(args, 1); requireUuid(args[0], 'operation'); },
  'recovery:act': (args) => {
    between(args, 1, 2);
    if (!RECOVERY_ACTIONS.has(args[0] as StateRecoveryAction)) throw new Error('Invalid recovery action');
    if (args[1] !== undefined) requireBoundedText(args[1], 'recovery confirmation', 64);
  },
  'browser:set-layout': (args) => {
    exact(args, 1);
    const layout = requireObject(args[0]);
    for (const side of ['top', 'left', 'right', 'bottom'] as const) requireBoundedNumber(layout[side], 'layout inset', 0, 4000);
  },
  'browser:set-overlay-open': (args) => { exact(args, 1); requireBoolean(args[0]); },
  'browser:toggle-bookmark': none,
  'browser:open-bookmark': (args) => { exact(args, 1); requireBoundedText(args[0], 'bookmark identifier', 200); },
  'browser:toggle-bookmark-bar': none,
  'ui:set-preferences': (args) => { exact(args, 1); requireUiPreferencesPatch(args[0]); },
  'browser:freeze-content': none,
  'browser:move-tab': (args) => { exact(args, 2); requireBoundedText(args[0], 'tab identifier', 200); requireIndex(args[1]); },
  'browser:reopen-closed-tab': none,
  'browser:zoom': (args) => { exact(args, 1); if (!['in', 'out', 'reset'].includes(String(args[0]))) throw new Error('Invalid zoom direction'); },
  'browser:print': none,
  'browser:find': (args) => { exact(args, 3); requireBoundedText(args[0], 'find text', 1000); requireBoolean(args[1]); requireBoolean(args[2]); },
  'browser:stop-find': none,
  'browser:set-tab-muted': (args) => { exact(args, 2); requireBoundedText(args[0], 'tab identifier', 200); requireBoolean(args[1]); },
  'browser:hard-reload': none,
  'browser:toggle-fullscreen': none,
  'bookmarks:move': (args) => { exact(args, 3); requireBookmarkLevel(args[0]); requireBookmarkKey(args[1]); requireIndex(args[2]); },
  'bookmarks:rename': (args) => { exact(args, 2); requireBoundedText(args[0], 'bookmark identifier', 200); requireNonEmptyText(args[1], 'bookmark name', 500); },
  'bookmarks:remove': (args) => { exact(args, 1); requireBoundedText(args[0], 'bookmark identifier', 200); },
  'bookmarks:rename-folder': (args) => { exact(args, 3); requireBookmarkLevel(args[0]); requireNonEmptyText(args[1], 'folder name', 200); requireNonEmptyText(args[2], 'folder name', 200); },
  'bookmarks:remove-folder': (args) => { exact(args, 2); requireBookmarkLevel(args[0]); requireNonEmptyText(args[1], 'folder name', 200); },
  'bookmarks:export': none,
  'shortcuts:set': (args) => {
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
  },
  'app:quit': none,
  'browser:list-chrome-profiles': none,
  'browser:import-chrome': (args) => {
    exact(args, 1);
    const input = requireObject(args[0]);
    requireBoundedText(input.profileId, 'Chrome profile identifier', 200);
    requireWorkspaceId(input.workspaceId);
    requireAccountSpaceId(input.accountSpaceId);
    requireBoolean(input.bookmarks);
    requireBoolean(input.history);
  },
  'browser:import-chrome-passwords': none,
  'browser:toggle-tracker-blocking': none,
  'browser:open-download': (args) => { exact(args, 1); requireIdentifierText(args[0], 'download identifier'); },
  'browser:show-download': (args) => { exact(args, 1); requireIdentifierText(args[0], 'download identifier'); },
  'developer:toggle-tools': (args) => { exact(args, 1); if (!DEVTOOLS_MODES.has(args[0] as DevToolsMode)) throw new Error('Unsupported DevTools position'); },
  'developer:capture-diagnostics': none,
  'developer:clear-diagnostics': none,
  'developer:bridge-status': none,
  'developer:bridge-pair': none,
  'developer:bridge-disconnect': (args) => { exact(args, 1); requireBoolean(args[0]); },
  'developer:bridge-projects': none,
  'developer:bridge-select-project': (args) => { exact(args, 1); requireBoundedText(args[0], 'project identifier', 64); },
  'developer:bridge-action': (args) => {
    exact(args, 2);
    if (!DEVELOPER_BRIDGE_ACTIONS.has(args[0] as DeveloperBridgeAction)) throw new Error('Unsupported VS Code action');
    requireObject(args[1]);
  },
  'developer:inspect-page': (args) => { exact(args, 1); requireBoolean(args[0]); },
  'developer:prepare-ai-preview': (args) => {
    exact(args, 1);
    const options = requireObject(args[0]);
    if (options.includeDom !== undefined) requireBoolean(options.includeDom);
    if (options.includeScreenshot !== undefined) requireBoolean(options.includeScreenshot);
  },
  'developer:install-extension': none,
  'ai:prepare-preview': none,
  'ai:approve-preview': (args) => { exact(args, 1); requireUuid(args[0], 'page preview'); },
  'ai:provider-status': none,
  'ai:configure-provider': (args) => {
    exact(args, 1);
    const input = requireObject(args[0]);
    requireBoundedText(input.endpoint, 'AI endpoint', 2048);
    requireBoundedText(input.model, 'AI model', 1000);
    requireBoundedText(input.apiKey, 'AI provider key', 4096);
  },
  'ai:clear-provider': none,
  'ai:ask': (args) => { exact(args, 2); requireUuid(args[0], 'AI approval'); requireBoundedText(args[1], 'question', 10_000); },
  'ai:revoke': none,
  'vault:list': none,
  'vault:request-unlock': none,
  'vault:request-pairing': none,
  'vault:lock': none,
  'vault:sync': none,
  'vault:reconnect': none,
  'vault:conflict-review': none,
  'vault:resolve-conflict': (args) => { exact(args, 1); if (args[0] !== 'cloud' && args[0] !== 'local') throw new Error('Choose the cloud or local vault explicitly'); },
  'vault:migration-status': none,
  'vault:migrate-legacy': none,
  'vault:cleanup-legacy': none,
  'vault:open-editor': (args) => { between(args, 0, 1); if (args[0] !== undefined) requireBoundedText(args[0], 'site origin', 2048); },
  'vault:form-shape': none,
  'vault:save-from-page': none,
  'vault:request-delete': (args) => { exact(args, 1); requireIdentifierText(args[0], 'vault entry identifier'); },
  'vault:acknowledge-recovery': none,
  'vault:copy-password': (args) => { exact(args, 1); requireIdentifierText(args[0], 'vault entry identifier'); },
  'vault:copy-totp': (args) => { exact(args, 1); requireIdentifierText(args[0], 'vault entry identifier'); },
  'vault:copy-generated': (args) => { exact(args, 1); if (!GENERATED_CREDENTIAL_KINDS.has(String(args[0]))) throw new Error('Unsupported generator type'); },
  'vault:autofill': (args) => { exact(args, 1); requireIdentifierText(args[0], 'vault entry identifier'); },
  'system:copy': (args) => { exact(args, 1); requireBoundedText(args[0], 'copied text', 256 * 1024); },
  'system:is-default-browser': none,
  'system:set-default-browser': none,
  'updates:status': none,
  'updates:configure': (args) => {
    exact(args, 1);
    const input = requireObject(args[0]);
    requireBoundedText(input.endpoint, 'download service address', 2048);
    requireBoundedText(input.accessToken, 'download access token', 4096);
  },
  'updates:clear': none,
  'updates:check': none,
  'updates:open-page': none,
} as const satisfies Record<string, ArgumentsValidator>;

export type IpcChannel = keyof typeof IPC_CHANNEL_VALIDATORS;

export function isIpcChannel(channel: string): channel is IpcChannel {
  return Object.prototype.hasOwnProperty.call(IPC_CHANNEL_VALIDATORS, channel);
}

/**
 * Fail closed: a channel without a validator is refused, so a handler added
 * without its contract cannot silently accept arbitrary input.
 */
export function validateIpcArguments(channel: string, args: unknown[]): void {
  if (!isIpcChannel(channel)) throw new Error('Unknown browser command');
  IPC_CHANNEL_VALIDATORS[channel](args);
}

function requireBoundedNumber(value: unknown, field: string, minimum: number, maximum: number): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`Invalid ${field}`); return value; }
function requireIndex(value: unknown): void { if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 25_000) throw new Error('Invalid position'); }
function requireNonEmptyText(value: unknown, field: string, maximum: number): string { const text = requireBoundedText(value, field, maximum); if (!text.trim()) throw new Error(`A ${field} is required`); return text; }
function requireIdentifierText(value: unknown, field: string): string { return requireNonEmptyText(value, field, 200); }
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
