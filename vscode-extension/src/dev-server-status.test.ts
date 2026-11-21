import { once } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { devServerStatusSchema, localDevelopmentAddress } from '@private-browser/bridge-protocol';
import { developmentPort, isDevelopmentPortListening, matchesPortConflict, reportedDevelopmentAddress } from './dev-server-status.js';

describe('development server readiness', () => {
  it('recognizes a reported loopback URL and excludes other services and credentials', () => {
    expect(reportedDevelopmentAddress('Docs https://vite.dev\nLocal: http://127.0.0.1:5174/\n')?.href)
      .toBe('http://127.0.0.1:5174/');
    expect(reportedDevelopmentAddress('http://127.0.0.1:5174/?token=fixture')).toBeUndefined();
    const authenticated = new URL('http://localhost:5174/');
    authenticated.username = 'fixture';
    authenticated.password = 'test-case';
    expect(reportedDevelopmentAddress(authenticated.href)).toBeUndefined();
    expect(reportedDevelopmentAddress('http://localhost.preview.example:5174/')).toBeUndefined();
    expect(matchesPortConflict('Port 5173 is already in use')).toBe(true);
    expect(matchesPortConflict('Error: listen EADDRINUSE: address already in use 127.0.0.1:3000')).toBe(true);
    expect(matchesPortConflict('Listening on 5174')).toBe(false);
  });

  it('verifies the exact reported port against a real loopback server', async () => {
    const server = createServer((socket) => socket.end());
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    const local = localDevelopmentAddress(`http://127.0.0.1:${port}/`)!;
    try {
      expect(developmentPort(local)).toBe(port);
      await expect(isDevelopmentPortListening(local)).resolves.toBe(true);
      expect(devServerStatusSchema.safeParse({ phase: 'ready', port, address: local.href }).success).toBe(true);
      expect(devServerStatusSchema.safeParse({ phase: 'ready', port: 1, address: local.href }).success).toBe(false);
    } finally {
      const closed = once(server, 'close');
      server.close();
      await closed;
    }
    await expect(isDevelopmentPortListening(local)).resolves.toBe(false);
  });
});
