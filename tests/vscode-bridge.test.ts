import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(Buffer.from(value, 'utf8').map((byte) => byte ^ 0x2a)),
    decryptString: (value: Buffer) => Buffer.from(value.map((byte) => byte ^ 0x2a)).toString('utf8'),
  },
}));

import {
  FrameDecoder,
  PROTOCOL_VERSION,
  deriveSessionKey,
  encodeFrame,
  generateEphemeralKeyPair,
  generateIdentity,
  helloTranscript,
  openMessage,
  sealMessage,
  signText,
  welcomeSchema,
} from '@private-browser/bridge-protocol';
import { VscodeBridgeServer } from '../electron/vscode-bridge';

const servers: VscodeBridgeServer[] = [];
afterEach(async () => { vi.useRealTimers(); while (servers.length) await servers.pop()!.close(); });

async function startServer() {
  const root = mkdtempSync(join(tmpdir(), 'pb-bridge-'));
  const rendezvousPath = join(root, 'rendezvous.json');
  const server = new VscodeBridgeServer(join(root, 'bridge.enc'), rendezvousPath, '9.9.9', () => undefined);
  await server.start();
  servers.push(server);
  const rendezvous = JSON.parse(readFileSync(rendezvousPath, 'utf8')) as { pipePath: string; challenge: string };
  return { server, rendezvous };
}

const device = { identity: generateIdentity(), deviceId: randomUUID() };

/** A minimal VS Code side: hello, welcome, then sealed frames. */
async function client(rendezvous: { pipePath: string; challenge: string }, options: { instanceId: string; pairingCode?: string }) {
  const ephemeral = generateEphemeralKeyPair();
  const unsigned = {
    kind: 'hello' as const, minVersion: PROTOCOL_VERSION, maxVersion: PROTOCOL_VERSION, deviceId: device.deviceId, instanceId: options.instanceId,
    vscodeVersion: '1.95.0', extensionVersion: '0.6.0', identityPublicKey: device.identity.publicKey, ephemeralPublicKey: ephemeral.publicKey,
    challenge: rendezvous.challenge, ...(options.pairingCode ? { pairingCode: options.pairingCode } : {}),
  };
  const hello = { ...unsigned, signature: signText(device.identity.privateKey, helloTranscript(unsigned)) };
  const socket: Socket = connect(rendezvous.pipePath);
  const decoder = new FrameDecoder();
  const frames: unknown[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  socket.on('data', (chunk) => { for (const frame of decoder.push(chunk)) { frames.push(frame); waiters.splice(0).forEach((wake) => wake()); } });
  socket.on('close', () => { closed = true; waiters.splice(0).forEach((wake) => wake()); });
  socket.on('error', () => undefined);
  const next = async (): Promise<unknown> => {
    while (!frames.length && !closed) await new Promise<void>((resolve) => waiters.push(resolve));
    return frames.shift();
  };
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  socket.write(encodeFrame(hello));
  const first = await next();
  if (!first) return { accepted: false as const, socket };
  const welcome = welcomeSchema.parse(first);
  const key = deriveSessionKey({ privateKey: ephemeral.privateKey, peerPublicKey: welcome.ephemeralPublicKey, challenge: rendezvous.challenge, pairingCode: options.pairingCode });
  let outgoing = 0;
  let incoming = 0;
  return {
    accepted: true as const,
    socket,
    closed: () => closed,
    send: (message: Parameters<typeof sealMessage>[3]) => socket.write(encodeFrame(sealMessage(key, welcome.sessionId, outgoing++, message))),
    receive: async () => openMessage(key, await next(), welcome.sessionId, incoming++),
  };
}

async function paired() {
  const { server, rendezvous } = await startServer();
  const code = server.beginPairing().pairingCode!;
  const instanceId = randomUUID();
  const window = await client(rendezvous, { instanceId, pairingCode: code });
  expect(window.accepted).toBe(true);
  return { server, rendezvous, window, instanceId };
}

describe('VS Code bridge sessions', () => {
  // F-72: two windows used to take the session from each other every 5 s.
  it('refuses a second window while the first is live, but lets the same window reconnect', async () => {
    const { server, rendezvous, window, instanceId } = await paired();
    const other = await client(rendezvous, { instanceId: randomUUID() });
    expect(other.accepted).toBe(false);
    expect(server.status()).toMatchObject({ state: 'connected', instanceId });
    if (!window.accepted) throw new Error('unreachable');
    expect(window.closed()).toBe(false);
    const again = await client(rendezvous, { instanceId });
    expect(again.accepted).toBe(true);
    expect(server.status()).toMatchObject({ state: 'connected', instanceId });
  });

  // F-72: a slow answer to a request the browser gave up on used to be treated
  // as a replay and tear the session down.
  it('drops a late response quietly and keeps the session', async () => {
    const { server, window } = await paired();
    if (!window.accepted) throw new Error('unreachable');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const request = server.request('reports.list', {});
    request.catch(() => undefined);
    const incoming = await window.receive();
    expect(incoming).toMatchObject({ kind: 'request', method: 'reports.list' });
    vi.advanceTimersByTime(31_000);
    await expect(request).rejects.toThrow('timed out');
    vi.useRealTimers();
    window.send({ version: PROTOCOL_VERSION, kind: 'response', id: (incoming as { id: string }).id, ok: true, payload: [] });
    // A second request still round-trips on the same session.
    const second = server.request('reports.list', {});
    const next = await window.receive();
    window.send({ version: PROTOCOL_VERSION, kind: 'response', id: (next as { id: string }).id, ok: true, payload: ['ok'] });
    await expect(second).resolves.toEqual(['ok']);
    expect(server.status().state).toBe('connected');
  });
});
