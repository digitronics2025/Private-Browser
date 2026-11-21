import { describe, expect, it } from 'vitest';
import { browsingDataVisitIds, requireBrowsingDataInput } from '../electron/browsing-data';
import type { AccountSpaceId, BrowsingDataInput, HistoryEntry } from '../electron/types';

const owner = '49a47390-cfc7-49d1-9f1f-d10952317ca3' as AccountSpaceId;
const other = '383d9c7c-9108-43e8-aad3-f59699a48822' as AccountSpaceId;
const options: BrowsingDataInput = { accountSpaceId: owner, range: 'hour', site: 'https://site.example.test/page', history: true, websiteData: false, cache: false };
const now = Date.parse('2026-11-21T17:00:00Z');

function visit(id: string, accountSpaceId = owner, url = 'https://site.example.test/', minutesAgo = 1): HistoryEntry {
  return { id, title: id, workspaceId: 'personal', accountSpaceId, url, visitedAt: new Date(now - minutesAgo * 60_000).toISOString() };
}

describe('reviewed browsing data', () => {
  it('selects exact visit IDs for the reviewed time, origin and account', () => {
    const history = [
      visit('selected'),
      visit('at-boundary', owner, 'https://site.example.test/other', 60),
      visit('outside-time', owner, 'https://site.example.test/', 61),
      visit('outside-origin', owner, 'https://other.site.example.test/'),
      visit('outside-account', other),
    ];
    const reviewed = requireBrowsingDataInput(options);
    expect(reviewed.siteOrigin).toBe('https://site.example.test');
    expect([...browsingDataVisitIds(history, reviewed, now)]).toEqual(['selected', 'at-boundary']);
    expect([...browsingDataVisitIds(history, { ...reviewed, history: false }, now)]).toEqual([]);
  });

  it('rejects invalid or empty scope without expanding it to all websites', () => {
    for (const option of [{ site: 'file:///sample' }, { site: 'https://' }, { history: false }, { range: 'everything' }, { accountSpaceId: 'invalid' }]) {
      expect(() => requireBrowsingDataInput({ ...options, ...option })).toThrow();
    }
  });
});
