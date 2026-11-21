import { createConnection } from 'node:net';
import { localDevelopmentAddress } from '@private-browser/bridge-protocol';

export function reportedDevelopmentAddress(output: string): URL | undefined {
  const candidates = output.matchAll(/https?:\/\/[^\s"'<>]+/gi);
  for (const [candidate] of candidates) {
    const url = localDevelopmentAddress(candidate.replace(/[),.;]+$/, ''));
    if (url) return url;
  }
  return undefined;
}

export function developmentPort(address: URL): number {
  return Number(address.port || (address.protocol === 'https:' ? 443 : 80));
}

export function matchesPortConflict(output: string): boolean {
  return /\bEADDRINUSE\b|\bport\s+\d+\s+(?:is\s+)?(?:already\s+)?in use\b|address already in use/i.test(output);
}

export async function isDevelopmentPortListening(address: URL): Promise<boolean> {
  const safe = localDevelopmentAddress(address.toString());
  if (!safe) return false;
  const port = developmentPort(safe);
  if (safe.hostname === 'localhost') {
    return (await Promise.all([probePort('127.0.0.1', port), probePort('::1', port)])).some(Boolean);
  }
  return probePort(safe.hostname.replace(/^\[|\]$/g, ''), port);
}

function probePort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const complete = (listening: boolean) => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(450, () => complete(false));
    socket.once('error', () => complete(false));
    socket.once('connect', () => complete(true));
  });
}
