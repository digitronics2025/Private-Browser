import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto';
import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;
export const MIN_PROTOCOL_VERSION = 1 as const;
export const MAX_FRAME_BYTES = 256 * 1024;
export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
export const MAX_TASK_OUTPUT_BYTES = 1024 * 1024;
export const SESSION_TTL_MS = 15 * 60_000;
export const PAIRING_TTL_MS = 5 * 60_000;

export const bridgeMethodSchema = z.enum([
  'connection.status', 'connection.heartbeat', 'connection.disconnect', 'connection.revoke',
  'project.list', 'project.authorize', 'project.inspect', 'project.open', 'source.open',
  'server.discover', 'server.start', 'server.stop', 'server.restart',
  'inspect.page', 'inspect.open-source',
  'test.run', 'test.cancel', 'test.rerun', 'test.save-artifact',
  'ai.handoff', 'ai.apply-edits',
  'reports.list', 'reports.get', 'reports.delete', 'reports.clear', 'reports.open', 'reports.retention',
]);
export type BridgeMethod = z.infer<typeof bridgeMethodSchema>;

export const projectSummarySchema = z.object({
  id: z.string().min(8).max(128), name: z.string().min(1).max(200), path: z.string().min(1).max(2_000),
  trusted: z.boolean(), authorized: z.boolean(),
}).strict();
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

export const commandSpecSchema = z.object({
  id: z.string().min(1).max(120), label: z.string().min(1).max(200), executable: z.string().min(1).max(1_000),
  args: z.array(z.string().max(2_000)).max(30), cwd: z.string().min(1).max(2_000),
  source: z.enum(['package.json', 'wrangler', 'electron', 'gradle', 'playwright']), fingerprint: z.string().length(64),
  category: z.enum(['dev', 'typecheck', 'lint', 'test', 'build', 'security', 'package']),
}).strict();
export type CommandSpec = z.infer<typeof commandSpecSchema>;

export const projectInfoSchema = z.object({
  project: projectSummarySchema,
  types: z.array(z.enum(['vite-react', 'node', 'pwa', 'electron', 'cloudflare-worker', 'wordpress', 'android'])),
  framework: z.string().max(100), packageManager: z.enum(['npm', 'pnpm', 'yarn', 'bun', 'gradle', 'unknown']),
  commands: z.array(commandSpecSchema).max(50), devServerUrl: z.string().url().optional(),
  activeFile: z.string().max(2_000).optional(), guidance: z.array(z.string().max(500)).max(20),
}).strict();
export type ProjectInfo = z.infer<typeof projectInfoSchema>;

export const reportStatusSchema = z.enum(['passed', 'attention', 'failed', 'skipped']);
export const testKindSchema = z.enum(['quick', 'everything', 'current-page', 'live-site', 'compare', 'responsive', 'accessibility', 'performance', 'record-flow']);
export type TestKind = z.infer<typeof testKindSchema>;
export const reportFindingSchema = z.object({
  status: reportStatusSchema, title: z.string().max(300), cause: z.string().max(2_000), evidence: z.string().max(8_000),
  location: z.string().max(2_000).optional(), recommendation: z.string().max(2_000),
}).strict();
export const testReportSchema = z.object({
  id: z.string().uuid(), projectId: z.string().min(8).max(128), kind: testKindSchema, status: reportStatusSchema,
  title: z.string().max(300), startedAt: z.string().datetime(), finishedAt: z.string().datetime(),
  summary: z.string().max(4_000), findings: z.array(reportFindingSchema).max(200),
  artifacts: z.array(z.object({ id: z.string().uuid(), name: z.string().min(1).max(300).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/), kind: z.enum(['screenshot', 'trace', 'diff', 'test', 'log']), size: z.number().int().nonnegative().max(MAX_ARTIFACT_BYTES) }).strict()).max(100),
}).strict();
export type TestReport = z.infer<typeof testReportSchema>;

export const bridgeStatusSchema = z.object({
  state: z.enum(['disconnected', 'pairing', 'connected', 'incompatible', 'error']), browserVersion: z.string().max(50),
  extensionVersion: z.string().max(50).optional(), vscodeVersion: z.string().max(50).optional(),
  instanceId: z.string().uuid().optional(), pairingCode: z.string().regex(/^\d{8}$/).optional(), pairingExpiresAt: z.number().int().positive().optional(),
  sessionExpiresAt: z.number().int().positive().optional(), project: projectInfoSchema.optional(), activity: z.string().max(300).optional(),
  error: z.string().max(2_000).optional(),
}).strict();
export type BridgeStatus = z.infer<typeof bridgeStatusSchema>;

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.null(), z.string(), z.number().finite(), z.boolean(),
  z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema),
]));

