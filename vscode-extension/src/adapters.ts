import { access, readFile, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { CommandSpec, ProjectInfo, ProjectSummary } from '@private-browser/bridge-protocol';
import { stableFingerprint } from './security.js';

const exists = async (path: string) => access(path).then(() => true).catch(() => false);
const readConfiguration = async (path: string): Promise<string> => {
  try {
    const value = await readFile(path, 'utf8');
    return value.length <= 1024 * 1024 ? value : '[configuration-too-large]';
  } catch { return ''; }
};
const SCRIPT_NAME = /^[A-Za-z0-9:_-]{1,80}$/;
const hasExecutable = (name: string) => spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], { windowsHide: true, stdio: 'ignore', shell: false }).status === 0;

interface PackageFile { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; }

function makeCommand(root: string, packageManager: ProjectInfo['packageManager'], id: string, script: string, configurationDigest: string, category: CommandSpec['category']): CommandSpec {
  const manager = packageManager === 'unknown' || packageManager === 'gradle' ? 'npm' : packageManager;
  const executable = process.platform === 'win32' ? `${manager}.cmd` : manager;
  const args = ['run', id];
  const base = { id: `script:${id}`, label: id, executable, args, cwd: root, source: 'package.json' as const, category };
  return { ...base, fingerprint: stableFingerprint({ ...base, script, configurationDigest }) };
}

export async function detectProject(rootValue: string, authorized: boolean, trusted: boolean, activeFile?: string): Promise<ProjectInfo> {
  const root = await realpath(rootValue);
  const packagePath = join(root, 'package.json');
  let pkg: PackageFile = {};
  let packageConfiguration = '';
  if (await exists(packagePath)) {
    const raw = await readFile(packagePath, 'utf8');
    if (raw.length > 1024 * 1024) throw new Error('package.json is too large');
    packageConfiguration = raw;
    pkg = JSON.parse(raw) as PackageFile;
  }
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
  const types: ProjectInfo['types'] = [];
  if (dependencies.vite || await exists(join(root, 'vite.config.ts')) || await exists(join(root, 'vite.config.js'))) types.push(dependencies.react ? 'vite-react' : 'node');
  else if (await exists(packagePath)) types.push('node');
  if (dependencies.electron || await exists(join(root, 'electron'))) types.push('electron');
  if (dependencies.wrangler || await exists(join(root, 'wrangler.toml')) || await exists(join(root, 'wrangler.jsonc')) || await exists(join(root, 'cloudflare'))) types.push('cloudflare-worker');
  if (await exists(join(root, 'public', 'manifest.json')) || await exists(join(root, 'manifest.json'))) types.push('pwa');
  if (await exists(join(root, 'wp-content')) || await exists(join(root, 'wp-includes'))) types.push('wordpress');
  if (await exists(join(root, 'gradlew')) || await exists(join(root, 'gradlew.bat')) || await exists(join(root, 'build.gradle')) || await exists(join(root, 'build.gradle.kts'))) types.push('android');
  if (!types.length) types.push('node');

  const packageManager: ProjectInfo['packageManager'] = await exists(join(root, 'pnpm-lock.yaml')) ? 'pnpm'
    : await exists(join(root, 'yarn.lock')) ? 'yarn'
      : await exists(join(root, 'bun.lockb')) || await exists(join(root, 'bun.lock')) ? 'bun'
        : await exists(join(root, 'package-lock.json')) ? 'npm'
          : types.includes('android') ? 'gradle' : 'unknown';
  const categories: Record<string, CommandSpec['category']> = { dev: 'dev', start: 'dev', serve: 'dev', typecheck: 'typecheck', lint: 'lint', test: 'test', check: 'test', build: 'build', dist: 'package', package: 'package', 'secrets:check': 'security' };
  const configurationFiles = ['vite.config.ts', 'vite.config.js', 'wrangler.toml', 'wrangler.jsonc', 'build.gradle', 'build.gradle.kts', 'gradlew', 'gradlew.bat'];
  const configurationDigest = stableFingerprint([packageConfiguration, ...(await Promise.all(configurationFiles.map(async (name) => `${name}\n${await readConfiguration(join(root, name))}`)))].join('\n'));
  const commands = Object.entries(pkg.scripts ?? {}).filter(([name]) => SCRIPT_NAME.test(name) && categories[name]).map(([name, script]) => makeCommand(root, packageManager, name, script, configurationDigest, categories[name]));
  if (types.includes('android')) {
    const wrapper = await exists(join(root, 'gradlew.bat')) ? join(root, 'gradlew.bat') : join(root, 'gradlew');
    if (await exists(wrapper)) {
      const base = { id: 'gradle:test', label: 'Gradle tests', executable: wrapper, args: ['test'], cwd: root, source: 'gradle' as const, category: 'test' as const };
      commands.push({ ...base, fingerprint: stableFingerprint({ ...base, configurationDigest }) });
    }
  }
  const guidance: string[] = [];
  if (types.includes('cloudflare-worker')) {
    const localWrangler = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
    if (await exists(localWrangler)) {
      const base = { id: 'wrangler:dry-run', label: 'Wrangler dry-run', executable: localWrangler, args: ['deploy', '--dry-run'], cwd: root, source: 'wrangler' as const, category: 'build' as const };
      commands.push({ ...base, fingerprint: stableFingerprint({ ...base, configurationDigest }) });
    } else guidance.push('Install the project-pinned Wrangler package to enable Worker dry-run checks.');
  }
  const id = stableFingerprint(root).slice(0, 32);
  const project: ProjectSummary = { id, name: basename(root), path: root, trusted, authorized };
  if (types.includes('android') && !(await exists(join(root, 'gradlew.bat'))) && !(await exists(join(root, 'gradlew')))) guidance.push('Add the Gradle wrapper or install Gradle to run Android tests.');
  if (types.includes('android')) guidance.push(`ADB ${hasExecutable('adb') ? 'detected' : 'not found'}; Java ${hasExecutable('java') ? 'detected' : 'not found'}.`);
  if (!dependencies['@playwright/test']) guidance.push('Install @playwright/test and Chromium to enable isolated page tests.');
  return { project, types, framework: types.includes('vite-react') ? 'React / Vite' : types.includes('wordpress') ? 'WordPress / WooCommerce' : types.join(' + '), packageManager, commands, activeFile, guidance };
}
