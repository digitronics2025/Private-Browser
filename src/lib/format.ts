export function domainFromUrl(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

export function humanBytes(value: number): string {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

export function timeAgo(value: string): string {
  const seconds = Math.max(1, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function formatReleaseDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

/**
 * Favicons already fetched by the main process, keyed by host: live tab icons
 * first, then the icons remembered for bookmarked hosts. The chrome never fetches icons itself.
 */
export function faviconsByHost(tabs: Array<{ url: string; favicon?: string }>, remembered: Record<string, string> = {}): Map<string, string> {
  const icons = new Map<string, string>();
  for (const tab of tabs) {
    if (!tab.favicon) continue;
    const host = domainFromUrl(tab.url);
    if (!icons.has(host)) icons.set(host, tab.favicon);
  }
  for (const [host, icon] of Object.entries(remembered)) if (!icons.has(host)) icons.set(host, icon);
  return icons;
}
