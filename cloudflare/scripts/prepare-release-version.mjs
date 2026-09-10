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

const endpoint = requireHttpsEndpoint(process.env.PRIVATE_BROWSER_DOWNLOAD_URL);
const accessToken = process.env.PRIVATE_BROWSER_DOWNLOAD_TOKEN;
if (!accessToken || accessToken.length < 32) {
  throw new Error('PRIVATE_BROWSER_DOWNLOAD_TOKEN must contain at least 32 characters');
}

const response = await fetch(`${endpoint}/update.json`, {
  headers: {
    accept: 'application/json',
    authorization: `Bearer ${accessToken}`,
  },
  redirect: 'error',
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) {
  throw new Error(`Cannot read the active release (${response.status})`);
}

const manifest = await response.json();
const packagePath = resolve('package.json');
const packageLockPath = resolve('package-lock.json');
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
const declared = parseStableVersion(packageJson.version, 'package.json version');
const active = parseStableVersion(manifest.version, 'active release version');

let selected = declared.text;
if (compareVersions(declared, active) <= 0) {
  if (!Number.isSafeInteger(active.patch + 1)) {
    throw new Error('Active release patch number cannot be incremented safely');
  }
  selected = `${active.major}.${active.minor}.${active.patch + 1}`;
}

writeVersion(packagePath, selected);
writeVersion(packageLockPath, selected);
process.stdout.write(selected);
