import type { ReleaseRecord } from './protocol';

export interface DeveloperProfile {
  name: string;
  role: string;
  location: string;
  website: string;
}

export interface DownloadPageModel {
  release: ReleaseRecord;
  history: ReleaseRecord[];
  downloadUrl: string;
  canonicalUrl: string;
  renderedAt: string;
  developer: DeveloperProfile;
}

export const DEVELOPER_PROFILE: DeveloperProfile = {
  name: 'Dr. Badawi Abdalsalam',
  role: 'Software Architect',
  location: 'Casablanca, Morocco',
  website: 'https://dr-badawi-abdalsalam.com/',
};

export function renderDownloadPage(model: DownloadPageModel): string {
  const { release, history, developer } = model;
  const published = formatPublished(release.published_at, model.renderedAt);
  const notes = release.release_notes || `Private Browser ${release.version} stable release.`;
  const sourceUrl = sourceCommitUrl(release.commit_sha);
  const historyUrl = 'https://github.com/digitronics2025/Private-Browser/actions/workflows/ci.yml';
  const historyMarkup = history.length > 0
    ? history.map((item) => renderHistoryItem(item, model.renderedAt)).join('')
    : '<p class="history-empty">This is the first published stable release.</p>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="index,follow">
  <meta name="referrer" content="no-referrer">
  <meta name="description" content="Download the latest stable Private Browser installer for Windows and review verified release details.">
  <meta property="og:title" content="Download Private Browser for Windows">
  <meta property="og:description" content="The latest stable Private Browser release, delivered securely from the official cloud release service.">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${escapeHtml(model.canonicalUrl)}">
  <link rel="canonical" href="${escapeHtml(model.canonicalUrl)}">
  <link rel="icon" href="/favicon.ico" type="image/svg+xml">
  <title>Download Private Browser for Windows</title>
  <style>
    :root {
      color-scheme: dark;
      --background: oklch(0.16 0.025 265);
      --background-raised: oklch(0.205 0.03 264);
      --surface: oklch(0.235 0.027 264);
      --surface-soft: oklch(0.19 0.024 264);
      --foreground: oklch(0.97 0.006 260);
      --muted: oklch(0.75 0.028 260);
      --muted-strong: oklch(0.84 0.02 260);
      --primary: oklch(0.61 0.2 269);
      --primary-hover: oklch(0.67 0.18 266);
      --primary-soft: oklch(0.3 0.09 269);
      --border: oklch(0.34 0.035 264);
      --success: oklch(0.52 0.14 160);
      --focus: oklch(0.77 0.13 260);
      font-family: "IBM Plex Sans", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      font-feature-settings: "zero";
      background: var(--background);
      color: var(--foreground);
    }

    * { box-sizing: border-box; }
    html { background: var(--background); scroll-behavior: auto; }
    body { min-height: 100vh; margin: 0; background: var(--background); }
    a { color: inherit; }
    a:focus-visible { outline: 3px solid var(--focus); outline-offset: 4px; }

    .shell { width: min(1180px, calc(100% - 40px)); margin: 0 auto; }
    .topbar { display: flex; align-items: center; justify-content: space-between; min-height: 84px; }
    .brand { display: inline-flex; align-items: center; gap: 12px; text-decoration: none; font-weight: 700; letter-spacing: -0.02em; }
    .mark { width: 38px; height: 38px; display: grid; place-items: center; border-radius: 12px; background: var(--primary); color: white; box-shadow: 0 12px 32px oklch(0.2 0.08 269 / 0.5); }
    .mark::before { content: ""; width: 13px; height: 13px; border: 3px solid currentColor; border-radius: 4px; transform: rotate(45deg); }
    .top-link { color: var(--muted); font-size: 14px; text-underline-offset: 4px; }

    .hero { position: relative; display: grid; grid-template-columns: minmax(0, 1.12fr) minmax(330px, 0.88fr); gap: 72px; align-items: center; min-height: 650px; padding: 76px 0 92px; }
    .hero::before { content: ""; position: absolute; z-index: -1; width: 520px; height: 520px; left: -260px; top: 20px; border-radius: 50%; background: radial-gradient(circle, oklch(0.47 0.16 269 / 0.22), transparent 68%); pointer-events: none; }
    .eyebrow { display: inline-flex; align-items: center; gap: 9px; margin: 0 0 22px; color: var(--muted-strong); font-size: 12px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--success); box-shadow: 0 0 0 5px oklch(0.52 0.14 160 / 0.16); }
    h1 { max-width: 720px; margin: 0; font-size: clamp(44px, 6.2vw, 78px); line-height: 0.98; letter-spacing: -0.052em; }
    .lede { max-width: 650px; margin: 28px 0 0; color: var(--muted); font-size: clamp(18px, 2vw, 21px); line-height: 1.65; }
    .actions { display: flex; align-items: center; gap: 18px; margin-top: 34px; }
    .download { min-height: 58px; display: inline-flex; align-items: center; justify-content: center; gap: 11px; padding: 0 28px; border-radius: 12px; background: var(--primary); color: white; text-decoration: none; font-size: 17px; font-weight: 750; box-shadow: 0 16px 42px oklch(0.23 0.1 269 / 0.55); }
    .download span { font-size: 20px; }
    .requirements { color: var(--muted); font-size: 13px; line-height: 1.55; }
    .freshness { margin-top: 22px; color: var(--muted); font-size: 13px; }
    .freshness time { color: var(--muted-strong); }

    .release-card { position: relative; overflow: hidden; border: 1px solid var(--border); border-radius: 24px; background: linear-gradient(145deg, var(--surface), var(--surface-soft)); box-shadow: 0 30px 90px oklch(0.08 0.03 264 / 0.62); padding: 30px; }
    .release-card::after { content: ""; position: absolute; width: 220px; height: 220px; right: -110px; top: -130px; border-radius: 50%; background: var(--primary-soft); filter: blur(18px); opacity: 0.75; pointer-events: none; }
    .version-row { position: relative; z-index: 1; display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
    .version-label { color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; }
    .version { display: block; margin-top: 8px; font-size: 48px; line-height: 1; letter-spacing: -0.045em; }
    .build-pill { border-radius: 999px; background: var(--primary); color: white; padding: 8px 12px; font-size: 11px; font-weight: 750; white-space: nowrap; }
    .release-notes { position: relative; z-index: 1; min-height: 52px; margin: 26px 0; color: var(--muted-strong); line-height: 1.6; }
    .release-facts { position: relative; z-index: 1; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; overflow: hidden; border: 1px solid var(--border); border-radius: 14px; background: var(--border); }
    .fact { min-height: 74px; display: flex; flex-direction: column; justify-content: center; gap: 7px; background: var(--surface-soft); padding: 14px 16px; }
    .fact small { color: var(--muted); font-size: 10px; font-weight: 700; letter-spacing: 0.11em; text-transform: uppercase; }
    .fact strong, .fact a { overflow-wrap: anywhere; font-size: 13px; }
    .fact a { color: oklch(0.8 0.1 260); text-underline-offset: 3px; }

    .trust-strip { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; overflow: hidden; border: 1px solid var(--border); border-radius: 18px; background: var(--border); }
    .trust-item { display: flex; gap: 14px; align-items: flex-start; background: var(--background-raised); padding: 24px; }
    .trust-icon { flex: 0 0 auto; width: 34px; height: 34px; display: grid; place-items: center; border-radius: 10px; background: var(--primary-soft); color: white; font-weight: 800; }
    .trust-item strong { display: block; margin-bottom: 5px; font-size: 14px; }
    .trust-item p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.55; }

    section.content { padding: 100px 0; }
    .section-head { max-width: 680px; margin-bottom: 38px; }
    .section-head h2 { margin: 0; font-size: clamp(30px, 4vw, 44px); letter-spacing: -0.04em; }
    .section-head p { margin: 14px 0 0; color: var(--muted); line-height: 1.65; }
    .timeline { display: grid; gap: 1px; overflow: hidden; border: 1px solid var(--border); border-radius: 18px; background: var(--border); }
    .history-item { display: grid; grid-template-columns: 170px minmax(0, 1fr) auto; gap: 28px; align-items: center; background: var(--background-raised); padding: 24px 26px; }
    .history-version { font-size: 20px; font-weight: 750; letter-spacing: -0.025em; }
    .history-version small { display: block; margin-top: 5px; color: var(--muted); font-size: 11px; font-weight: 500; letter-spacing: 0; }
    .history-notes { color: var(--muted-strong); font-size: 14px; line-height: 1.55; }
    .history-time { color: var(--muted); font-size: 12px; text-align: right; white-space: nowrap; }
    .history-empty { margin: 0; background: var(--background-raised); color: var(--muted); padding: 28px; }
    .history-link { display: inline-block; margin-top: 20px; color: oklch(0.8 0.1 260); font-size: 14px; text-underline-offset: 4px; }

    .install-grid { display: grid; grid-template-columns: 0.9fr 1.1fr; gap: 36px; }
    .install-steps, .checksum { border: 1px solid var(--border); border-radius: 18px; background: var(--background-raised); padding: 30px; }
    .install-steps h2, .checksum h2 { margin: 0 0 22px; font-size: 22px; letter-spacing: -0.025em; }
    .install-steps ol { margin: 0; padding-left: 22px; color: var(--muted-strong); line-height: 1.8; }
    .checksum p { margin: 0 0 16px; color: var(--muted); font-size: 13px; line-height: 1.6; }
    .checksum code { display: block; overflow-wrap: anywhere; border-radius: 10px; background: var(--surface-soft); color: var(--muted-strong); padding: 16px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; line-height: 1.65; }

    .developer { display: flex; align-items: center; justify-content: space-between; gap: 32px; border: 1px solid var(--border); border-radius: 22px; background: linear-gradient(135deg, var(--background-raised), var(--surface-soft)); padding: 38px; }
    .developer-label { margin: 0 0 9px; color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: 0.13em; text-transform: uppercase; }
    .developer h2 { margin: 0; font-size: 28px; letter-spacing: -0.035em; }
    .developer-meta { margin: 9px 0 0; color: var(--muted); }
    .developer-link { flex: 0 0 auto; min-height: 48px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--border); border-radius: 10px; padding: 0 18px; color: var(--foreground); text-decoration: none; font-size: 14px; font-weight: 700; }
    footer { display: flex; justify-content: space-between; gap: 24px; border-top: 1px solid var(--border); padding: 34px 0 50px; color: var(--muted); font-size: 12px; }

    @media (prefers-reduced-motion: no-preference) {
      .download, .developer-link, .top-link { transition: transform 150ms ease-out, background 150ms ease-out, color 150ms ease-out, border-color 150ms ease-out; }
      .download:hover { transform: translateY(-2px); background: var(--primary-hover); }
      .developer-link:hover { transform: translateY(-1px); border-color: var(--primary); }
      .top-link:hover { color: var(--foreground); }
    }

    @media (max-width: 820px) {
      .hero { grid-template-columns: 1fr; gap: 48px; padding: 54px 0 76px; }
      .release-card { max-width: 620px; }
      .trust-strip { grid-template-columns: 1fr; }
      .history-item { grid-template-columns: 130px minmax(0, 1fr); }
      .history-time { grid-column: 2; text-align: left; }
      .install-grid { grid-template-columns: 1fr; }
    }

    @media (max-width: 560px) {
      .shell { width: min(100% - 28px, 1180px); }
      .topbar { min-height: 72px; }
      .top-link { display: none; }
      .hero { min-height: auto; padding-top: 42px; }
      h1 { font-size: clamp(40px, 13vw, 56px); }
      .actions { align-items: stretch; flex-direction: column; }
      .download { width: 100%; }
      .release-card { padding: 23px; border-radius: 20px; }
      .version { font-size: 42px; }
      .release-facts { grid-template-columns: 1fr; }
      section.content { padding: 76px 0; }
      .history-item { grid-template-columns: 1fr; gap: 10px; padding: 22px; }
      .history-time { grid-column: auto; text-align: left; }
      .developer { align-items: stretch; flex-direction: column; padding: 28px; }
      .developer-link { width: 100%; }
      footer { flex-direction: column; }
    }
  </style>
