import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import * as vscode from 'vscode';
import {
  FrameDecoder,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  SESSION_TTL_MS,
  deriveSessionKey,
  encodeFrame,
  generateEphemeralKeyPair,
  generateIdentity,
  helloSchema,
  helloTranscript,
  openMessage,
  sanitizeError,
  sealMessage,
  signText,
  verifyText,
  welcomeSchema,
  welcomeTranscript,
  type BridgeEvent,
  type BridgeMethod,
  type BridgeRequest,
  type DeviceIdentity,
} from '@private-browser/bridge-protocol';

interface Rendezvous {
  schemaVersion: 1;
  pipePath: string;
  instanceId: string;
  challenge: string;
  browserVersion: string;
  browserIdentityPublicKey: string;
  minProtocolVersion: number;
  maxProtocolVersion: number;
  expiresAt: number;
}

type Handler = (method: BridgeMethod, payload: unknown) => Promise<unknown>;
type StatusListener = (state: 'disconnected' | 'connecting' | 'connected' | 'error', detail?: string) => void;

export class BridgeClient implements vscode.Disposable {
  private socket?: Socket;
  private decoder = new FrameDecoder();
  private key?: Buffer;
  private sessionId?: string;
  private incomingSequence = 0;
  private outgoingSequence = 0;
  private handshakeCode?: string;
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private disposed = false;
  private connecting = false;

  constructor(private readonly context: vscode.ExtensionContext, private readonly handler: Handler, private readonly onStatus: StatusListener) {}

  async start(): Promise<void> {
    await this.tryConnect();
    this.reconnectTimer = setInterval(() => { if (!this.socket && !this.connecting) void this.tryConnect(); }, 5_000);
    this.heartbeatTimer = setInterval(() => void this.notify('activity', { heartbeatAt: Date.now() }), 10_000);
  }

  async pair(code: string): Promise<void> {
    if (!/^\d{8}$/.test(code)) throw new Error('Enter the eight-digit code shown in Private Browser');
    await this.disconnect(false);
    this.handshakeCode = code;
    await this.tryConnect(code, true);
  }

  async reconnect(): Promise<void> { await this.disconnect(false); await this.tryConnect(undefined, true); }

  async disconnect(revoke: boolean): Promise<void> {
    if (revoke) {
      await this.context.secrets.delete('privateBrowser.identity');
      await this.context.secrets.delete('privateBrowser.browserPublicKey');
    }
    this.socket?.destroy(); this.socket = undefined; this.key = undefined; this.sessionId = undefined;
    this.onStatus('disconnected', revoke ? 'Pairing identity revoked' : undefined);
  }

