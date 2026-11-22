export function resolveChromeUrl(packaged: boolean, bundled: string, development?: string): string {
  if (packaged || !development) return bundled;
  const url = new URL(development);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Browser chrome development server must use a bare loopback HTTP(S) origin.');
  }
  return url.href;
}
