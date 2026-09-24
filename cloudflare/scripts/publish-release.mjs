import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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
const sha256 = createHash('sha256').update(bytes).digest('hex');
// The build job recorded the installer's hash before handing it over. Publishing
// a file that differs from what was built — altered in the artifact or on this
// runner — is refused (F-55).
const sums = join(dirname(installerPath), 'SHA256SUMS.txt');
if (!existsSync(sums)) throw new Error('SHA256SUMS.txt from the build job is missing');
const built = readFileSync(sums, 'utf8').replace(/^﻿/, '').trim().split(/\s+/)[0]?.toLowerCase();
if (built !== sha256) throw new Error(`Installer hash ${sha256} does not match the build job's ${built}`);
const metadata = {
  id: `stable-${packageJson.version}-${buildNumber}`,
  version: packageJson.version,
  buildNumber,
  channel: 'stable',
  objectKey,
  filename: basename(installerPath),
  contentType: 'application/vnd.microsoft.portable-executable',
  sizeBytes: statSync(installerPath).size,
  sha256,
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
