import { createHash } from 'node:crypto';
import { open, readdir } from 'node:fs/promises';
import { testFixtureSchema, TEST_VIEWPORTS, type ReportRunParameters, type TestViewport } from '@private-browser/bridge-protocol';
import { resolveInsideWorkspace } from './security.js';

const FIXTURE_DIRECTORY = 'private-browser-fixtures';
const MAX_FIXTURE_BYTES = 64 * 1024;

export interface FixtureResponse {
  path: string;
  status: number;
  json: unknown;
}

const SMOKE_KEYS = ['Tab', 'Shift+Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Space', 'Escape'] as const;
const SMOKE_ROLES = ['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'tab', 'menuitem', 'option', 'dialog', 'heading', 'status'] as const;

export interface KeyboardSmokeCheck {
  repeats: number;
  budgetMs: number;
  steps: {
    key: typeof SMOKE_KEYS[number];
    expect: { role: typeof SMOKE_ROLES[number]; name: string; state: 'focused' | 'visible' };
  }[];
}

export const SCENARIO_VIEWPORTS: Record<TestViewport, { width: number; height: number }> = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 375, height: 812 },
};

export function scenarioViewports(parameters: Pick<ReportRunParameters, 'kind' | 'viewports'>): readonly TestViewport[] {
  return parameters.viewports ?? (parameters.kind === 'responsive' ? TEST_VIEWPORTS : ['desktop']);
}

export function scenarioKey(parameters: ReportRunParameters): string {
  return JSON.stringify([parameters.projectId, parameters.url, parameters.fixture, parameters.fixtureDigest, scenarioViewports(parameters)]);
}

export async function listTestFixtures(root: string): Promise<string[]> {
  const path = await resolveInsideWorkspace(root, FIXTURE_DIRECTORY).catch(() => undefined);
  if (!path) return [];
  const entries = await readdir(path, { withFileTypes: true });
  return entries.filter((item) => item.isFile() && testFixtureSchema.safeParse(item.name).success)
    .map((item) => item.name).sort().slice(0, 25);
}

export async function loadTestFixture(root: string, name: string): Promise<{ digest: string; responses: FixtureResponse[]; smoke?: KeyboardSmokeCheck }> {
  const path = await resolveInsideWorkspace(root, FIXTURE_DIRECTORY + '/' + testFixtureSchema.parse(name));
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FIXTURE_BYTES) throw new Error('Choose a fixture smaller than 64 KiB.');
    const source = Buffer.alloc(stat.size + 1);
    const read = await file.read(source);
    if (read.bytesRead !== stat.size) throw new Error('The fixture changed while it was being read.');
    const bytes = source.subarray(0, read.bytesRead);
    return { digest: createHash('sha256').update(bytes).digest('hex'), ...parseFixture(JSON.parse(bytes.toString('utf8'))) };
  } finally {
    await file.close();
  }
}

function parseFixture(value: unknown): { responses: FixtureResponse[]; smoke?: KeyboardSmokeCheck } {
  const raw = value as { version?: unknown; responses?: unknown; smoke?: unknown };
  if (!raw || raw.version !== 1 || !Array.isArray(raw.responses) || raw.responses.length > 20) throw new Error('Invalid version 1 fixture.');
  const paths = new Set<string>();
  const responses = raw.responses.map((entry) => {
    const item = entry as Partial<FixtureResponse>;
    if (!item || typeof item.path !== 'string' || !/^\/(?!\/)[A-Za-z0-9_.~%/-]{1,240}$/.test(item.path)
      || new URL(item.path, 'http://fixture.test').pathname !== item.path || paths.has(item.path)
      || !Number.isInteger(item.status) || Number(item.status) < 200 || Number(item.status) > 599
      || Number(item.status) === 204 || Number(item.status) === 205 || Math.floor(Number(item.status) / 100) === 3
      || !Object.hasOwn(item, 'json')) throw new Error('A fixture needs distinct local paths, HTTP response codes and JSON bodies.');
    paths.add(item.path);
    return { path: item.path, status: item.status!, json: item.json };
  });
  return { responses, smoke: raw.smoke === undefined ? undefined : parseKeyboardSmoke(raw.smoke) };
}

function parseKeyboardSmoke(value: unknown): KeyboardSmokeCheck {
  if (!value || typeof value !== 'object') throw new Error('Choose a bounded keyboard smoke check.');
  const check = value as Partial<KeyboardSmokeCheck>;
  if (!Number.isInteger(check.repeats) || check.repeats! < 2 || check.repeats! > 5
    || !Number.isInteger(check.budgetMs) || check.budgetMs! < 100 || check.budgetMs! > 10_000
    || !Array.isArray(check.steps) || !check.steps.length || check.steps.length > 16) {
    throw new Error('A keyboard smoke check needs 2–5 repeats, a 100–10,000 ms budget and 1–16 steps.');
  }
  const steps = check.steps.map((step) => {
    const expected = step?.expect;
    if (!step || !SMOKE_KEYS.includes(step.key) || !expected || !SMOKE_ROLES.includes(expected.role)
      || typeof expected.name !== 'string' || !expected.name.trim() || expected.name.length > 120
      || /[\u0000-\u001f\u007f]/.test(expected.name) || (expected.state !== 'focused' && expected.state !== 'visible')) {
      throw new Error('Each keyboard step needs an allowed key, exact accessible name and a focus or visibility check.');
    }
    return { key: step.key, expect: { role: expected.role, name: expected.name, state: expected.state } };
  });
  return { repeats: check.repeats!, budgetMs: check.budgetMs!, steps };
}
