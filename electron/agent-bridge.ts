import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentBridgeStatus, AgentEditorContext, AgentPairingSession } from './types.js';

const PROTOCOL_VERSION = 1;
const MAX_MESSAGE_BYTES = 256 * 1024;
const PAIRING_TTL_MS = 5 * 60_000;
const MAX_PAIRING_ATTEMPTS = 8;
const REQUEST_TIMEOUT_MS = 15_000;

const CAPABILITY_LABELS: Record<string, string> = {
  'editor.context': 'Editor context',
  'editor.open': 'Open source location',
  'editor.save': 'Save files',
  'editor.task': 'Run trusted VS Code tasks',
  'editor.refresh': 'Refresh browser preview',
};

interface StoredPairing {
  version: 1;
  tokenDigest: string;
  pairedAt: string;
}

interface PairingChallenge {
  digest: string;
  salt: string;
  code: string;
  expiresAt: number;
  attempts: number;
}

interface BridgeClient {
  socket: Socket;
  role: 'editor' | 'mcp';
  name: string;
  version: string;
  connectedAt: string;
  capabilities: Set<string>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface WireMessage {
  id?: string;
  method?: string;
  params?: unknown;
  token?: string;
  result?: unknown;
  error?: { message?: string };
}

export interface AgentEditorContextInternal extends AgentEditorContext {
  rootPath?: string;
  activeFileAbsolutePath?: string;
}

export type AgentBridgeListenTarget = string | { host: '127.0.0.1'; port: number };

export function defaultAgentBridgeEndpoint(): string {
  if (process.platform === 'win32') return '\\\\.\\pipe\\private-browser-agent-v1';
  const user = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return join(tmpdir(), `private-browser-agent-${user}.sock`);
}

export function tokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function safeText(value: unknown, max = 300): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}

function normalizeCapabilities(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.map((entry) => safeText(entry, 80)).filter((entry) => entry in CAPABILITY_LABELS));
}

function asEditorContext(value: unknown): AgentEditorContextInternal {
  if (!value || typeof value !== 'object') throw new Error('VS Code returned an invalid editor context');
  const input = value as Record<string, unknown>;
  const diagnostics = Array.isArray(input.diagnostics) ? input.diagnostics.slice(0, 100).map((entry) => {
    const item = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
    const severity = ['error', 'warning', 'information', 'hint'].includes(String(item.severity))
      ? String(item.severity) as 'error' | 'warning' | 'information' | 'hint'
      : 'information';
    return {
      severity,
      message: safeText(item.message, 1_000),
      file: safeText(item.file, 500),
      line: Math.max(1, Number(item.line) || 1),
      ...(safeText(item.source, 100) ? { source: safeText(item.source, 100) } : {}),
    };
  }) : [];
  const activeInput = input.activeFile && typeof input.activeFile === 'object' ? input.activeFile as Record<string, unknown> : undefined;
  const gitInput = input.git && typeof input.git === 'object' ? input.git as Record<string, unknown> : undefined;
  return {
    workspaceTrusted: input.workspaceTrusted === true,
    ...(safeText(input.workspaceName, 200) ? { workspaceName: safeText(input.workspaceName, 200) } : {}),
    ...(safeText(input.rootName, 200) ? { rootName: safeText(input.rootName, 200) } : {}),
    ...(safeText(input.rootPath, 4_096) ? { rootPath: safeText(input.rootPath, 4_096) } : {}),
    ...(activeInput ? {
      activeFile: {
        path: safeText(activeInput.path, 1_000),
        language: safeText(activeInput.language, 100),
        ...(safeText(activeInput.selection, 20_000) ? { selection: safeText(activeInput.selection, 20_000) } : {}),
        line: Math.max(1, Number(activeInput.line) || 1),
      },
      ...(safeText(activeInput.absolutePath, 4_096) ? { activeFileAbsolutePath: safeText(activeInput.absolutePath, 4_096) } : {}),
    } : {}),
    diagnostics,
    ...(gitInput ? {
      git: {
        ...(safeText(gitInput.branch, 200) ? { branch: safeText(gitInput.branch, 200) } : {}),
        dirty: gitInput.dirty === true,
        changedFiles: Math.max(0, Number(gitInput.changedFiles) || 0),
      },
    } : {}),
    tasks: Array.isArray(input.tasks) ? input.tasks.map((task) => safeText(task, 200)).filter(Boolean).slice(0, 100) : [],
    capturedAt: safeText(input.capturedAt, 100) || new Date().toISOString(),
  };
}

export function publicEditorContext(context: AgentEditorContextInternal): AgentEditorContext {
  const { rootPath: _rootPath, activeFileAbsolutePath: _activeFileAbsolutePath, ...publicContext } = context;
  return publicContext;
}

export class AgentBridgeServer {
  private server?: Server;
  private editorClient?: BridgeClient;
  private readonly authenticatedClients = new Map<Socket, BridgeClient>();
  private pairing?: PairingChallenge;
  private stored?: StoredPairing;
  private error?: string;
  private readonly sockets = new Set<Socket>();
  private readonly pending = new Map<string, PendingRequest>();
  private nextRequestId = 0;

