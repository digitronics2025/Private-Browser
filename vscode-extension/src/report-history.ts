import { type ReportHistoryPage, type ReportHistoryQuery, type ReportRunParameters, type TestReport } from '@private-browser/bridge-protocol';
import { safeLiveOrigin, sanitizeOutput } from './security.js';

export interface StoredReport {
  report: TestReport;
  route?: string;
  savedParameters?: boolean;
}

export function reportRouteHint(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    return url.pathname.split('/').map((segment) => {
      let decoded: string;
      try { decoded = decodeURIComponent(segment); } catch { return '[private]'; }
      if (!/^[a-z0-9._~-]{0,48}$/i.test(decoded) || /\d{6,}|[a-f0-9]{20,}/i.test(decoded)) return '[private]';
      return decoded;
    }).join('/').slice(0, 300);
  } catch {
    return undefined;
  }
}

export function canSaveReportParameters(parameters: ReportRunParameters): boolean {
  for (const value of [parameters.url, parameters.liveUrl]) {
    if (!value || value === 'private://home') continue;
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return false;
      if (reportRouteHint(value)?.includes('[private]') || /(?:^|\/)(?:auth|login|reset|session|token|secret|password|oauth)(?:\/|$)/i.test(url.pathname)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function effectiveReportParameters(request: ReportRunParameters): ReportRunParameters {
  const { projectId, kind } = request;
  if (kind === 'quick' || kind === 'everything' || !request.url) return { projectId, kind };
  const url = new URL(request.url);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  const liveUrl = kind === 'live-site' || kind === 'compare' ? safeLiveOrigin(request.liveUrl ?? url.href) : undefined;
  return { projectId, kind, url: url.href, liveUrl };
}

export function queryReportHistory(entries: StoredReport[], approvedProjects: Array<{ id: string; name: string }>,
  query: ReportHistoryQuery, sessionRuns: ReadonlySet<string>): ReportHistoryPage {
  const projects = approvedProjects.slice(0, 50);
  const names = new Map(projects.map(({ id, name }) => [id, sanitizeOutput(name, 300).slice(0, 300)]));
  const text = query.text?.toLocaleLowerCase().trim() ?? '';
  const filtered = entries.flatMap((entry) => {
    const { report, route } = entry;
    const projectName = names.get(report.projectId);
    if (!projectName || (query.project && query.project !== report.projectId)
      || (query.status && query.status !== report.status) || (query.date && !report.finishedAt.startsWith(query.date))) return [];
    const title = sanitizeOutput(report.title, 300).slice(0, 300);
    if (text && ![title, projectName, route ?? '', report.kind].some((value) => value.toLocaleLowerCase().includes(text))) return [];
    return [{ id: report.id, projectId: report.projectId, projectName, title, route,
      kind: report.kind, status: report.status, finishedAt: report.finishedAt, findings: report.findings.length,
      artifacts: report.artifacts.length, replayable: entry.savedParameters === true || sessionRuns.has(report.id) }];
  });
  const pages = Math.max(1, Math.ceil(filtered.length / 20));
  const page = Math.min(query.page ?? 1, pages);
  return { page, pages, total: filtered.length, projects: projects.map(({ id }) => ({ id, name: names.get(id)! })),
    rows: filtered.slice((page - 1) * 20, page * 20) };
}
