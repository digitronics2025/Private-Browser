import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { requireHttpsEndpoint } from './require-https-endpoint.mjs';

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseStableVersion(value, label) {
  const match = STABLE_VERSION.exec(value);
  if (!match) throw new Error(`${label} must be a stable x.y.z version`);
  return {
    text: value,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  return 0;
}

function writeVersion(path, version) {
  const document = JSON.parse(readFileSync(path, 'utf8'));
  document.version = version;
  if (document.packages?.['']) document.packages[''].version = version;
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
}

/**
 * The version the service currently offers, or undefined when there is none to
 * compare with: publishing is not configured (a fork, a first setup) or nothing
 * has been published yet. Then the declared version is used as it is, so the
 * build still produces an installer (F-56). Any other failure stops the build —
 * guessing a version could publish one that reaches nobody.
 */
async function activeVersion() {
  if (!process.env.PRIVATE_BROWSER_DOWNLOAD_URL) return undefined;
  const endpoint = requireHttpsEndpoint(process.env.PRIVATE_BROWSER_DOWNLOAD_URL);
  const response = await fetch(`${endpoint}/api/v1/releases/public/latest`, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Cannot read the active release (${response.status})`);
  return (await response.json()).version;
}

const activeText = await activeVersion();
const packagePath = resolve('package.json');
const packageLockPath = resolve('package-lock.json');
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
const declared = parseStableVersion(packageJson.version, 'package.json version');
const active = activeText === undefined ? undefined : parseStableVersion(activeText, 'active release version');

let selected = declared.text;
if (active && compareVersions(declared, active) <= 0) {
  if (!Number.isSafeInteger(active.patch + 1)) {
    throw new Error('Active release patch number cannot be incremented safely');
  }
  selected = `${active.major}.${active.minor}.${active.patch + 1}`;
}

writeVersion(packagePath, selected);
writeVersion(packageLockPath, selected);
process.stdout.write(selected);