export const requestSchema = z.object({
  version: z.literal(PROTOCOL_VERSION), kind: z.literal('request'), id: z.string().uuid(),
  method: bridgeMethodSchema, payload: jsonValueSchema,
}).strict();
export const responseSchema = z.object({
  version: z.literal(PROTOCOL_VERSION), kind: z.literal('response'), id: z.string().uuid(), ok: z.boolean(),
  payload: jsonValueSchema.optional(),
  error: z.object({ code: z.string().max(80), message: z.string().max(2_000) }).strict().optional(),
}).strict();
export const eventSchema = z.object({
  version: z.literal(PROTOCOL_VERSION), kind: z.literal('event'), id: z.string().uuid(),
  event: z.enum(['status', 'activity', 'task.progress', 'task.complete', 'active-editor']), payload: jsonValueSchema,
}).strict();

export const errorEnvelopeSchema = z.object({
  version: z.literal(PROTOCOL_VERSION), kind: z.literal('error'), id: z.string().uuid(),
  requestId: z.string().uuid().optional(), code: z.string().min(1).max(80), message: z.string().min(1).max(2_000),
}).strict();
export const progressEnvelopeSchema = z.object({
  version: z.literal(PROTOCOL_VERSION), kind: z.literal('progress'), id: z.string().uuid(), requestId: z.string().uuid(),
  progress: z.number().min(0).max(1), message: z.string().max(2_000),
}).strict();
export const chunkEnvelopeSchema = z.object({
  version: z.literal(PROTOCOL_VERSION), kind: z.literal('chunk'), id: z.string().uuid(), requestId: z.string().uuid(), artifactId: z.string().uuid(),
  index: z.number().int().nonnegative(), total: z.number().int().positive().max(10_000), totalBytes: z.number().int().nonnegative().max(MAX_ARTIFACT_BYTES),
  data: z.string().max(MAX_FRAME_BYTES),
}).strict();

export type BridgeRequest = z.infer<typeof requestSchema>;
export type BridgeResponse = z.infer<typeof responseSchema>;
export type BridgeEvent = z.infer<typeof eventSchema>;
export type BridgeErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
export type BridgeProgress = z.infer<typeof progressEnvelopeSchema>;
export type BridgeChunk = z.infer<typeof chunkEnvelopeSchema>;
export type BridgeMessage = BridgeRequest | BridgeResponse | BridgeEvent | BridgeErrorEnvelope | BridgeProgress | BridgeChunk;

export const helloSchema = z.object({
  kind: z.literal('hello'), minVersion: z.literal(MIN_PROTOCOL_VERSION), maxVersion: z.literal(PROTOCOL_VERSION),
  deviceId: z.string().uuid(), instanceId: z.string().uuid(), vscodeVersion: z.string().min(1).max(50),
  extensionVersion: z.string().min(1).max(50), identityPublicKey: z.string().min(40).max(2_000),
  ephemeralPublicKey: z.string().min(40).max(2_000), challenge: z.string().min(16).max(200),
  pairingCode: z.string().regex(/^\d{8}$/).optional(), signature: z.string().min(40).max(2_000),
}).strict();
export type ClientHello = z.infer<typeof helloSchema>;

export const welcomeSchema = z.object({
  kind: z.literal('welcome'), version: z.literal(PROTOCOL_VERSION), sessionId: z.string().uuid(),
  expiresAt: z.number().int().positive(), browserVersion: z.string().min(1).max(50),
  browserIdentityPublicKey: z.string().min(40).max(2_000), ephemeralPublicKey: z.string().min(40).max(2_000),
  signature: z.string().min(40).max(2_000),
}).strict();
export type ServerWelcome = z.infer<typeof welcomeSchema>;

export const secureFrameSchema = z.object({
  sessionId: z.string().uuid(), sequence: z.number().int().nonnegative(), nonce: z.string().regex(/^[a-f\d]{24}$/),
  ciphertext: z.string().min(1), tag: z.string().regex(/^[a-f\d]{32}$/),
}).strict();
export type SecureFrame = z.infer<typeof secureFrameSchema>;

