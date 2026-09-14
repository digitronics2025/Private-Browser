import type { ShortcutTile, WorkspaceId } from '../../electron/types';

export const QUICK_LINKS: Record<WorkspaceId, Array<{ label: string; url: string }>> = {
  digitronics: [
    { label: 'Digitronics', url: 'https://digitronics.ma' },
    { label: 'Meta Ads', url: 'https://business.facebook.com/adsmanager' },
    { label: 'WhatsApp', url: 'https://web.whatsapp.com' },
  ],
  tenten: [
    { label: 'TenTen', url: 'https://tenten.ma' },
    { label: 'Google Sheets', url: 'https://sheets.google.com' },
    { label: 'Jumia', url: 'https://vendorhub.jumia.ma' },
    { label: 'Marjane', url: 'https://www.marjanemall.ma' },
  ],
  development: [
    { label: 'GitHub', url: 'https://github.com' },
    { label: 'Cloudflare', url: 'https://dash.cloudflare.com' },
    { label: 'Private Browser', url: 'https://github.com/digitronics2025/Private-Browser' },
    { label: 'Workers Docs', url: 'https://developers.cloudflare.com/workers/' },
  ],
  personal: [
    { label: 'Gmail', url: 'https://mail.google.com' },
    { label: 'Drive', url: 'https://drive.google.com' },
    { label: 'Calendar', url: 'https://calendar.google.com' },
    { label: 'Maps', url: 'https://maps.google.com' },
  ],
  banking: [
    { label: 'Secure search', url: 'https://duckduckgo.com' },
  ],
};

export function defaultShortcutTiles(workspaceId: WorkspaceId): ShortcutTile[] {
  return QUICK_LINKS[workspaceId].map((link, index) => ({ id: `default-${workspaceId}-${index}`, title: link.label, url: link.url }));
}
