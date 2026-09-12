import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FrameDecoder, MAX_FRAME_BYTES, PROTOCOL_VERSION, bridgeStatusSchema, chunkEnvelopeSchema, deriveSessionKey, encodeFrame, generateEphemeralKeyPair, generateIdentity, helloSchema, openMessage, progressEnvelopeSchema, sealMessage, signText, testReportSchema, verifyText, type BridgeRequest } from './index.js';

describe('bridge protocol', () => {
  it('signs identities and derives the same ephemeral session key', () => {
    const identity = generateIdentity();
    const signature = signText(identity.privateKey, 'challenge');
    expect(verifyText(identity.publicKey, 'challenge', signature)).toBe(true);
    expect(verifyText(identity.publicKey, 'changed', signature)).toBe(false);
    const client = generateEphemeralKeyPair(); const server = generateEphemeralKeyPair();
    const clientKey = deriveSessionKey({ privateKey: client.privateKey, peerPublicKey: server.publicKey, challenge: 'test-challenge-1234', pairingCode: '12345678' });
    const serverKey = deriveSessionKey({ privateKey: server.privateKey, peerPublicKey: client.publicKey, challenge: 'test-challenge-1234', pairingCode: '12345678' });
    expect(clientKey.equals(serverKey)).toBe(true);
  });

  it('encrypts messages and rejects replayed sequence numbers', () => {
    const key = Buffer.alloc(32, 7); const sessionId = randomUUID();
    const message: BridgeRequest = { version: PROTOCOL_VERSION, kind: 'request', id: randomUUID(), method: 'project.list', payload: {} };
    const frame = sealMessage(key, sessionId, 0, message);
    expect(openMessage(key, frame, sessionId, 0)).toEqual(message);
    expect(() => openMessage(key, frame, sessionId, 1)).toThrow(/replay|ordering/i);
  });

  it('decodes split frames and rejects oversized frames', () => {
    const encoded = encodeFrame({ ok: true }); const decoder = new FrameDecoder();
    expect(decoder.push(encoded.subarray(0, 3))).toEqual([]);
    expect(decoder.push(encoded.subarray(3))).toEqual([{ ok: true }]);
    const oversized = Buffer.alloc(4); oversized.writeUInt32BE(MAX_FRAME_BYTES + 1);
    expect(() => new FrameDecoder().push(oversized)).toThrow(/size/i);
  });

  it('rejects ciphertext tampering and malformed negotiation envelopes', () => {
    const key = Buffer.alloc(32, 9); const sessionId = randomUUID();
    const message: BridgeRequest = { version: PROTOCOL_VERSION, kind: 'request', id: randomUUID(), method: 'connection.heartbeat', payload: {} };
    const frame = sealMessage(key, sessionId, 0, message);
    frame.ciphertext = `${frame.ciphertext.slice(0, -2)}AA`;
    expect(() => openMessage(key, frame, sessionId, 0)).toThrow();
    expect(() => helloSchema.parse({ kind: 'hello', minVersion: 0 })).toThrow();
  });

  it('bounds status and report schemas', () => {
    expect(() => bridgeStatusSchema.parse({ state: 'connected', browserVersion: 'x'.repeat(51) })).toThrow();
    expect(() => testReportSchema.parse({ id: randomUUID(), projectId: 'project-1', kind: 'quick', status: 'passed', title: 'ok', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), summary: 'ok', findings: [], artifacts: [{ id: randomUUID(), name: 'huge', kind: 'trace', size: 11 * 1024 * 1024 }] })).toThrow();
    expect(() => testReportSchema.parse({ id: randomUUID(), projectId: 'project-1', kind: 'quick', status: 'passed', title: 'ok', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), summary: 'ok', findings: [], artifacts: [{ id: randomUUID(), name: '../secret', kind: 'test', size: 10 }] })).toThrow();
  });

  it('validates progress and bounded chunk envelopes', () => {
    const base = { version: PROTOCOL_VERSION, id: randomUUID(), requestId: randomUUID() };
    expect(progressEnvelopeSchema.parse({ ...base, kind: 'progress', progress: 0.5, message: 'Running' }).progress).toBe(0.5);
    expect(() => chunkEnvelopeSchema.parse({ ...base, kind: 'chunk', artifactId: randomUUID(), index: 0, total: 1, totalBytes: 11 * 1024 * 1024, data: 'x' })).toThrow();
  });
});
