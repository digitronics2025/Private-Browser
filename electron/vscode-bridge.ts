import { randomInt, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { safeStorage } from 'electron';
import {
  FrameDecoder,
  PAIRING_TTL_MS,
  PROTOCOL_VERSION,
  SESSION_TTL_MS,
  bridgeStatusSchema,
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
  welcomeTranscript,
  type BridgeEvent,
  type BridgeMethod,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeStatus,
  type DeviceIdentity,
  type ProjectInfo,
} from '@private-browser/bridge-protocol';

interface StoredBridgeSecrets { identity: DeviceIdentity; trustedDevices: Record<string, string>; }
interface PairingState { code: string; expiresAt: number; attempts: number; }
interface PendingRequest { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout; }
interface SessionState {
  socket: Socket; key: Buffer; sessionId: string; expiresAt: number; incomingSequence: number; outgoingSequence: number;
  extensionVersion: string; vscodeVersion: string; instanceId: string; deviceId: string; requestsInWindow: number; windowStartedAt: number;
}

export class VscodeBridgeServer {
  private server?: Server;
  private readonly pipePath = process.platform === 'win32' ? `\\\\.\\pipe\\private-browser-${randomUUID()}` : join(tmpdir(), `private-browser-${randomUUID()}.sock`);
  private readonly challenge = randomUUID();
  private secrets?: StoredBridgeSecrets;
  private pairing?: PairingState;
  private session?: SessionState;
  private selectedProject?: ProjectInfo;
  private activity?: string;
  private error?: string;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly secretPath: string, private readonly rendezvousPath: string, private readonly browserVersion: string, private readonly onChange: () => void) {}

  async start(): Promise<void> {
    this.secrets = await this.loadSecrets();
    await mkdir(dirname(this.rendezvousPath), { recursive: true });
    if (process.platform !== 'win32') await rm(this.pipePath, { force: true });
    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => this.server!.once('error', reject).listen(this.pipePath, resolve));
    const rendezvous = {
      schemaVersion: 1, pipePath: this.pipePath, instanceId: randomUUID(), challenge: this.challenge,
      minProtocolVersion: PROTOCOL_VERSION, maxProtocolVersion: PROTOCOL_VERSION,
      browserVersion: this.browserVersion, browserIdentityPublicKey: this.secrets.identity.publicKey,
      expiresAt: Date.now() + 24 * 60 * 60_000,
    };
    await writeFile(this.rendezvousPath, JSON.stringify(rendezvous), { encoding: 'utf8', mode: 0o600 });
    await chmod(this.rendezvousPath, 0o600).catch(() => undefined);
  }

  status(): BridgeStatus {
    const state: BridgeStatus['state'] = this.error?.startsWith('Protocol incompatible') ? 'incompatible' : this.error ? 'error' : this.session ? 'connected' : this.pairing && this.pairing.expiresAt > Date.now() ? 'pairing' : 'disconnected';
    return bridgeStatusSchema.parse({
      state, browserVersion: this.browserVersion, extensionVersion: this.session?.extensionVersion,
      vscodeVersion: this.session?.vscodeVersion, instanceId: this.session?.instanceId,
      pairingCode: state === 'pairing' ? this.pairing?.code : undefined,
      pairingExpiresAt: state === 'pairing' ? this.pairing?.expiresAt : undefined,
      sessionExpiresAt: this.session?.expiresAt, project: this.selectedProject, activity: this.activity, error: this.error,
    });
  }

  beginPairing(): BridgeStatus {
    this.pairing = { code: String(randomInt(0, 100_000_000)).padStart(8, '0'), expiresAt: Date.now() + PAIRING_TTL_MS, attempts: 0 };
    this.error = undefined; this.onChange(); return this.status();
  }

  setProject(project: ProjectInfo | undefined): void { this.selectedProject = project; this.onChange(); }

  async request(method: BridgeMethod, payload: unknown): Promise<unknown> {
    const session = this.requireSession(); const id = randomUUID();
    const request: BridgeRequest = { version: PROTOCOL_VERSION, kind: 'request', id, method, payload };
    const timeout = method.startsWith('test.') ? 15 * 60_000 : 30_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('VS Code bridge request timed out')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      session.socket.write(encodeFrame(sealMessage(session.key, session.sessionId, session.outgoingSequence++, request)));
    });
  }

  async disconnect(revoke: boolean): Promise<void> {
    this.closeSession(revoke ? 'Pairing revoked' : 'Disconnected');
    this.selectedProject = undefined;
    if (revoke && this.secrets) {
      this.secrets.trustedDevices = {};
      await this.saveSecrets();
    }
    this.onChange();
  }

  async close(): Promise<void> {
    this.closeSession('Browser closed');
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
    await rm(this.rendezvousPath, { force: true });
    if (process.platform !== 'win32') await rm(this.pipePath, { force: true });
  }

  private accept(socket: Socket): void {
    socket.setTimeout(30_000, () => socket.destroy(new Error('Bridge handshake timed out')));
    const decoder = new FrameDecoder(); let handshaken = false;
    socket.on('data', (chunk) => {
      try {
        for (const raw of decoder.push(chunk)) {
          if (!handshaken) { this.handleHello(socket, raw); handshaken = true; socket.setTimeout(0); }
          else this.handleSecure(socket, raw);
        }
      } catch (error) { this.error = sanitizeError(error).message; socket.destroy(); this.onChange(); }
    });
    socket.on('close', () => { if (this.session?.socket === socket) { this.closeSession('VS Code disconnected'); this.onChange(); } });
    socket.on('error', () => undefined);
  }

  private handleHello(socket: Socket, raw: unknown): void {
    if (raw && typeof raw === 'object') {
      const range = raw as { minVersion?: number; maxVersion?: number };
      if ((range.minVersion ?? Infinity) > PROTOCOL_VERSION || (range.maxVersion ?? -Infinity) < PROTOCOL_VERSION) throw new Error('Protocol incompatible. Install Private Browser 0.4.0 and Private Browser Bridge 0.4.0 from the same release.');
    }
    const hello = helloSchema.parse(raw);
    if (hello.challenge !== this.challenge) throw new Error('Bridge challenge mismatch');
    const { signature: _signature, ...helloWithoutSignature } = hello;
    if (!verifyText(hello.identityPublicKey, helloTranscript(helloWithoutSignature), hello.signature)) throw new Error('Invalid VS Code identity signature');
    const knownKey = this.secrets?.trustedDevices[hello.deviceId];
    if (hello.pairingCode) {
      if (!this.pairing || this.pairing.expiresAt < Date.now()) throw new Error('Pairing code expired');
      this.pairing.attempts += 1;
      if (this.pairing.attempts > 5) { this.pairing = undefined; throw new Error('Too many pairing attempts'); }
      if (hello.pairingCode !== this.pairing.code) throw new Error('Invalid pairing code');
      if (this.secrets) this.secrets.trustedDevices[hello.deviceId] = hello.identityPublicKey;
      void this.saveSecrets(); this.pairing = undefined;
    } else if (!knownKey || knownKey !== hello.identityPublicKey) throw new Error('VS Code client is not paired');
    if (this.session) this.closeSession('Replaced by a new VS Code connection');
    const ephemeral = generateEphemeralKeyPair(); const sessionId = randomUUID(); const expiresAt = Date.now() + SESSION_TTL_MS;
    const unsignedWelcome = { kind: 'welcome' as const, version: PROTOCOL_VERSION, sessionId, expiresAt, browserVersion: this.browserVersion, browserIdentityPublicKey: this.secrets!.identity.publicKey, ephemeralPublicKey: ephemeral.publicKey };
    const welcome = { ...unsignedWelcome, signature: signText(this.secrets!.identity.privateKey, welcomeTranscript(hello, unsignedWelcome)) };
    socket.write(encodeFrame(welcome));
    this.session = { socket, key: deriveSessionKey({ privateKey: ephemeral.privateKey, peerPublicKey: hello.ephemeralPublicKey, challenge: hello.challenge, pairingCode: hello.pairingCode }), sessionId, expiresAt, incomingSequence: 0, outgoingSequence: 0, extensionVersion: hello.extensionVersion, vscodeVersion: hello.vscodeVersion, instanceId: hello.instanceId, deviceId: hello.deviceId, requestsInWindow: 0, windowStartedAt: Date.now() };
    this.error = undefined; this.activity = 'VS Code connected'; this.onChange();
    setTimeout(() => { if (this.session?.sessionId === sessionId) { this.closeSession('Session expired; reconnecting'); this.onChange(); } }, SESSION_TTL_MS).unref();
  }

  private handleSecure(socket: Socket, raw: unknown): void {
    const session = this.requireSession();
    if (session.socket !== socket) throw new Error('Bridge session socket mismatch');
    if (session.expiresAt < Date.now()) throw new Error('Bridge session expired');
    const now = Date.now(); if (now - session.windowStartedAt > 60_000) { session.windowStartedAt = now; session.requestsInWindow = 0; }
    if (++session.requestsInWindow > 120) throw new Error('Bridge rate limit exceeded');
    const message = openMessage(session.key, raw, session.sessionId, session.incomingSequence++);
    if (message.kind === 'response') {
      const pending = this.pending.get(message.id); if (!pending) throw new Error('Unknown or replayed bridge response');
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.payload); else pending.reject(new Error(message.error?.message ?? 'VS Code request failed'));
    } else if (message.kind === 'event') this.handleEvent(message);
    else throw new Error('VS Code cannot initiate privileged browser requests');
  }

  private handleEvent(event: BridgeEvent): void {
    this.activity = event.event === 'task.progress' ? 'Project task running' : event.event === 'task.complete' ? 'Project task complete' : this.activity;
    const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) ? event.payload as Record<string, unknown> : {};
    if (event.event === 'active-editor' && this.selectedProject && typeof payload.path === 'string') {
      const path = relative(this.selectedProject.project.path, payload.path);
      if (path && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(path)) this.selectedProject = { ...this.selectedProject, activeFile: path };
    }
    if (event.event === 'task.progress' && this.selectedProject && typeof payload.url === 'string') {
      try {
        const url = new URL(payload.url);
        if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) this.selectedProject = { ...this.selectedProject, devServerUrl: url.toString() };
      } catch { /* ignore malformed task output */ }
    }
    this.onChange();
  }

  private requireSession(): SessionState {
    if (!this.session || this.session.socket.destroyed) throw new Error('Connect VS Code first');
    return this.session;
  }

  private closeSession(reason: string): void {
    const current = this.session; this.session = undefined; this.activity = reason;
    current?.socket.destroy();
    for (const [id, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(new Error(reason)); this.pending.delete(id); }
  }

  private async loadSecrets(): Promise<StoredBridgeSecrets> {
    try {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is unavailable');
      const encrypted = Buffer.from(await readFile(this.secretPath, 'utf8'), 'base64');
      const parsed = JSON.parse(safeStorage.decryptString(encrypted)) as StoredBridgeSecrets;
      if (!parsed.identity?.privateKey || !parsed.identity?.publicKey || !parsed.trustedDevices) throw new Error('Invalid bridge secret store');
      return parsed;
    } catch {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Private Browser Bridge requires operating-system encryption');
      const created = { identity: generateIdentity(), trustedDevices: {} };
      this.secrets = created; await this.saveSecrets(); return created;
    }
  }

  private async saveSecrets(): Promise<void> {
    if (!this.secrets || !safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is unavailable');
    await mkdir(dirname(this.secretPath), { recursive: true });
    await writeFile(this.secretPath, safeStorage.encryptString(JSON.stringify(this.secrets)).toString('base64'), { encoding: 'utf8', mode: 0o600 });
    await chmod(this.secretPath, 0o600).catch(() => undefined);
  }
}