  async notify(event: BridgeEvent['event'], payload: unknown): Promise<void> {
    if (!this.socket || !this.key || !this.sessionId) return;
    const message: BridgeEvent = { version: PROTOCOL_VERSION, kind: 'event', id: randomUUID(), event, payload };
    this.socket.write(encodeFrame(sealMessage(this.key, this.sessionId, this.outgoingSequence++, message)));
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearInterval(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.socket?.destroy();
  }

  private rendezvousPath(): string {
    if (process.env.PRIVATE_BROWSER_BRIDGE_RENDEZVOUS) return process.env.PRIVATE_BROWSER_BRIDGE_RENDEZVOUS;
    const base = process.env.LOCALAPPDATA;
    if (!base) throw new Error('LOCALAPPDATA is unavailable');
    return join(base, 'Private Browser Bridge', 'rendezvous.json');
  }

  private async identity(): Promise<DeviceIdentity & { deviceId: string }> {
    const stored = await this.context.secrets.get('privateBrowser.identity');
    if (stored) return JSON.parse(stored) as DeviceIdentity & { deviceId: string };
    const next = { ...generateIdentity(), deviceId: randomUUID() };
    await this.context.secrets.store('privateBrowser.identity', JSON.stringify(next));
    return next;
  }

  private async tryConnect(code?: string, throwOnFailure = false): Promise<void> {
    if (this.disposed || this.connecting || this.socket) return;
    this.connecting = true; this.onStatus('connecting');
    try {
      const rendezvous = JSON.parse(await readFile(this.rendezvousPath(), 'utf8')) as Rendezvous;
      const validEndpoint = process.platform === 'win32' ? rendezvous.pipePath.startsWith('\\\\.\\pipe\\') : rendezvous.pipePath.endsWith('.sock');
      if (rendezvous.schemaVersion !== 1 || !validEndpoint || !Number.isInteger(rendezvous.minProtocolVersion) || !Number.isInteger(rendezvous.maxProtocolVersion) || rendezvous.expiresAt < Date.now()) throw new Error('Private Browser pairing endpoint is unavailable or expired');
      if (rendezvous.minProtocolVersion > PROTOCOL_VERSION || rendezvous.maxProtocolVersion < MIN_PROTOCOL_VERSION) throw new Error('Protocol incompatible. Install Private Browser 0.4.0 and Private Browser Bridge 0.4.0 from the same release.');
      const trustedBrowserKey = await this.context.secrets.get('privateBrowser.browserPublicKey');
      if (!code && !trustedBrowserKey) throw new Error('Pair with Private Browser once before reconnecting');
      if (trustedBrowserKey && trustedBrowserKey !== rendezvous.browserIdentityPublicKey) throw new Error('Private Browser identity changed; revoke and pair again');
      const identity = await this.identity(); const ephemeral = generateEphemeralKeyPair();
      const unsigned = {
        kind: 'hello' as const, minVersion: MIN_PROTOCOL_VERSION, maxVersion: PROTOCOL_VERSION,
        deviceId: identity.deviceId, instanceId: randomUUID(), vscodeVersion: vscode.version,
        extensionVersion: this.context.extension.packageJSON.version as string, identityPublicKey: identity.publicKey,
        ephemeralPublicKey: ephemeral.publicKey, challenge: rendezvous.challenge, pairingCode: code,
      };
      const hello = helloSchema.parse({ ...unsigned, signature: signText(identity.privateKey, helloTranscript(unsigned)) });
      const socket = connect(rendezvous.pipePath); this.socket = socket; this.handshakeCode = code; this.decoder = new FrameDecoder();
      const timeout = setTimeout(() => socket.destroy(new Error('Private Browser handshake timed out')), 30_000);
      socket.once('connect', () => socket.write(encodeFrame(hello)));
      socket.on('data', (chunk) => void this.onData(chunk, hello, ephemeral.privateKey, rendezvous, timeout));
      socket.once('close', () => { clearTimeout(timeout); this.socket = undefined; this.key = undefined; this.sessionId = undefined; if (!this.disposed) this.onStatus('disconnected'); });
      socket.once('error', (error) => { clearTimeout(timeout); this.onStatus('error', error.message); });
    } catch (error) {
      this.socket = undefined; this.onStatus('disconnected', error instanceof Error ? error.message : String(error));
      if (throwOnFailure) throw error;
    } finally { this.connecting = false; }
  }

  private async onData(chunk: Buffer, hello: ReturnType<typeof helloSchema.parse>, privateKey: ReturnType<typeof generateEphemeralKeyPair>['privateKey'], rendezvous: Rendezvous, timeout: NodeJS.Timeout): Promise<void> {
    try {
      for (const frame of this.decoder.push(chunk)) {
        if (!this.key) {
          const welcome = welcomeSchema.parse(frame);
          if (welcome.expiresAt <= Date.now() || welcome.expiresAt > Date.now() + SESSION_TTL_MS + 5_000) throw new Error('Private Browser returned an invalid session expiry');
          if (welcome.browserIdentityPublicKey !== rendezvous.browserIdentityPublicKey) throw new Error('Private Browser identity mismatch');
          const { signature: _signature, ...unsignedWelcome } = welcome;
          if (!verifyText(welcome.browserIdentityPublicKey, welcomeTranscript(hello, unsignedWelcome), welcome.signature)) throw new Error('Private Browser handshake signature is invalid');
          this.key = deriveSessionKey({ privateKey, peerPublicKey: welcome.ephemeralPublicKey, challenge: hello.challenge, pairingCode: this.handshakeCode });
          this.sessionId = welcome.sessionId; this.incomingSequence = 0; this.outgoingSequence = 0;
          await this.context.secrets.store('privateBrowser.browserPublicKey', welcome.browserIdentityPublicKey);
          clearTimeout(timeout); this.handshakeCode = undefined;
          this.onStatus('connected', `Private Browser ${welcome.browserVersion}`);
          setTimeout(() => { if (this.sessionId === welcome.sessionId) void this.reconnect(); }, Math.min(SESSION_TTL_MS, welcome.expiresAt - Date.now())).unref();
          await this.notify('status', { vscodeVersion: vscode.version, extensionVersion: this.context.extension.packageJSON.version, trusted: vscode.workspace.isTrusted });
          continue;
        }
        const message = openMessage(this.key, frame, this.sessionId!, this.incomingSequence++);
        if (message.kind !== 'request') throw new Error('Unexpected bridge message');
        await this.respond(message);
      }
    } catch (error) { this.socket?.destroy(error instanceof Error ? error : new Error(String(error))); }
  }

  private async respond(request: BridgeRequest): Promise<void> {
    if (!this.socket || !this.key || !this.sessionId) return;
    try {
      const payload = await this.handler(request.method, request.payload);
      this.socket.write(encodeFrame(sealMessage(this.key, this.sessionId, this.outgoingSequence++, { version: PROTOCOL_VERSION, kind: 'response', id: request.id, ok: true, payload })));
    } catch (error) {
      this.socket.write(encodeFrame(sealMessage(this.key, this.sessionId, this.outgoingSequence++, { version: PROTOCOL_VERSION, kind: 'response', id: request.id, ok: false, error: sanitizeError(error) })));
    }
  }
}
