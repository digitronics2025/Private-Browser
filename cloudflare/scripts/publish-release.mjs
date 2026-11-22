import { readFileSync } from 'node:fs';
import { requireProductionReleaseEndpoint } from './require-https-endpoint.mjs';
import { desktopReleaseNotes } from './desktop-release-notes.mjs';
import { verifyReleaseCandidate } from './verify-release-candidate.mjs';

const [installerPath, objectKey] = process.argv.slice(2);
const endpoint = requireProductionReleaseEndpoint(process.env.PRIVATE_BROWSER_DOWNLOAD_URL);
const releaseKey = process.env.PRIVATE_BROWSER_RELEASE_AUTOMATION_KEY;
const commitSha = process.env.GITHUB_SHA;
const buildNumber = Number(process.env.GITHUB_RUN_NUMBER);
if (!installerPath || !objectKey || !endpoint || !releaseKey || !commitSha || !Number.isSafeInteger(buildNumber)) {
  throw new Error('Release publisher is missing an argument or environment variable');
}
const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const installer = await verifyReleaseCandidate(installerPath);
const metadata = {
  id: `stable-${packageJson.version}-${buildNumber}`,
  version: packageJson.version,
  buildNumber,
  channel: 'stable',
  objectKey,
  contentType: 'application/vnd.microsoft.portable-executable',
  ...installer,
  commitSha,
  releaseNotes: desktopReleaseNotes(commitSha, process.env.PREVIOUS_RELEASE_REVISION),
  publishedAt: new Date().toISOString(),
};
const response = await fetch(`${endpoint}/api/v1/admin/releases`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': releaseKey },
  body: JSON.stringify(metadata),
  redirect: 'error',
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`Release registration failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
process.stdout.write(`${JSON.stringify(await response.json())}\n`);
