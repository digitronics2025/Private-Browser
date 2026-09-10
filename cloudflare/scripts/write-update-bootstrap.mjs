import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const endpointValue = process.env.PRIVATE_BROWSER_DOWNLOAD_URL?.trim();
const accessToken = process.env.PRIVATE_BROWSER_DOWNLOAD_TOKEN?.trim();
const outputPath = process.env.PRIVATE_BROWSER_BOOTSTRAP_OUTPUT
  ? resolve(process.env.PRIVATE_BROWSER_BOOTSTRAP_OUTPUT)
  : fileURLToPath(new URL('../../build/private-browser-update.json', import.meta.url));

if (!endpointValue && !accessToken) {
  process.stdout.write('Private update bootstrap is not configured; the installer will use manual setup.\n');
  process.exit(0);
}
if (!endpointValue || !accessToken) throw new Error('Both private update bootstrap values must be configured');

const endpoint = new URL(endpointValue);
if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
  throw new Error('PRIVATE_BROWSER_DOWNLOAD_URL must be a public HTTPS origin');
}
if (accessToken.length < 32 || accessToken.length > 1_000) throw new Error('PRIVATE_BROWSER_DOWNLOAD_TOKEN has an invalid length');

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify({ version: 1, endpoint: endpoint.origin, accessToken })}\n`, { mode: 0o600 });
process.stdout.write('Prepared the private update bootstrap (credential omitted).\n');
