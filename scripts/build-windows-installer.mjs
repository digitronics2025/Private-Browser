import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const args = [require.resolve('electron-builder/cli.js'), '--win', 'nsis', '--x64', '--publish', 'never'];
const thumbprint = process.env.PRIVATE_BROWSER_WINDOWS_SIGNER_THUMBPRINT;
if (thumbprint) {
  if (!/^[a-f0-9]{40}$/i.test(thumbprint)) throw new Error('Invalid Windows certificate-store thumbprint.');
  args.push(`--config.win.signtoolOptions.certificateSha1=${thumbprint}`, '--config.forceCodeSigning=true');
}

const build = spawnSync(process.execPath, args, { stdio: 'inherit' });
if (build.error) throw build.error;
process.exitCode = build.status ?? 1;
