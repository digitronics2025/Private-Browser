import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KeyObject } from 'node:crypto';
import {
  encodeFrame, fingerprint, FrameDecoder, generateEphemeralKeyPair, openPayload, sealPayload, signText, verifyText,
  type DeviceIdentity,
} from '@private-browser/bridge-protocol';
import {
  AGENT_HANDSHAKE_ID, AGENT_MAX_OUTPUT_BYTES, AGENT_WIRE_VERSION, agentHello,
  agentIdentity, agentKeys, agentTranscript, isAgentMethod, parseAgentRequest, parseAgentRequestEnvelope,
} from '@private-browser/bridge-protocol/agent';
import { AgentError, agentError } from './agent-policy.js';
import { writeAgentBytes } from './agent-audit.js';

type Device = ReturnType<typeof agentIdentity.parse>['device'];
export type AgentRequest = ReturnType<typeof parseAgentRequest>;
export interface AgentConnection {
  id: string;
  device: Device;
  abort: AbortSignal;
  expiresAt: number;
  close(): void;
}

interface AgentPipeOptions {
  root: string;
  identity: DeviceIdentity;
  authorize(device: Device, code?: string): { expiresAt: number; idleMs: number } | 'expired' | undefined;
  opened(connection: AgentConnection): void;
  closed(connection: AgentConnection): void;
  takeAction(connection: AgentConnection): void;
  request(connection: AgentConnection, request: AgentRequest): Promise<unknown>;
}

export class AgentPipe {
  private server?: Server;
  private unixDirectory?: string;
  private readonly sockets = new Set<Socket>();
  private readonly handshakeTimes: number[] = [];
  private stopped = false;

  constructor(private readonly options: AgentPipeOptions) {}

  async start(): Promise<void> {
    const id = randomUUID();
    let pipe = `\\\\.\\pipe\\private-browser-agent-${id}`;
    if (process.platform !== 'win32') {
      this.unixDirectory = await mkdtemp(join(tmpdir(), 'pb-agent-'));
      pipe = join(this.unixDirectory, 'agent.sock');
    }
    if (this.stopped) return;
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(pipe, () => { server.removeListener('error', reject); resolve(); });
    });
    server.on('error', () => this.stop());
    if (process.platform !== 'win32') await chmod(pipe, 0o600);
    if (this.stopped) return;
    writeAgentBytes(join(this.options.root, 'rendezvous.json'), Buffer.from(JSON.stringify({
      wire: AGENT_WIRE_VERSION, pipe, fingerprint: fingerprint(this.options.identity.publicKey),
    })));
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const socket of this.sockets) socket.destroy();
    this.server?.close();
    // The random socket was created under our own mkdtemp directory.
    if (this.unixDirectory) {
      const directory = this.unixDirectory;
      void rm(join(directory, 'agent.sock'), { force: true }).finally(() =>
        import('node:fs/promises').then(({ rmdir }) => rmdir(directory))).catch(() => undefined);
    }
  }

  private accept(socket: Socket): void {
    const now = Date.now();
    while (this.handshakeTimes[0] !== undefined && now - this.handshakeTimes[0] >= 60_000) this.handshakeTimes.shift();
    if (this.stopped || this.sockets.size >= 12 || this.handshakeTimes.length >= 36) { socket.destroy(); return; }
    this.handshakeTimes.push(now);
    this.sockets.add(socket);

    const identity = this.options.identity;
    const decoder = new FrameDecoder();
    const abort = new AbortController();
    let ephemeral: KeyObject | undefined;
    let keys: ReturnType<typeof agentKeys> | undefined;
    let connection: AgentConnection | undefined;
    let transcript: string;
    let incoming = 0;
    let outgoing = 0;
    let busy = false;
    let expire: NodeJS.Timeout | undefined;
    const close = () => { abort.abort(); socket.destroy(); };
    socket.setTimeout(8_000);
    socket.on('timeout', close);
    socket.on('error', close);
    socket.on('close', () => {
      abort.abort();
      clearTimeout(expire);
      keys?.client.fill(0);
      keys?.browser.fill(0);
      this.sockets.delete(socket);
      if (connection) this.options.closed(connection);
    });

    const pair = generateEphemeralKeyPair();
    ephemeral = pair.privateKey;
    const challenge = {
      wire: AGENT_WIRE_VERSION, kind: 'challenge', nonce: randomBytes(32).toString('hex'),
      identityKey: identity.publicKey, ephemeralKey: pair.publicKey,
    };
    socket.write(encodeFrame({ ...challenge, signature: signText(identity.privateKey, agentTranscript(challenge)) }));

    const respond = async (current: AgentConnection, activeKeys: ReturnType<typeof agentKeys>, raw: unknown) => {
      const envelope = parseAgentRequestEnvelope(raw);
      let response: unknown;
      try {
        this.options.takeAction(current);
        if (!isAgentMethod(envelope.method)) throw new AgentError('UNKNOWN_TOOL', 'Unknown Private Browser tool.');
        let request: AgentRequest;
        try { request = parseAgentRequest(raw); }
        catch { throw new AgentError('INVALID_ARGUMENTS', 'Invalid arguments. Check the tool schema.'); }
        const output = await this.options.request(current, request);
        if (Buffer.byteLength(JSON.stringify(output ?? null)) > AGENT_MAX_OUTPUT_BYTES) throw new AgentError('OUTPUT_LIMIT', 'This result exceeds the output limit.');
        response = { kind: 'result', id: envelope.id, output };
      } catch (error) {
        response = { kind: 'error', id: envelope.id, ...agentError(error) };
      }
      if (!abort.signal.aborted) socket.write(encodeFrame(sealPayload(activeKeys.browser, current.id, outgoing++, response)));
    };

    socket.on('data', (data) => {
      try {
        for (const frame of decoder.push(data)) {
          if (busy || abort.signal.aborted) throw new Error('Agent session closed or busy');
          if (!keys) {
            const hello = agentHello.parse(frame);
            transcript = agentTranscript({ challenge, hello });
            keys = agentKeys({ privateKey: ephemeral!, peerPublicKey: hello.ephemeralKey, challenge: transcript });
            ephemeral = undefined;
            continue;
          }
          if (!connection) {
            const identify = agentIdentity.parse(openPayload(keys.client, frame, AGENT_HANDSHAKE_ID, 0));
            if (!verifyText(identify.device.publicKey, agentTranscript({ transcript, device: identify.device }), identify.signature)) throw new Error('Bad device proof');
            const grant = this.options.authorize(identify.device, identify.code);
            if (!grant || grant === 'expired' || grant.expiresAt <= Date.now()) {
              socket.end(encodeFrame(sealPayload(keys.browser, AGENT_HANDSHAKE_ID, 0, {
                kind: 'denied', code: grant ? 'SESSION_EXPIRED' : undefined,
              })));
              return;
            }
            const { expiresAt, idleMs } = grant;
            connection = { id: randomUUID(), device: identify.device, expiresAt, abort: abort.signal, close };
            expire = setTimeout(close, expiresAt - Date.now());
            socket.setTimeout(idleMs);
            this.options.opened(connection);
            socket.write(encodeFrame(sealPayload(keys.browser, AGENT_HANDSHAKE_ID, 0, { kind: 'welcome', sessionId: connection.id, expiresAt })));
            continue;
          }
          const raw = openPayload(keys.client, frame, connection.id, incoming++);
          busy = true;
          void respond(connection, keys, raw).catch(close).finally(() => { busy = false; });
        }
      } catch { close(); }
    });
  }
}
