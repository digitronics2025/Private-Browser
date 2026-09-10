import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The shipped Content-Security-Policy in index.html is the production one.
 * The dev server needs to reach Vite's websocket and HMR endpoint on localhost,
 * so those exceptions are injected only while serving — previously they were
 * written into index.html and therefore shipped inside the installer, granting
 * the trusted chrome permission to open connections to any local port.
 */
const devCspExceptions = () => ({
  name: 'dev-csp-exceptions',
  apply: 'serve' as const,
  transformIndexHtml(html: string) {
    return html.replace("connect-src 'self';", "connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*;");
  },
});

export default defineConfig({
  plugins: [react(), devCspExceptions()],
  base: './',
  build: {
    sourcemap: false,
    outDir: 'dist',
  },
});