</head>
<body>
  <header class="shell topbar">
    <a class="brand" href="/" aria-label="Private Browser download home"><span class="mark" aria-hidden="true"></span><span>Private Browser</span></a>
    <a class="top-link" href="#release-history">Release history</a>
  </header>

  <main>
    <section class="shell hero" aria-labelledby="download-title">
      <div>
        <p class="eyebrow"><span class="status-dot" aria-hidden="true"></span>Latest stable release</p>
        <h1 id="download-title">Your work, separated and protected.</h1>
        <p class="lede">Download Private Browser for Windows — a workspace-first Chromium browser designed to keep accounts, sessions, and sensitive work in their proper place.</p>
        <div class="actions">
          <a class="download" href="${escapeHtml(model.downloadUrl)}" download="${escapeHtml(release.filename)}" aria-label="Download Private Browser ${escapeHtml(release.version)} for Windows"><span aria-hidden="true">↓</span> Download for Windows</a>
          <div class="requirements">Windows 10/11<br>x64 · ${escapeHtml(formatBytes(release.size_bytes))}</div>
        </div>
        <p class="freshness">Version ${escapeHtml(release.version)} · Updated <time datetime="${escapeHtml(release.published_at)}" title="${escapeHtml(published.utc)}">${escapeHtml(published.relative)}</time></p>
      </div>

      <aside class="release-card" aria-label="Current release details">
        <div class="version-row">
          <div><span class="version-label">Current version</span><strong class="version">${escapeHtml(release.version)}</strong></div>
          <span class="build-pill">Build ${release.build_number}</span>
        </div>
        <p class="release-notes">${escapeHtml(notes)}</p>
        <div class="release-facts">
          <div class="fact"><small>Published</small><strong>${escapeHtml(published.readable)}</strong></div>
          <div class="fact"><small>Channel</small><strong>Stable release</strong></div>
          <div class="fact"><small>Installer</small><strong>${escapeHtml(formatBytes(release.size_bytes))}</strong></div>
          <div class="fact"><small>Source</small><a href="${escapeHtml(sourceUrl)}" rel="noopener noreferrer">Commit ${escapeHtml(shortCommit(release.commit_sha))}</a></div>
        </div>
      </aside>
    </section>

    <div class="shell trust-strip" aria-label="Release assurances">
      <div class="trust-item"><span class="trust-icon" aria-hidden="true">1</span><div><strong>Official cloud release</strong><p>Served directly from the Private Browser release service.</p></div></div>
      <div class="trust-item"><span class="trust-icon" aria-hidden="true">2</span><div><strong>Short-lived download link</strong><p>A fresh signed installer URL is created whenever this page loads.</p></div></div>
      <div class="trust-item"><span class="trust-icon" aria-hidden="true">3</span><div><strong>Verifiable build</strong><p>Source revision and SHA-256 checksum are published below.</p></div></div>
    </div>

    <section class="shell content" id="release-history" aria-labelledby="history-title">
      <div class="section-head"><h2 id="history-title">Release history</h2><p>The five stable releases before the current version, ordered by publication time.</p></div>
      <div class="timeline">${historyMarkup}</div>
      <a class="history-link" href="${historyUrl}" rel="noopener noreferrer">View verified build history ↗</a>
    </section>

    <section class="shell content install-grid" aria-label="Installation and verification">
      <div class="install-steps"><h2>Install in three steps</h2><ol><li>Download the Windows installer.</li><li>Open ${escapeHtml(release.filename)}.</li><li>Follow the setup prompts and launch Private Browser.</li></ol></div>
      <div class="checksum"><h2>Verify the installer</h2><p>Compare the downloaded file with this SHA-256 checksum before running it.</p><code>${escapeHtml(release.sha256)}</code></div>
    </section>

    <section class="shell content" aria-labelledby="developer-title">
      <div class="developer">
        <div><p class="developer-label">Developer</p><h2 id="developer-title">${escapeHtml(developer.name)}</h2><p class="developer-meta">${escapeHtml(developer.role)} · ${escapeHtml(developer.location)}</p></div>
        <a class="developer-link" href="${escapeHtml(developer.website)}" rel="noopener noreferrer">View developer profile ↗</a>
      </div>
    </section>
  </main>

  <footer class="shell"><span>© ${new Date(model.renderedAt).getUTCFullYear()} Private Browser</span><span>Windows 10/11 x64 · Stable channel</span></footer>
