import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { requireHttpsEndpoint } from '../../cloudflare/scripts/require-https-endpoint.mjs';

const gh = promisify(execFile);
const requestOptions = () => ({ redirect: 'error', signal: AbortSignal.timeout(15_000) });
const stableVersion = /^\d+\.\d+\.\d+$/;

export async function probePublicRelease(endpoint, request = fetch, now = Date.now()) {
  const origin = requireHttpsEndpoint(endpoint);
  const [latest, status] = await Promise.all([
    request(origin + '/api/v1/releases/public/latest', requestOptions()),
    request(origin + '/health', requestOptions()),
  ]);
  if (!latest.ok || !status.ok) throw new Error('The public manifest or health endpoint did not respond successfully.');
  const [manifest, health] = await Promise.all([latest.json(), status.json()]);
  const published = Date.parse(manifest.publishedAt);
  if (typeof manifest.version !== 'string' || !stableVersion.test(manifest.version) || !Number.isFinite(published)
    || !Number.isSafeInteger(manifest.buildNumber) || manifest.buildNumber < 1
    || !Number.isSafeInteger(manifest.sizeBytes) || manifest.sizeBytes < 2
    || typeof manifest.commitSha !== 'string' || !/^[a-f0-9]{40}$/i.test(manifest.commitSha)) {
    throw new Error('The public release manifest is invalid.');
  }
  const binary = new URL(manifest.downloadUrl);
  if (binary.origin !== origin || binary.pathname !== '/download/latest.exe' || binary.username || binary.password || binary.hash) {
    throw new Error('The installer location does not match the download service.');
  }
  const range = await request(binary, { ...requestOptions(), headers: { range: 'bytes=0-1' } });
  const rangeAvailable = range.status === 206
    && range.headers.get('content-range') === `bytes 0-1/${manifest.sizeBytes}`
    && range.headers.get('content-length') === '2'
    && (await range.text()) === 'MZ';
  await range.body?.cancel().catch(() => undefined);
  return {
    version: manifest.version,
    build: manifest.buildNumber,
    commit: manifest.commitSha,
    manifestAgeHours: Math.max(0, Math.round((now - published) / 360_000) / 10),
    publishedAt: new Date(published).toISOString(),
    releaseReady: health.status === 'ok' && health.releaseReady === true,
    rangeAvailable,
  };
}

async function githubStatus(workflow, options, repo) {
  try {
    const { stdout } = await gh('gh', ['run', 'list', '--repo', repo, '--workflow', workflow, ...options,
      '--limit', '1', '--json', 'status,conclusion,url'], { timeout: 20_000, windowsHide: true });
    const [run] = JSON.parse(stdout);
    if (!run) return 'No recorded runs';
    const status = run.conclusion || run.status;
    const label = typeof status === 'string' && /^[a-z_]+$/.test(status) ? status.replaceAll('_', ' ') : 'unknown';
    return typeof run.url === 'string' && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+$/.test(run.url)
      ? `[${label}](${run.url})` : label;
  } catch {
    return 'Unavailable';
  }
}

async function probeReleaseStatus(endpoint) {
  const origin = requireHttpsEndpoint(endpoint);
  const distribution = await fetch(origin + '/api/v1/distribution', requestOptions());
  if (distribution.status === 404) return probePublicRelease(origin);
  if (!distribution.ok) throw new Error('Could not determine download distribution mode.');
  const { mode } = await distribution.json();
  if (mode === 'public') return probePublicRelease(origin);
  if (mode !== 'private') throw new Error('Unknown download distribution mode.');
  const readiness = await fetch(origin + '/health', requestOptions());
  return { private: true, releaseReady: readiness.ok && (await readiness.json()).releaseReady === true };
}

async function report() {
  const repo = process.env.GITHUB_REPOSITORY || 'digitronics2025/Private-Browser';
  const mainPush = ['--branch', 'main', '--event', 'push'];
  const [app, appFailure, result] = await Promise.all([
    githubStatus('ci.yml', mainPush, repo),
    githubStatus('ci.yml', [...mainPush, '--status', 'failure'], repo),
    probeReleaseStatus(process.env.PRIVATE_BROWSER_DOWNLOAD_URL).catch(() => undefined),
  ]);
  const lines = ['## Private Browser release status', ''];
  if (result?.private) {
    lines.push(`- Private stable release **${result.releaseReady ? 'ready' : 'unavailable'}**`,
      '- Installer delivery is verified by the authenticated production release job.');
  } else if (result) {
    const { version, build, commit, manifestAgeHours, publishedAt, releaseReady, rangeAvailable } = result;
    lines.push(
      `- Active installer **${version}** (build ${build}, revision \`${commit.slice(0, 12)}\`)`,
      `- Manifest published ${manifestAgeHours} hours ago (${publishedAt})`,
      `- Download service **${releaseReady ? 'healthy' : 'unavailable'}**`,
      `- Active installer range request **${rangeAvailable ? 'passed' : 'failed'}**`,
    );
  } else lines.push('- Public manifest and installer probe **unavailable**');
  lines.push(`- Latest main installer workflow ${app}`, `- Last failed main installer workflow ${appFailure}`,
    '');
  const summary = lines.join('\n');
  process.stdout.write(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (!result?.releaseReady || (!result.private && !result.rangeAvailable)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await report();
