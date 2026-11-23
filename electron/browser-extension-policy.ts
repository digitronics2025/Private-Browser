/** The deliberately small extension surface supported by Private Browser.
 * Extensions run with powerful browser privileges; reject anything outside this
 * explicit Manifest V3 content-script subset instead of silently half-working.
 */

export interface BrowserExtensionReview {
  name: string;
  version: string;
  description: string;
  permissions: string[];
  requestedOrigins: string[];
}

export interface BrowserExtensionManifest extends Record<string, unknown> {
  manifest_version: 3;
  name: string;
  version: string;
  permissions?: string[];
  host_permissions?: string[];
  content_scripts: Array<Record<string, unknown>>;
}

const ALLOWED_MANIFEST_KEYS = new Set([
  'manifest_version', 'name', 'version', 'description', 'permissions', 'host_permissions', 'content_scripts', 'background',
]);
const ALLOWED_PERMISSIONS = new Set(['activeTab', 'scripting', 'storage']);
const MAX_ORIGINS = 40;
const MAX_CONTENT_SCRIPTS = 40;
const MAX_SCRIPT_FILES = 80;
const MAX_RESOURCE_PATH = 240;

export function inspectBrowserExtensionManifest(value: unknown): {
  manifest: BrowserExtensionManifest;
  review: BrowserExtensionReview;
} {
  if (!isRecord(value)) throw new Error('Extension manifest must be a JSON object.');
  const unsupportedKeys = Object.keys(value).filter((key) => !ALLOWED_MANIFEST_KEYS.has(key));
  if (unsupportedKeys.length) throw new Error(`Unsupported manifest features: ${unsupportedKeys.slice(0, 5).join(', ')}.`);
  if (value.manifest_version !== 3) throw new Error('Only Manifest V3 extensions are supported.');
  const name = boundedText(value.name, 120, 'Extension name');
  const version = boundedText(value.version, 48, 'Extension version');
  if (!/^\d+(?:\.\d+){0,3}$/.test(version)) throw new Error('Extension version must use numeric version parts.');
  const description = typeof value.description === 'string' ? value.description.slice(0, 500) : '';
  const permissions = stringArray(value.permissions, 'permissions');
  const unsupportedPermissions = permissions.filter((permission) => !ALLOWED_PERMISSIONS.has(permission));
  if (unsupportedPermissions.length) throw new Error(`Unsupported permissions: ${unsupportedPermissions.slice(0, 5).join(', ')}.`);

  const rawHosts = [
    ...stringArray(value.host_permissions, 'host_permissions'),
    ...contentScriptMatches(value.content_scripts),
  ];
  const requestedOrigins = [...new Set(rawHosts.map(parseExactHttpsPattern))].sort();
  if (!requestedOrigins.length) throw new Error('This extension has no supported HTTPS site access or content scripts.');
  if (requestedOrigins.length > MAX_ORIGINS) throw new Error('This extension requests too many sites.');
  const contentScripts = validateContentScripts(value.content_scripts);
  const manifest: BrowserExtensionManifest = {
    ...value,
    manifest_version: 3,
    name,
    version,
    permissions,
    ...(value.host_permissions === undefined ? {} : { host_permissions: stringArray(value.host_permissions, 'host_permissions') }),
    content_scripts: contentScripts,
  };
  return { manifest, review: { name, version, description, permissions, requestedOrigins } };
}