  constructor(
    private readonly configPath: string,
    private readonly endpoint: AgentBridgeListenTarget = defaultAgentBridgeEndpoint(),
    private readonly onStatusChange: (status: AgentBridgeStatus) => void = () => undefined,
    private readonly onToolRequest: (method: string, params: unknown) => Promise<unknown> = async () => { throw new Error('Agent tools are unavailable'); },
  ) {
    this.stored = this.load();
  }

  status(): AgentBridgeStatus {
    const pairingActive = Boolean(this.pairing && this.pairing.expiresAt > Date.now());
    return {
      state: this.error ? 'error' : this.editorClient ? 'connected' : pairingActive ? 'pairing' : this.server ? 'ready' : 'starting',
      paired: Boolean(this.stored),
      connected: Boolean(this.editorClient),
      endpoint: 'local-os-pipe',
      ...(this.editorClient ? { client: { name: this.editorClient.name, version: this.editorClient.version, connectedAt: this.editorClient.connectedAt } } : {}),
      capabilities: [...(this.editorClient?.capabilities ?? [])].map((id) => ({ id, label: CAPABILITY_LABELS[id] })),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.error = undefined;
    if (process.platform !== 'win32' && typeof this.endpoint === 'string' && existsSync(this.endpoint)) unlinkSync(this.endpoint);
    this.server = createServer((socket) => this.accept(socket));
    this.server.on('error', (error) => {
      this.error = safeText(error.message, 300) || 'Local bridge failed';
      this.emitStatus();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => { this.server?.off('listening', onListening); reject(error); };
        const onListening = () => { this.server?.off('error', onError); resolve(); };
        this.server!.once('error', onError);
        this.server!.once('listening', onListening);
        if (typeof this.endpoint === 'string') this.server!.listen(this.endpoint);
        else this.server!.listen(this.endpoint.port, this.endpoint.host);
      });
    } catch (error) {
      this.server = undefined;
      throw error;
    }
    if (process.platform !== 'win32' && typeof this.endpoint === 'string') chmodSync(this.endpoint, 0o600);
    this.emitStatus();
  }

