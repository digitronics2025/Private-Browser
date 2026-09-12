import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectProject } from './adapters.js';
import { ReportStore } from './report-store.js';
import { isSecretPath, resolveInsideWorkspace, safeLiveOrigin, sanitizeOutput } from './security.js';

const roots: string[] = [];
async function fixture(): Promise<string> { const root = await mkdtemp(join(tmpdir(), 'private-browser-bridge-')); roots.push(root); return root; }
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

describe('workspace security', () => {
  it('rejects traversal and secret files while allowing ordinary source files', async () => {
    const root = await fixture(); await mkdir(join(root, 'src')); await writeFile(join(root, 'src', 'app.ts'), 'export {};'); await writeFile(join(root, '.env'), 'TOKEN=fixture');
    expect(await resolveInsideWorkspace(root, 'src/app.ts')).toBe(join(root, 'src', 'app.ts'));
    expect(await resolveInsideWorkspace(root, 'tests/e2e/new.spec.ts', true)).toBe(join(root, 'tests', 'e2e', 'new.spec.ts'));
    await expect(resolveInsideWorkspace(root, '../outside.txt')).rejects.toThrow(/escapes/i);
    await expect(resolveInsideWorkspace(root, '.env')).rejects.toThrow(/secret/i);
    expect(isSecretPath(join(root, 'profile', 'Cookies'))).toBe(true);
  });

  it('rejects a symlink that resolves outside the approved root', async () => {
    const root = await fixture(); const outside = await fixture();
    await writeFile(join(outside, 'outside.ts'), 'export {};');
    await symlink(outside, join(root, 'linked'), 'junction');
    await expect(resolveInsideWorkspace(root, 'linked/outside.ts')).rejects.toThrow(/escapes/i);
  });

  it('redacts credentials and only accepts passive HTTPS live origins', () => {
    const output = sanitizeOutput('Authorization: Bearer abc.def.ghi\npassword=hunter2'); // secret-guard:allow
    expect(output).not.toContain('hunter2'); expect(output).not.toContain('abc.def.ghi');
    expect(safeLiveOrigin('https://example.com/path')).toBe('https://example.com');
    expect(() => safeLiveOrigin('http://example.com')).toThrow(/HTTPS/);
    expect(() => safeLiveOrigin('https://shop.example/checkout')).toThrow(/blocked/);
  });
});

describe('project adapters and reports', () => {
  it('composes Vite, Electron, Worker, and PWA detection from trusted files', async () => {
    const root = await fixture(); await mkdir(join(root, 'public')); await mkdir(join(root, 'electron')); await mkdir(join(root, 'cloudflare'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'vite', test: 'vitest', ignored: 'echo no' }, dependencies: { react: '1', vite: '1', electron: '1', wrangler: '1', '@playwright/test': '1' } }));
    await writeFile(join(root, 'package-lock.json'), '{}'); await writeFile(join(root, 'public', 'manifest.json'), '{}');
    const info = await detectProject(root, true, true);
    expect(info.types).toEqual(expect.arrayContaining(['vite-react', 'electron', 'cloudflare-worker', 'pwa']));
    expect(info.packageManager).toBe('npm'); expect(info.commands.map((item) => item.id)).toEqual(['script:dev', 'script:test']);
    expect(info.commands.every((item) => item.fingerprint.length === 64)).toBe(true);
    const oldFingerprint = info.commands[0]!.fingerprint;
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'vite --host 127.0.0.1', test: 'vitest', ignored: 'echo no' }, dependencies: { react: '1', vite: '1', electron: '1', wrangler: '1', '@playwright/test': '1' } }));
    expect((await detectProject(root, true, true)).commands[0]!.fingerprint).not.toBe(oldFingerprint);
  });

  it('detects WordPress, Android wrappers, and each JavaScript package manager', async () => {
    for (const [lock, expected] of [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun']] as const) {
      const root = await fixture(); await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'test' } })); await writeFile(join(root, lock), 'fixture');
      expect((await detectProject(root, true, true)).packageManager).toBe(expected);
    }
    const hybrid = await fixture(); await mkdir(join(hybrid, 'wp-content')); await writeFile(join(hybrid, 'gradlew.bat'), '@echo off');
    const info = await detectProject(hybrid, true, true);
    expect(info.types).toEqual(expect.arrayContaining(['wordpress', 'android']));
    expect(info.commands.some((item) => item.source === 'gradle' && item.executable.endsWith('gradlew.bat'))).toBe(true);
    expect(info.guidance.some((item) => item.includes('ADB'))).toBe(true);
    const missingWrapper = await fixture(); await writeFile(join(missingWrapper, 'build.gradle'), 'plugins {}');
    expect((await detectProject(missingWrapper, true, true)).guidance.some((item) => item.includes('Gradle wrapper'))).toBe(true);
  });

  it('keeps bounded local reports and supports deletion', async () => {
    const root = await fixture(); const store = new ReportStore(root, () => ({ days: 30, max: 1 }));
    const one = ReportStore.skipped('project-one', 'quick', 'One', 'Skipped');
    await store.save(one); await new Promise((resolve) => setTimeout(resolve, 5));
    const two = ReportStore.skipped('project-one', 'quick', 'Two', 'Skipped'); await store.save(two);
    const reports = await store.list(); expect(reports).toHaveLength(1); expect(reports[0].id).toBe(two.id);
    await mkdir(store.artifactRoot(two.id), { recursive: true }); await writeFile(join(store.artifactRoot(two.id), 'evidence.txt'), 'fixture');
    await store.delete(two.id); await expect(access(store.artifactRoot(two.id))).rejects.toThrow();
    await store.save(ReportStore.skipped('project-one', 'quick', 'Three', 'Skipped'));
    await store.clear(); expect(await store.list()).toEqual([]);
  });
});
