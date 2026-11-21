import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { effectiveReportParameters } from './report-history.js';
import { listTestFixtures, loadTestFixture, scenarioKey, scenarioViewports } from './test-scenario.js';

it('reads bounded project fixtures and rejects remaining URL fields and duplicate paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'private-browser-scenario-'));
  const folder = join(root, 'private-browser-fixtures');
  await mkdir(folder);
  await writeFile(join(folder, 'catalogue.json'), JSON.stringify({ version: 1, responses: [
    { path: '/api/catalogue', status: 200, json: { items: ['Sample'] } },
  ] }));
  await writeFile(join(folder, 'ignore.js'), 'throw new Error()');
  expect(await listTestFixtures(root)).toEqual(['catalogue.json']);
  const good = await loadTestFixture(root, 'catalogue.json');
  expect(good).toMatchObject({ digest: expect.stringMatching(/^[a-f0-9]{64}$/), responses: [{ path: '/api/catalogue', status: 200 }] });
  await expect(loadTestFixture(root, '../catalogue.json')).rejects.toThrow();
  for (const paths of [['https://example.test/x'], ['/api/path?query=part'], ['/api/items', '/api/items']]) {
    await writeFile(join(folder, 'catalogue.json'), JSON.stringify({ version: 1, responses: paths.map((path) => ({ path, status: 200, json: [] })) }));
    await expect(loadTestFixture(root, 'catalogue.json')).rejects.toThrow(/local paths/);
  }
});

it('matches baselines only for the same project, route, fixture version and viewport set', () => {
  const request = { projectId: 'a'.repeat(32), kind: 'baseline' as const, url: 'http://localhost:5173/catalogue',
    fixture: 'catalogue.json', fixtureDigest: 'a'.repeat(64), viewports: ['mobile', 'desktop'] as ('mobile' | 'desktop')[] };
  const base = effectiveReportParameters(request);
  expect(scenarioViewports(base)).toEqual(['desktop', 'mobile']);
  expect(scenarioKey(base)).toBe(scenarioKey(effectiveReportParameters({ ...request, kind: 'baseline-compare' })));
  for (const changes of [{ url: 'http://localhost:5173/cart' }, { fixtureDigest: 'b'.repeat(64) }, { viewports: ['desktop'] as ('desktop')[] }]) {
    expect(scenarioKey(base)).not.toBe(scenarioKey(effectiveReportParameters({ ...request, ...changes })));
  }
});