</body>
</html>`;
}

function renderHistoryItem(release: ReleaseRecord, renderedAt: string): string {
  const published = formatPublished(release.published_at, renderedAt);
  const notes = release.release_notes || `Private Browser ${release.version} stable release.`;
  return `<article class="history-item"><div class="history-version">Version ${escapeHtml(release.version)}<small>Build ${release.build_number}</small></div><div class="history-notes">${escapeHtml(notes)}</div><time class="history-time" datetime="${escapeHtml(release.published_at)}" title="${escapeHtml(published.utc)}">${escapeHtml(published.readable)}</time></article>`;
}

function formatPublished(value: string, renderedAt: string): { readable: string; relative: string; utc: string } {
  const date = new Date(value);
  const now = new Date(renderedAt);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(now.getTime())) return { readable: value, relative: value, utc: value };
  const seconds = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));
  const relative = seconds < 60 ? 'just now'
    : seconds < 3600 ? `${Math.floor(seconds / 60)} minute${seconds < 120 ? '' : 's'} ago`
      : seconds < 86400 ? `${Math.floor(seconds / 3600)} hour${seconds < 7200 ? '' : 's'} ago`
        : `${Math.floor(seconds / 86400)} day${seconds < 172800 ? '' : 's'} ago`;
  const readable = new Intl.DateTimeFormat('en', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC', timeZoneName: 'short',
  }).format(date);
  return { readable, relative, utc: date.toISOString().replace('T', ' ').replace('.000Z', ' UTC') };
}

function formatBytes(value: number): string {
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function shortCommit(value: string): string {
  return value.slice(0, 12);
}

function sourceCommitUrl(commitSha: string): string {
  return `https://github.com/digitronics2025/Private-Browser/commit/${encodeURIComponent(commitSha)}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
