import { createHash } from 'node:crypto';
import type { AccountSpaceId, AiPagePreview, BrowserTab } from './types.js';

export type AiSourceService = 'browser' | 'gmail' | 'drive' | 'calendar' | 'contacts';

export function classifyAiSource(urlValue: string): AiSourceService {
  let hostname = '';
  try { hostname = new URL(urlValue).hostname.toLowerCase(); } catch { return 'browser'; }
  if (hostname === 'mail.google.com') return 'gmail';
  if (hostname === 'drive.google.com' || hostname === 'docs.google.com') return 'drive';
  if (hostname === 'calendar.google.com') return 'calendar';
  if (hostname === 'contacts.google.com') return 'contacts';
  return 'browser';
}

export function aiSourceRevision(accountSpaceId: AccountSpaceId, tab: Pick<BrowserTab, 'id' | 'url' | 'title'>, sanitizedText: string): string {
  return createHash('sha256').update(accountSpaceId).update('\0').update(tab.id).update('\0').update(tab.url).update('\0').update(tab.title).update('\0').update(sanitizedText).digest('base64url');
}

export function sameAiSource(preview: AiPagePreview, accountSpaceId: AccountSpaceId, tab: Pick<BrowserTab, 'id' | 'url'>): boolean {
  return preview.accountSpaceId === accountSpaceId && preview.tabId === tab.id && preview.sourceUrl === tab.url;
}

export function maySendAiPreviewToCloud(preview: AiPagePreview): boolean {
  // Mailbox contents are never model input. Gmail metadata is available only
  // through the narrow local Google service client and cannot enter this path.
  return preview.service !== 'gmail';
}
