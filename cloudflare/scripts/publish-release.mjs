import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { requireHttpsEndpoint } from './require-https-endpoint.mjs';

const [installerPath, objectKey] = process.argv.slice(2);
const endpoint = requireHttpsEndpoint(process.env.PRIVATE_BROWSER_DOWNLOAD_URL);
const adminKey = process.env.PRIVATE_BROWSER_ADMIN_API_KEY;
const commitSha = process.env.GITHUB_SHA;
const buildNumber = Number(process.env.GITHUB_RUN_NUMBER);
if (!installerPath || !objectKey || !endpoint || !adminKey || !commitSha || !Number.isSafeInteger(buildNumber)) {
  throw new Error('Release publisher is missing an argument or environment variable');
}
const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const bytes = readFileSync(installerPath);
const metadata = {
  id: `stable-${packageJson.version}-${buildNumber}`,
  version: packageJson.version,
  buildNumber,
  channel: 'stable',
  objectKey,
  filename: basename(installerPath),
  contentType: 'application/vnd.microsoft.portable-executable',
  sizeBytes: statSync(installerPath).size,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  commitSha,
  releaseNotes: `Private Browser ${packageJson.version} stable release.`,
  publishedAt: new Date().toISOString(),
};
const response = await fetch(`${endpoint}/api/v1/admin/releases`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': adminKey },
  body: JSON.stringify(metadata),
  redirect: 'error',
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`Release registration failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
process.stdout.write(`${JSON.stringify(await response.json())}\n`);
