import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { requireProductionReleaseEndpoint } from './require-https-endpoint.mjs';

export const releaseVerifyDevice = () => {
  const value = process.env.PRIVATE_BROWSER_RELEASE_VERIFY_DEVICE?.trim();
  if (value && !/^pbdev_[a-f0-9-]{36}_[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('Configure a valid CI release verification device.');
  return value;
};

/** @param {string} endpoint */
export async function readDistributionMode(endpoint) {
  const response = await fetch(`${endpoint}/api/v1/distribution`, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (response.status === 404) return 'public'; // Compatibility with the preceding Worker release.
  if (!response.ok) throw new Error(`Cannot read release distribution (${response.status})`);
  const value = (await response.json()).mode;
  if (value !== 'public' && value !== 'private') throw new Error('Unknown release distribution mode');
  return value;
}

export async function readActiveRelease() {
  if (!process.env.PRIVATE_BROWSER_DOWNLOAD_URL) return undefined;
  const endpoint = requireProductionReleaseEndpoint(process.env.PRIVATE_BROWSER_DOWNLOAD_URL);
  const mode = await readDistributionMode(endpoint);
  const device = mode === 'private' ? releaseVerifyDevice() : undefined;
  if (mode === 'private' && !device) throw new Error('The private release service requires the CI verification device.');
  const response = await fetch(`${endpoint}${device ? '/update.json' : '/api/v1/releases/public/latest'}`, {
    headers: { accept: 'application/json', ...(device ? { authorization: `Bearer ${device}` } : {}) },
    redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 404 && mode === 'public') return undefined;
  if (!response.ok) throw new Error(`Cannot read the active release (${response.status})`);
  const { version, buildNumber, commitSha, sha256 } = await response.json();
  return { version, buildNumber, commitSha, sha256 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await readActiveRelease();
  if (result) process.stdout.write(JSON.stringify(result));
}
