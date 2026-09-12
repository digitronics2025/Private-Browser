import type {
  AccountSpaceColor,
  AccountSpaceId,
  GoogleModule,
  PermissionCapability,
  PermissionDecision,
  WorkspaceId,
} from './types.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKSPACE_IDS = new Set<WorkspaceId>(['digitronics', 'tenten', 'development', 'personal', 'banking']);
const ACCOUNT_COLORS = new Set<AccountSpaceColor>(['indigo', 'sky', 'emerald', 'amber', 'rose', 'violet', 'slate']);
const GOOGLE_MODULES = new Set<GoogleModule>([
  'identity',
  'gmail-metadata',
  'gmail-read',
  'gmail-send',
  'drive-files',
  'drive-metadata',
  'drive-read',
  'calendar-read',
  'calendar-write',
  'contacts-read',
  'encrypted-backup',
]);
const PERMISSION_CAPABILITIES = new Set<PermissionCapability>([
  'notifications',
  'microphone',
  'camera',
  'camera-and-microphone',
  'display-capture',
  'geolocation',
  'clipboard-read',
  'clipboard-write',
  'file-system',
  'download',
]);
const PERMISSION_DECISIONS = new Set<PermissionDecision>(['allow-once', 'allow-session', 'allow-always', 'deny']);

export const ACCOUNT_LABEL_MAX_LENGTH = 80;
export const GOOGLE_OPERATION_BODY_MAX_LENGTH = 64 * 1024;
export const GOOGLE_OPERATION_ARRAY_MAX_ITEMS = 100;

export function isAccountSpaceId(value: unknown): value is AccountSpaceId {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function requireAccountSpaceId(value: unknown): AccountSpaceId {
  if (!isAccountSpaceId(value)) throw new Error('Invalid Account Space identifier');
  return value;
}

export function requireWorkspaceId(value: unknown): WorkspaceId {
  if (typeof value !== 'string' || !WORKSPACE_IDS.has(value as WorkspaceId)) {
    throw new Error('Invalid workspace identifier');
  }
  return value as WorkspaceId;
}

export function requireAccountLabel(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Account Space label must be text');
  const label = value.trim();
  if (label.length === 0 || label.length > ACCOUNT_LABEL_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(label)) {
    throw new Error('Account Space label must contain 1 to 80 printable characters');
  }
  return label;
}

export function requireAccountColor(value: unknown): AccountSpaceColor {
  if (typeof value !== 'string' || !ACCOUNT_COLORS.has(value as AccountSpaceColor)) {
    throw new Error('Invalid Account Space colour');
  }
  return value as AccountSpaceColor;
}

export function requireGoogleModules(value: unknown): GoogleModule[] {
  if (!Array.isArray(value) || value.length > GOOGLE_MODULES.size) throw new Error('Invalid Google module selection');
  const modules = value.map((module) => {
    if (typeof module !== 'string' || !GOOGLE_MODULES.has(module as GoogleModule)) throw new Error('Invalid Google module');
    return module as GoogleModule;
  });
  return [...new Set(modules)];
}

export function requirePermissionCapability(value: unknown): PermissionCapability {
  if (typeof value !== 'string' || !PERMISSION_CAPABILITIES.has(value as PermissionCapability)) {
    throw new Error('Invalid permission capability');
  }
  return value as PermissionCapability;
}

export function requirePermissionDecision(value: unknown): PermissionDecision {
  if (typeof value !== 'string' || !PERMISSION_DECISIONS.has(value as PermissionDecision)) {
    throw new Error('Invalid permission decision');
  }
  return value as PermissionDecision;
}

export function requireExactWebOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid requesting origin');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid requesting origin');
  }
  if (url.origin !== value || (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname)))) {
    throw new Error('Permission grants require an exact trustworthy origin');
  }
  return url.origin;
}

export function requireBoundedText(value: unknown, field: string, maximum = GOOGLE_OPERATION_BODY_MAX_LENGTH): string {
  if (typeof value !== 'string' || value.length > maximum) throw new Error(`${field} exceeds its allowed size`);
  return value;
}

export function requireBoundedStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > GOOGLE_OPERATION_ARRAY_MAX_ITEMS) throw new Error(`${field} exceeds its allowed size`);
  return value.map((entry) => requireBoundedText(entry, field, 2048));
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1' || /^127(?:\.|$)/.test(normalized);
}
