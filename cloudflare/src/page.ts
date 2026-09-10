import type { ReleaseRecord } from './protocol';

export function renderDownloadPage(release: ReleaseRecord, downloadUrl: string): string {
  const size = `${(release.size_bytes / 1024 / 1024).toFixed(1)} MB`;
  const commit = release.commit_sha.slice(0, 7);
  const notes = escapeHtml(release.release_notes || 'Latest stable Private Browser release for Windows.');
  const published = formatPublished(release.published_at);
  const sourceUrl = `https://github.com/digitronics2025/Private-Browser/commit/${encodeURIComponent(release.commit_sha)}`;
  const historyUrl = 'https://github.com/digitronics2025/Private-Browser/actions/workflows/ci.yml';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>Install Private Browser</title><style>
  :root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;background:#0b0e12;color:#f3f5f8}*{box-sizing:border-box}body{min-height:100vh;margin:0;padding:38px 20px 64px;background:#0b0e12}.card{width:min(768px,100%);margin:0 auto;border:1px solid #2a3039;border-radius:26px;background:#181c22;box-shadow:0 28px 90px #0008;padding:38px}.brand{display:flex;align-items:center;gap:13px}.logo{width:46px;height:46px;display:grid;place-items:center;border-radius:14px;background:linear-gradient(135deg,#5788ff,#6b5dff);box-shadow:0 10px 32px #527cff35;font-size:22px}.brand h1{font-size:34px;letter-spacing:-.035em;margin:0}.subtitle{margin:14px 0 38px;color:#a7b2c3;font-size:19px}.eyebrow{color:#a8b5ca;text-transform:uppercase;letter-spacing:.16em;font-size:13px}.build{font-size:68px;line-height:1;margin:10px 0 18px;font-weight:400}.instructions{color:#a7b2c3;line-height:1.6;font-size:17px;margin:0 0 28px}.instructions strong{color:#d5dbe5}.details{display:grid;gap:0;margin-bottom:30px}.row{display:grid;grid-template-columns:140px 1fr;gap:20px;padding:10px 0;color:#a7b2c3;font-size:17px}.row span:last-child{text-align:right;color:#eef1f6;overflow-wrap:anywhere}.row a{color:#9ab8ff;text-decoration:none}.row a:hover,.history:hover{text-decoration:underline}.download{display:flex;justify-content:center;align-items:center;width:100%;padding:20px;border-radius:16px;background:#5b89f8;color:#08101f;text-decoration:none;font-weight:750;font-size:21px;margin:22px 0 20px;transition:background .15s,transform .15s}.download:hover{background:#79a0ff;transform:translateY(-1px)}.history{display:block;text-align:center;color:#5f91ff;font-size:16px;margin:0 auto 30px}.checksum{border:1px solid #343b47;border-radius:14px;background:#12161b;padding:16px}.checksum small{display:block;color:#7d899b;text-transform:uppercase;letter-spacing:.12em;font-size:10px}.checksum code{display:block;margin-top:8px;color:#aeb8c8;font-size:11px;overflow-wrap:anywhere}.notice{margin:18px 0 0;text-align:center;color:#7d899b;font-size:12px;line-height:1.6}@media(max-width:600px){body{padding:18px 12px 40px}.card{padding:26px 22px;border-radius:20px}.brand h1{font-size:27px}.subtitle{font-size:16px}.row{grid-template-columns:92px 1fr;font-size:14px}.download{font-size:18px}.build{font-size:58px}}</style></head><body><main class="card"><div class="brand"><span class="logo">◆</span><h1>Private Browser</h1></div><p class="subtitle">Private Windows build. Not for sharing.</p><div class="eyebrow">Build number</div><div class="build">${release.build_number}</div><p class="instructions">Open Windows <strong>Settings → Apps → Installed apps → Private Browser</strong> to compare the installed version with the build below.</p><section class="details"><div class="row"><span>Version</span><span>${escapeHtml(release.version)}</span></div><div class="row"><span>Size</span><span>${size}</span></div><div class="row"><span>Published</span><span>${escapeHtml(published)}</span></div><div class="row"><span>Source</span><span><a href="${sourceUrl}" rel="nofollow noopener">${escapeHtml(commit)}</a></span></div><div class="row"><span>Change</span><span>${notes}</span></div></section><a class="download" href="${escapeHtml(downloadUrl)}" rel="nofollow">Download and install</a><a class="history" href="${historyUrl}" rel="nofollow noopener">Open build history</a><div class="checksum"><small>SHA-256</small><code>${escapeHtml(release.sha256)}</code></div><p class="notice">Private download · Windows 10/11 x64 · The installer link is refreshed whenever this page loads.</p></main></body></html>`;
}

function formatPublished(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  const relative = seconds < 60 ? 'just now'
    : seconds < 3600 ? `${Math.floor(seconds / 60)} minute${seconds < 120 ? '' : 's'} ago`
      : seconds < 86400 ? `${Math.floor(seconds / 3600)} hour${seconds < 7200 ? '' : 's'} ago`
        : `${Math.floor(seconds / 86400)} day${seconds < 172800 ? '' : 's'} ago`;
  return `${relative} · ${date.toISOString().replace('T', ' ').replace('.000Z', ' UTC')}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
