import type { AccountSpaceId, TrackerCategory, TrackerSiteStatus } from './types.js';
import { isAllowedRemoteUrl, isLocalDevelopmentHost, isProtectedPage, navigationWarning } from './security.js';

const trackers: Readonly<Record<TrackerCategory, readonly string[]>> = {
  advertising: ['2mdn.net', 'adnxs.com', 'adsrvr.org', 'amazon-adsystem.com', 'criteo.com', 'criteo.net', 'doubleclick.net',
    'googlesyndication.com', 'googleadservices.com', 'taboola.com', 'quantserve.com'],
  analytics: ['app-measurement.com', 'clarity.ms', 'google-analytics.com', 'googletagmanager.com', 'fullstory.com',
    'hotjar.com', 'mixpanel.com', 'optimizely.com', 'segment.io', 'scorecardresearch.com', 'mc.yandex.ru'],
  social: ['connect.facebook.net', 'analytics.twitter.com'],
  telemetry: ['newrelic.com', 'sentry.io'],
};

const domains = new Map<string, TrackerCategory>(Object.entries(trackers).flatMap(([category, hosts]) =>
  hosts.map((host) => [host, category as TrackerCategory])));
const MAX_TRACKED_SITES = 100;
export const TRACKER_COMPATIBILITY_MS = 10 * 60 * 1000;

export function canPauseTrackersAt(url: string): boolean {
  if (!isAllowedRemoteUrl(url) || isProtectedPage(url) || navigationWarning(url) === 'idn') return false;
  const page = new URL(url);
  return page.protocol === 'https:' || isLocalDevelopmentHost(page.hostname);
}

export function trackerCategory(url: string): TrackerCategory | undefined {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase().replace(/\.$/, ''); }
  catch { return undefined; }
  while (host.includes('.')) {
    const category = domains.get(host);
    if (category) return category;
    host = host.slice(host.indexOf('.') + 1);
  }
}

interface TrackerSite {
  counts: Partial<Record<TrackerCategory, number>>;
  pausedUntil?: number;
}

export class TrackerProtection {
  private readonly accounts = new Map<AccountSpaceId, Map<string, TrackerSite>>();
  constructor(private readonly now = Date.now) {}

  shouldBlock(account: AccountSpaceId, category: TrackerCategory, options: { origin?: string; enabled: boolean; strict: boolean }): boolean {
    if (!options.enabled && !options.strict) return false;
    const site = options.origin ? this.touch(account, options.origin) : undefined;
    if (!options.strict && site?.pausedUntil && site.pausedUntil > this.now()) return false;
    if (site) site.counts[category] = Math.min(1_000_000, (site.counts[category] ?? 0) + 1);
    return true;
  }

  pause(account: AccountSpaceId, origin: string, enabled: boolean): void {
    const site = this.touch(account, origin);
    if (enabled) site.pausedUntil = this.now() + TRACKER_COMPATIBILITY_MS;
    else delete site.pausedUntil;
  }

  status(account: AccountSpaceId, origin: string, options: { enabled: boolean; strict: boolean; canPause: boolean }): TrackerSiteStatus {
    const site = this.accounts.get(account)?.get(origin);
    const pausedUntil = !options.strict && site?.pausedUntil && site.pausedUntil > this.now() ? site.pausedUntil : undefined;
    return { origin, counts: { ...site?.counts }, pausedUntil, blocking: options.strict || (options.enabled && !pausedUntil), canPause: options.canPause };
  }

  clearAccount(account: AccountSpaceId): void { this.accounts.delete(account); }

  private touch(account: AccountSpaceId, origin: string): TrackerSite {
    let sites = this.accounts.get(account);
    if (!sites) this.accounts.set(account, sites = new Map());
    const previous = sites.get(origin);
    const site = previous ?? { counts: {} };
    if (previous) sites.delete(origin);
    sites.set(origin, site);
    if (sites.size > MAX_TRACKED_SITES) sites.delete(sites.keys().next().value!);
    return site;
  }
}