export function manifestForAllowedOrigins(manifest: BrowserExtensionManifest, allowedOrigins: readonly string[]): BrowserExtensionManifest {
  const allowed = new Set(allowedOrigins);
  if (allowed.size !== allowedOrigins.length || [...allowed].some((origin) => !parseExactHttpsOrigin(origin))) {
    throw new Error('Invalid site access selection.');
  }
  const allDeclared = new Set([
    ...(manifest.host_permissions ?? []).map(parseExactHttpsPattern),
    ...contentScriptMatches(manifest.content_scripts).map(parseExactHttpsPattern),
  ]);
  if ([...allowed].some((origin) => !allDeclared.has(origin))) throw new Error('The extension changed. Review it again before granting site access.');
  const host_permissions = allowedOrigins.map((origin) => `${origin}/*`);
  const content_scripts = manifest.content_scripts.flatMap((entry) => {
    const matches = Array.isArray(entry.matches) ? entry.matches.filter((pattern) => {
      try { return allowed.has(parseExactHttpsPattern(pattern)); } catch { return false; }
    }) : [];
    return matches.length ? [{ ...entry, matches }] : [];
  });
  return { ...manifest, host_permissions, content_scripts };
}

export function parseExactHttpsPattern(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512) throw new Error('Only exact HTTPS site permissions are supported.');
  const match = /^https:\/\/([^/*?#]+)\/\*$/.exec(value);
  if (!match) throw new Error('Only exact HTTPS site permissions are supported; wildcards and broad site access are refused.');
  const url = new URL(`https://${match[1]}/`);
  if (url.username || url.password || url.port || url.hostname !== url.hostname.toLowerCase() || url.hostname.endsWith('.')) {
    throw new Error('Only canonical HTTPS host permissions are supported.');
  }
  return url.origin;
}

function parseExactHttpsOrigin(origin: string): boolean {
  try { return new URL(origin).origin === origin && origin.startsWith('https://'); } catch { return false; }
}

function contentScriptMatches(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CONTENT_SCRIPTS) throw new Error('Invalid content_scripts list.');
  return value.flatMap((entry) => {
    if (!isRecord(entry)) throw new Error('Invalid content script entry.');
    if (entry.match_about_blank === true || entry.match_origin_as_fallback === true) {
      throw new Error('Content scripts may only run on explicitly allowed HTTPS websites.');
    }
    const matches = stringArray(entry.matches, 'content_scripts.matches');
    const scripts = [...stringArray(entry.js, 'content_scripts.js'), ...stringArray(entry.css, 'content_scripts.css')];
    if (!scripts.length || scripts.length > MAX_SCRIPT_FILES) throw new Error('Each content script must name supported local JavaScript or CSS files.');
    for (const path of scripts) validateResourcePath(path);
    return matches;
  });
}

function validateContentScripts(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CONTENT_SCRIPTS) {
    throw new Error('Only extensions with explicit content scripts are supported.');
  }
  return value.map((entry) => {
    if (!isRecord(entry)) throw new Error('Invalid content script entry.');
    const supportedKeys = new Set(['matches', 'js', 'css', 'run_at', 'all_frames', 'world']);
    if (Object.keys(entry).some((key) => !supportedKeys.has(key))) throw new Error('Unsupported content script feature.');
    const matches = stringArray(entry.matches, 'content_scripts.matches');
    matches.forEach(parseExactHttpsPattern);
    if (entry.run_at !== undefined && !['document_start', 'document_end', 'document_idle'].includes(String(entry.run_at))) {
      throw new Error('Unsupported content script timing.');
    }
    if (entry.all_frames !== undefined && typeof entry.all_frames !== 'boolean') throw new Error('Invalid all_frames setting.');
    if (entry.world !== undefined && entry.world !== 'ISOLATED') throw new Error('Content scripts must use the isolated execution world.');
    return { ...entry, matches };
  });
}

export function validateResourcePath(path: string): void {
  if (path.length > MAX_RESOURCE_PATH || path.startsWith('/') || path.includes('\\') || path.includes(':')
    || path.split('/').some((part) => part === '' || part === '.' || part === '..') || /[\u0000-\u001f]/.test(path)) {
    throw new Error('The extension contains an unsafe resource path.');
  }
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_SCRIPT_FILES || value.some((item) => typeof item !== 'string' || item.length > MAX_RESOURCE_PATH)) {
    throw new Error(`Invalid ${field} list.`);
  }
  return [...new Set(value as string[])];
}

function boundedText(value: unknown, maximum: number, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid ${field}.`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