  beginPairing(): AgentPairingSession {
    if (!this.server) throw new Error('The local agent bridge is not ready');
    const code = randomInt(0, 100_000_000).toString().padStart(8, '0');
    const salt = randomBytes(16).toString('hex');
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    this.pairing = { code, salt, digest: tokenDigest(`${salt}:${code}`), expiresAt, attempts: 0 };
    this.emitStatus();
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  listeningAddress(): string | AddressInfo | null {
    return this.server?.address() ?? null;
  }

  disconnect(): AgentBridgeStatus {
    this.error = undefined;
    this.pairing = undefined;
    this.stored = undefined;
    if (existsSync(this.configPath)) unlinkSync(this.configPath);
    for (const client of this.authenticatedClients.values()) client.socket.destroy();
    this.authenticatedClients.clear();
    this.editorClient = undefined;
    this.rejectPending(new Error('VS Code disconnected'));
    this.emitStatus();
    return this.status();
  }

  async getEditorContext(): Promise<AgentEditorContextInternal> {
    this.requireCapability('editor.context');
    return asEditorContext(await this.request('editor.getContext', {}));
  }

  async openLocation(path: string, line: number): Promise<void> {
    this.requireCapability('editor.open');
    await this.request('editor.openLocation', { path: safeText(path, 4_096), line: Math.max(1, Math.round(line)) });
  }

  async saveAll(): Promise<void> {
    this.requireCapability('editor.save');
    await this.request('editor.saveAll', {});
  }

  async runTask(name: string): Promise<void> {
    this.requireCapability('editor.task');
    await this.request('editor.runTask', { name: safeText(name, 200) });
  }

  async stop(): Promise<void> {
    this.rejectPending(new Error('Agent bridge stopped'));
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.authenticatedClients.clear();
    this.editorClient = undefined;
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== 'win32' && typeof this.endpoint === 'string' && existsSync(this.endpoint)) unlinkSync(this.endpoint);
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.setNoDelay(true);
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer, 'utf8') > MAX_MESSAGE_BYTES) {
        socket.destroy(new Error('Bridge message too large'));
        return;
      }
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) void this.receive(socket, line);
        newline = buffer.indexOf('\n');
      }
    });
    socket.on('close', () => {
      this.sockets.delete(socket);
      this.authenticatedClients.delete(socket);
      if (this.editorClient?.socket === socket) {
        this.editorClient = undefined;
        this.rejectPending(new Error('VS Code connection closed'));
        this.emitStatus();
      }
    });
    socket.on('error', () => undefined);
  }

  private async receive(socket: Socket, line: string): Promise<void> {
    let message: WireMessage;
    try { message = JSON.parse(line) as WireMessage; }
    catch { this.reply(socket, '', undefined, 'Invalid JSON'); return; }

    if (message.id && !message.method && ('result' in message || 'error' in message)) {
      const pending = this.pending.get(message.id);
      if (!pending || this.editorClient?.socket !== socket) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(safeText(message.error.message, 500) || 'VS Code request failed'));
      else pending.resolve(message.result);
      return;
    }

    if (!message.id || !message.method) return;
    try {
      if (message.method === 'pair') {
        const result = this.pair(socket, message.params);
        this.reply(socket, message.id, result);
        return;
      }
      if (message.method === 'register') {
        const result = this.register(socket, message.token, message.params);
        this.reply(socket, message.id, result);
        return;
      }
      if (message.method === 'ping' && this.authenticatedClients.has(socket)) {
        this.reply(socket, message.id, { protocolVersion: PROTOCOL_VERSION, now: new Date().toISOString() });
        return;
      }
      const authenticated = this.authenticatedClients.get(socket);
      if (authenticated?.role === 'mcp' && message.method.startsWith('tool.')) {
        this.reply(socket, message.id, await this.onToolRequest(message.method, message.params));
        return;
      }
      throw new Error('Unsupported bridge method');
    } catch (error) {
      this.reply(socket, message.id, undefined, error instanceof Error ? error.message : 'Bridge request failed');
    }
  }

  private pair(socket: Socket, params: unknown): { token: string; protocolVersion: number } {
    const challenge = this.pairing;
    if (!challenge || challenge.expiresAt <= Date.now()) {
      this.pairing = undefined;
      throw new Error('Pairing code expired; generate a new code in Private Browser');
    }
    challenge.attempts += 1;
    if (challenge.attempts > MAX_PAIRING_ATTEMPTS) {
      this.pairing = undefined;
      this.emitStatus();
      throw new Error('Too many pairing attempts; generate a new code');
    }
    const input = params && typeof params === 'object' ? params as Record<string, unknown> : {};
    const presented = tokenDigest(`${challenge.salt}:${safeText(input.code, 20)}`);
    if (!secureEqual(presented, challenge.digest)) throw new Error('Pairing code is incorrect');
    const token = `pb_${randomBytes(32).toString('base64url')}`;
    this.stored = { version: 1, tokenDigest: tokenDigest(token), pairedAt: new Date().toISOString() };
    this.save();
    this.pairing = undefined;
    this.attachClient(socket, input, 'editor');
    this.emitStatus();
    return { token, protocolVersion: PROTOCOL_VERSION };
  }

  private register(socket: Socket, token: unknown, params: unknown): { protocolVersion: number } {
    if (!this.stored || typeof token !== 'string' || !secureEqual(tokenDigest(token), this.stored.tokenDigest)) {
      throw new Error('Bridge authentication failed');
    }
    const input = params && typeof params === 'object' ? params as Record<string, unknown> : {};
    this.attachClient(socket, input, input.role === 'mcp' ? 'mcp' : 'editor');
    this.emitStatus();
    return { protocolVersion: PROTOCOL_VERSION };
  }

  private attachClient(socket: Socket, input: Record<string, unknown>, role: 'editor' | 'mcp'): void {
    if (role === 'editor' && this.editorClient && this.editorClient.socket !== socket) this.editorClient.socket.destroy();
    const client: BridgeClient = {
      socket,
      role,
      name: safeText(input.name, 100) || 'VS Code',
      version: safeText(input.version, 100) || 'unknown',
      connectedAt: new Date().toISOString(),
      capabilities: normalizeCapabilities(input.capabilities),
    };
    this.authenticatedClients.set(socket, client);
    if (role === 'editor') this.editorClient = client;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.editorClient) return Promise.reject(new Error('Connect the Private Browser VS Code extension first'));
    const id = `browser-${++this.nextRequestId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('VS Code did not respond in time'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.editorClient!.socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  private requireCapability(capability: string): void {
    if (!this.editorClient) throw new Error('Connect the Private Browser VS Code extension first');
    if (!this.editorClient.capabilities.has(capability)) throw new Error(`VS Code bridge does not provide ${CAPABILITY_LABELS[capability] ?? capability}`);
  }

  private reply(socket: Socket, id: string, result?: unknown, error?: string): void {
    socket.write(`${JSON.stringify(error ? { id, error: { message: safeText(error, 500) } } : { id, result })}\n`);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private emitStatus(): void {
    this.onStatusChange(this.status());
  }

  private load(): StoredPairing | undefined {
    try {
      if (!existsSync(this.configPath)) return undefined;
      const parsed = JSON.parse(readFileSync(this.configPath, 'utf8')) as StoredPairing;
      if (parsed.version !== 1 || !/^[a-f0-9]{64}$/.test(parsed.tokenDigest) || !parsed.pairedAt) throw new Error('Invalid bridge pairing');
      return parsed;
    } catch {
      this.error = 'Pairing configuration is corrupt; disconnect and pair again';
      return undefined;
    }
  }

  private save(): void {
    if (!this.stored) return;
    mkdirSync(dirname(this.configPath), { recursive: true });
    const temporaryPath = `${this.configPath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(this.stored), { mode: 0o600 });
    renameSync(temporaryPath, this.configPath);
  }
}
