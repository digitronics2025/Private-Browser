import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const playwrightCli = join(process.cwd(), 'node_modules', 'playwright', 'cli.js');
const playwrightArgs = [playwrightCli, 'test', '--config', 'playwright.electron.config.ts'];
const executable = process.platform === 'linux' ? 'xvfb-run' : process.execPath;
const args = process.platform === 'linux' ? ['-a', process.execPath, ...playwrightArgs] : playwrightArgs;
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(executable, args, { cwd: process.cwd(), env, stdio: 'inherit', shell: false });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
