import { randomUUID } from 'node:crypto';
import { createServer, connect } from 'node:net';
import { describe, expect, it } from 'vitest';
import { FrameDecoder, encodeFrame } from './index.js';

describe('Windows named-pipe transport', () => {
  const run = process.platform === 'win32' ? it : it.skip;

  run('exchanges framed messages without opening a TCP listener', async () => {
    const path = `\\\\.\\pipe\\private-browser-test-${randomUUID()}`;
    const server = createServer((socket) => {
      const decoder = new FrameDecoder();
      socket.on('data', (chunk) => {
        const [message] = decoder.push(chunk);
        socket.end(encodeFrame({ received: message }));
      });
    });
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(path, resolve));
    const reply = await new Promise<unknown>((resolve, reject) => {
      const decoder = new FrameDecoder();
      const socket = connect(path, () => socket.write(encodeFrame({ hello: 'owner-local' })));
      socket.once('error', reject);
      socket.on('data', (chunk) => { const [message] = decoder.push(chunk); if (message) resolve(message); });
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(reply).toEqual({ received: { hello: 'owner-local' } });
  });
});
