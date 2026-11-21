import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import {
  encodeFrame, fingerprint, FrameDecoder, generateEphemeralKeyPair, openPayload, sealPayload, signText, verifyText,
} from '@private-browser/bridge-protocol';
import { isAgentPipeName } from '@private-browser/bridge-protocol/agent-location';
import {
  AGENT_DISABLED, AGENT_HANDSHAKE_ID, AGENT_WIRE_VERSION, agentChallenge, agentKeys, agentRendezvous,
  agentResponse, agentTranscript, agentWelcome, type AgentMethod,
} from '@private-browser/bridge-protocol/agent';
import type { StoredAgentIdentity } from './identity.js';

type Identity = Omit<StoredAgentIdentity, 'browserFingerprint'> & { browserFingerprint?: string };

export async function readAgentRendezvous(root: string) {
  try {
    const path = join(root, 'rendezvous.json');
    const file = await lstat(path);
    if (!file.isFile() || file.size > 4_096) throw new Error();
    const rendezvous = agentRendezvous.parse(JSON.parse(await readFile(path, 'utf8')));
    if (!isAgentPipeName(rendezvous.pipe)) throw new Error();
    if (process.platform !== 'win32') {
      const pipe = await lstat(rendezvous.pipe);
      const directory = await lstat(dirname(rendezvous.pipe));
      if (!pipe.isSocket() || !directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077)) throw new Error();
    }
    return rendezvous;
  } catch { throw new Error(AGENT_DISABLED); }
}

class PipeFrames {
  private pending?: { resolve(value: unknown): void; reject(error: Error): void };
  private readonly decoder = new FrameDecoder();
  private readonly queue: unknown[] = [];

  constructor(readonly socket: Socket) {
    const closed = () => { this.pending?.reject(new Error(AGENT_DISABLED)); this.pending = undefined; socket.destroy(); };
    socket.on('close', closed);
    socket.on('error', closed);
    socket.on('data', (data) => {
      try {
        for (const value of this.decoder.push(data)) {
          if (this.pending) { this.pending.resolve(value); this.pending = undefined; }
          else this.queue.push(value);
          if (this.queue.length > 2) throw new Error();
        }
      } catch { closed(); }
    });
  }

  async read(timeoutMs: number): Promise<unknown> {
    if (this.queue.length) return this.queue.shift();
    if (this.socket.destroyed) throw new Error(AGENT_DISABLED);
    const timeout = setTimeout(() => this.socket.destroy(), timeoutMs);
    try {
      return await new Promise<unknown>((resolve, reject) => { this.pending = { resolve, reject }; });
    } finally { clearTimeout(timeout); }
  }

  send(value: unknown): void { this.socket.write(encodeFrame(value)); }
}

export class AgentRemoteError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export class AgentClient {
  private sent = 0;
  private received = 0;

  private constructor(
    private readonly frames: PipeFrames,
    private readonly session: string,
    private readonly keys: ReturnType<typeof agentKeys>,
    readonly fingerprint: string,
  ) {
    frames.socket.once('close', () => { keys.browser.fill(0); keys.client.fill(0); });
  }

  static async connect(root: string, name: string, identity: Identity, code?: string): Promise<AgentClient> {
    const rendezvous = await readAgentRendezvous(root);
    if (identity.browserFingerprint && identity.browserFingerprint !== rendezvous.fingerprint) {
      throw new Error('The browser identity changed. Generate a new pairing code and pair this client again.');
    }
    const frames = new PipeFrames(createConnection(rendezvous.pipe));
    try {
      const { signature, ...challenge } = agentChallenge.parse(await frames.read(8_000));
      if (fingerprint(challenge.identityKey) !== rendezvous.fingerprint
        || !verifyText(challenge.identityKey, agentTranscript(challenge), signature)) throw new Error('The browser handshake could not be verified.');
      const ephemeral = generateEphemeralKeyPair();
      const hello = { wire: AGENT_WIRE_VERSION, kind: 'hello', ephemeralKey: ephemeral.publicKey };
      const transcript = agentTranscript({ challenge, hello });
      const keys = agentKeys({ privateKey: ephemeral.privateKey, peerPublicKey: challenge.ephemeralKey, challenge: transcript });
      const device = { id: identity.id, name, publicKey: identity.identity.publicKey };
      frames.send(hello);
      frames.send(sealPayload(keys.client, AGENT_HANDSHAKE_ID, 0, {
        kind: 'identify', device, code, signature: signText(identity.identity.privateKey, agentTranscript({ transcript, device })),
      }));
      const response = agentWelcome.safeParse(openPayload(keys.browser, await frames.read(8_000), AGENT_HANDSHAKE_ID, 0));
      if (!response.success) {
        keys.client.fill(0);
        keys.browser.fill(0);
        throw new Error('The browser refused this client. Check the code, resume Agent Mode, or pair the client again.');
      }
      return new AgentClient(frames, response.data.sessionId, keys, rendezvous.fingerprint);
    } catch (error) { frames.socket.destroy(); throw error; }
  }

  get closed(): boolean { return this.frames.socket.destroyed; }
  close(): void { this.frames.socket.destroy(); }

  async request(method: AgentMethod, input: unknown): Promise<unknown> {
    const id = randomUUID();
    this.frames.send(sealPayload(this.keys.client, this.session, this.sent++, { kind: 'request', id, method, input }));
    const response = agentResponse.parse(openPayload(this.keys.browser, await this.frames.read(130_000), this.session, this.received++));
    if (response.id !== id) { this.close(); throw new Error('The browser response did not match the current call.'); }
    if (response.kind === 'error') throw new AgentRemoteError(response.code, response.message);
    return response.output;
  }
}
