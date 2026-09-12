import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { testReportSchema, type TestReport } from '@private-browser/bridge-protocol';

const MAX_REPORT_BYTES = 2 * 1024 * 1024;

export class ReportStore {
  constructor(private readonly root: string, private readonly retention: () => { days: number; max: number }) {}

  artifactRoot(reportId: string): string { return join(this.root, 'artifacts', reportId); }

  async save(report: TestReport): Promise<TestReport> {
    const validated = testReportSchema.parse(report);
    await mkdir(this.root, { recursive: true });
    await writeFile(join(this.root, `${validated.id}.json`), JSON.stringify(validated, null, 2), { encoding: 'utf8', mode: 0o600 });
    await this.prune();
    return validated;
  }

  async list(): Promise<TestReport[]> {
    await mkdir(this.root, { recursive: true });
    const names = (await readdir(this.root)).filter((name) => /^[a-f\d-]{36}\.json$/i.test(name));
    const reports: TestReport[] = [];
    for (const name of names) {
      try { reports.push(await this.readReport(join(this.root, name))); } catch { /* ignore corrupt local report entries */ }
    }
    return reports.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
  }

  async get(id: string): Promise<TestReport> {
    if (!/^[a-f\d-]{36}$/i.test(id)) throw new Error('Invalid report id');
    return this.readReport(join(this.root, `${id}.json`));
  }

  async delete(id: string): Promise<void> {
    if (!/^[a-f\d-]{36}$/i.test(id)) throw new Error('Invalid report id');
    await rm(join(this.root, `${id}.json`), { force: true });
    await rm(this.artifactRoot(id), { recursive: true, force: true });
  }

  async clear(): Promise<void> { await rm(this.root, { recursive: true, force: true }); await mkdir(this.root, { recursive: true }); }

  async prune(): Promise<void> {
    const reports = await this.list();
    const { days, max } = this.retention();
    const cutoff = Date.now() - days * 86_400_000;
    for (const [index, report] of reports.entries()) if (index >= max || Date.parse(report.finishedAt) < cutoff) await this.delete(report.id);
  }

  static skipped(projectId: string, kind: TestReport['kind'], title: string, summary: string): TestReport {
    const now = new Date().toISOString();
    return { id: randomUUID(), projectId, kind, status: 'skipped', title, startedAt: now, finishedAt: now, summary, findings: [{ status: 'skipped', title, cause: summary, evidence: '', recommendation: summary }], artifacts: [] };
  }

  private async readReport(path: string): Promise<TestReport> {
    const file = await open(path, 'r');
    try {
      if ((await file.stat()).size > MAX_REPORT_BYTES) throw new Error('Stored report is too large');
      return testReportSchema.parse(JSON.parse(await file.readFile('utf8')) as unknown);
    } finally { await file.close(); }
  }
}
