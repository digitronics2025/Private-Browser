import { spawnSync } from 'node:child_process';

const hasDesktopSession = process.platform === 'win32'
  || Boolean(process.env.DISPLAY)
  || Boolean(process.env.WAYLAND_DISPLAY);

if (!hasDesktopSession) {
  console.log('Skipping real Electron tests: this runner has no desktop display. The Windows CI job runs the same suite.');
  process.exit(0);
}

const result = spawnSync(process.execPath, ['scripts/run-electron-tests.mjs'], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
