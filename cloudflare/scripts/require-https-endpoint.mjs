/**
 * Validate a release-service endpoint before any credential is sent to it.
 *
 * `PRIVATE_BROWSER_DOWNLOAD_URL` is a GitHub *variable*, not a secret: it is
 * unmasked in logs and edited through a weaker part of the settings UI than the
 * admin key it addresses. Anyone who can change it could otherwise redirect the
 * administrator key to a host of their choosing, or downgrade the transport to
 * plain HTTP, just by editing a field.
 *
 * The desktop client already refuses anything but a bare public HTTPS origin
 * (`isSafeUpdateEndpoint` in electron/security.ts). The publishing scripts hold
 * a strictly more powerful credential and had no check at all, so they apply the
 * same rule here.
 */
export function requireHttpsEndpoint(value, variableName = 'PRIVATE_BROWSER_DOWNLOAD_URL') {
  const raw = value?.trim();
  if (!raw) throw new Error(`${variableName} is not set`);

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${variableName} is not a valid URL`);
  }

  if (url.protocol !== 'https:') throw new Error(`${variableName} must use https, refusing to send a credential over ${url.protocol}//`);
  if (url.username || url.password) throw new Error(`${variableName} must not embed credentials`);
  if (url.search || url.hash) throw new Error(`${variableName} must be a bare origin with no query string or fragment`);
  if (url.pathname !== '/' && url.pathname !== '') throw new Error(`${variableName} must be a bare origin with no path`);

  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '0.0.0.0' || host.endsWith('.local') || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) {
    throw new Error(`${variableName} must be a public host`);
  }

  return url.origin;
}
