import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { effectiveReportParameters } from './report-history.js';
import { listTestFixtures, loadTestFixture, scenarioKey, scenarioViewports } from './test-scenario.js';
import { smokeLatency } from './keyboard-smoke.js';

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

it('reads a bounded keyboard flow and rejects free-form inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'private-browser-smoke-'));
  const directory = join(root, 'private-browser-fixtures');
  await mkdir(directory);
  const path = join(directory, 'keyboard.json');
  const visible = { role: 'heading', name: 'Details', state: 'visible' };
  const smoke = { repeats: 3, budgetMs: 1000, steps: [{ key: 'Enter', expect: visible }] };
  const write = (value: unknown) => writeFile(path, JSON.stringify({ version: 1, responses: [], smoke: value }));
  await write(smoke);
  expect((await loadTestFixture(root, 'keyboard.json')).smoke).toEqual(smoke);
  for (const bad of [{ ...smoke, repeats: 1 }, { ...smoke, budgetMs: 100_000 }, { ...smoke, steps: [{ key: 'Control+L', expect: visible }] },
    { ...smoke, steps: [{ key: 'Enter', expect: { ...visible, name: 'bad\nname' } }] }]) {
    await write(bad);
    await expect(loadTestFixture(root, 'keyboard.json')).rejects.toThrow();
  }
  expect(smokeLatency([20, 7, 45, 10])).toEqual({ median: 15, p90: 45 });
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