export interface DeviceIdentity { publicKey: string; privateKey: string; }
export interface EphemeralKeyPair { publicKey: string; privateKey: KeyObject; }

export function generateIdentity(): DeviceIdentity {
  const pair = generateKeyPairSync('ed25519');
  return {
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

export function generateEphemeralKeyPair(): EphemeralKeyPair {
  const pair = generateKeyPairSync('x25519');
  return { publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey: pair.privateKey };
}

export function signText(privateKey: string | KeyObject, value: string): string {
  return sign(null, Buffer.from(value), privateKey).toString('base64');
}
export function verifyText(publicKey: string | KeyObject, value: string, signatureValue: string): boolean {
  try { return verify(null, Buffer.from(value), publicKey, Buffer.from(signatureValue, 'base64')); } catch { return false; }
}
export function helloTranscript(input: Omit<ClientHello, 'signature'>): string { return stableStringify(input); }
export function welcomeTranscript(hello: ClientHello, welcome: Omit<ServerWelcome, 'signature'>): string {
  const { signature: _signature, ...unsignedHello } = hello;
  return `${helloTranscript(unsignedHello)}\n${stableStringify(welcome)}`;
}

export function deriveSessionKey(input: { privateKey: KeyObject; peerPublicKey: string; challenge: string; pairingCode?: string }): Buffer {
  const secret = diffieHellman({ privateKey: input.privateKey, publicKey: createPublicKey(input.peerPublicKey) });
  return Buffer.from(hkdfSync('sha256', secret, Buffer.from(input.challenge), Buffer.from(`private-browser-bridge:${input.pairingCode ?? 'reconnect'}`), 32));
}

export function sealMessage(key: Buffer, sessionId: string, sequence: number, message: BridgeMessage): SecureFrame {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(`${sessionId}:${sequence}`));
  const plaintext = Buffer.from(JSON.stringify(message));
  if (plaintext.byteLength > MAX_FRAME_BYTES) throw new Error('Bridge message exceeds the frame limit');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { sessionId, sequence, nonce: nonce.toString('hex'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('hex') };
}

export function openMessage(key: Buffer, frameValue: unknown, expectedSessionId: string, expectedSequence: number): BridgeMessage {
  const frame = secureFrameSchema.parse(frameValue);
  if (frame.sessionId !== expectedSessionId || frame.sequence !== expectedSequence) throw new Error('Bridge frame replay or ordering violation');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(frame.nonce, 'hex'));
  decipher.setAAD(Buffer.from(`${frame.sessionId}:${frame.sequence}`));
  decipher.setAuthTag(Buffer.from(frame.tag, 'hex'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(frame.ciphertext, 'base64')), decipher.final()]);
  if (plaintext.byteLength > MAX_FRAME_BYTES) throw new Error('Bridge message exceeds the frame limit');
  const value = JSON.parse(plaintext.toString('utf8')) as unknown;
  const kind = z.object({ kind: z.string() }).parse(value).kind;
  if (kind === 'request') return requestSchema.parse(value);
  if (kind === 'response') return responseSchema.parse(value);
  if (kind === 'event') return eventSchema.parse(value);
  if (kind === 'error') return errorEnvelopeSchema.parse(value);
  if (kind === 'progress') return progressEnvelopeSchema.parse(value);
  return chunkEnvelopeSchema.parse(value);
}

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  if (body.byteLength > MAX_FRAME_BYTES) throw new Error('Bridge frame is too large');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.byteLength);
  return Buffer.concat([header, body]);
}

export class FrameDecoder {
  private pending = Buffer.alloc(0);
  push(chunk: Buffer): unknown[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const frames: unknown[] = [];
    while (this.pending.length >= 4) {
      const size = this.pending.readUInt32BE(0);
      if (size <= 0 || size > MAX_FRAME_BYTES) throw new Error('Invalid bridge frame size');
      if (this.pending.length < size + 4) break;
      frames.push(JSON.parse(this.pending.subarray(4, size + 4).toString('utf8')) as unknown);
      this.pending = this.pending.subarray(size + 4);
    }
    return frames;
  }
}

export function fingerprint(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function pairingProof(code: string, transcript: string): string { return createHmac('sha256', code).update(transcript).digest('hex'); }
export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}
export function sanitizeError(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : 'Bridge request failed';
  return { code: 'BRIDGE_ERROR', message: message.replace(/[\r\n\t]+/g, ' ').slice(0, 2_000) };
}
