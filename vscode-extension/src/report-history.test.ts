import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { reportHistoryPageSchema, type TestReport } from '@private-browser/bridge-protocol';
import { canSaveReportParameters, effectiveReportParameters, queryReportHistory, reportRouteHint } from './report-history.js';
import { ReportStore } from './report-store.js';

const firstProject = 'a'.repeat(32);
const secondProject = 'b'.repeat(32);
const finishedAt = new Date().toISOString();

function report(projectId: string, status: TestReport['status']): TestReport {
  return {
    id: randomUUID(), projectId, status, kind: 'responsive', title: 'Layout check',
    startedAt: finishedAt, finishedAt, summary: 'Detailed test-only output',
    findings: [{ status, title: 'Detail', cause: 'Detail', evidence: 'Private fixture output', recommendation: 'Review' }],
    artifacts: [],
  };
}

describe('local test report history', () => {
  it('retains a compatible route hint and deletes settings with the selected report', async () => {
    const root = await mkdtemp(join(tmpdir(), 'private-browser-report-history-'));
    const onDelete = vi.fn(async () => undefined);
    const store = new ReportStore(root, () => ({ days: 30, max: 50 }), onDelete);
    const old = report(firstProject, 'passed');
    const latest = report(firstProject, 'failed');
    try {
      await store.save(old);
      await store.save(latest, { route: '/catalogue/[private]', savedParameters: true });
      expect(await store.get(old.id)).toEqual(old);
      expect(await store.history()).toEqual(expect.arrayContaining([
        { report: old }, { report: latest, route: '/catalogue/[private]', savedParameters: true },
      ]));
      await store.delete(latest.id);
      expect(onDelete).toHaveBeenCalledExactlyOnceWith(latest.id);
      expect(await store.history()).toEqual([{ report: old }]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('queries only approved projects with bounded metadata and stable filters', () => {
    const chosen = report(firstProject, 'failed');
    const data = [{ report: chosen, route: '/catalogue' }, { report: report(secondProject, 'failed'), route: '/catalogue' }];
    const query = { text: 'CATALOGUE', project: firstProject, status: 'failed' as const, date: finishedAt.slice(0, 10), page: 39 };
    const approved = [{ id: firstProject, name: 'Fixture workspace' }];
    const page = reportHistoryPageSchema.parse(queryReportHistory(data, approved, query, new Set([chosen.id])));
    expect(page).toMatchObject({ total: 1, page: 1, rows: [{ id: chosen.id, findings: 1, replayable: true }] });
    expect(JSON.stringify(page)).not.toContain('Private fixture output');
    expect(queryReportHistory(data, approved, { project: secondProject }, new Set()).total).toBe(0);
  });

  it('keeps effective test parameters and excludes sensitive routes from durable replay', () => {
    const approved = { projectId: firstProject, kind: 'responsive' as const, url: 'http://127.0.0.1:9300/catalogue?preview=fixture#area' };
    expect(reportRouteHint('http://localhost:9300/order/123456789?preview=fixture')).toBe('/order/[private]');
    const actual = effectiveReportParameters(approved);
    expect(actual.url).toBe('http://127.0.0.1:9300/catalogue');
    expect(canSaveReportParameters(actual)).toBe(true);
    expect(canSaveReportParameters({ ...actual, url: 'http://127.0.0.1:9300/reset/fixture' })).toBe(false);
  });
});
