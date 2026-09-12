import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';

const MAX_CALLBACK_URL_LENGTH = 8192;
const MAX_CODE_LENGTH = 4096;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export interface OAuthLoopbackResult {
  code: string;
}

export class OAuthLoopbackReceiver {
  private server?: Server;
  private consumed = false;
  private rejectPending?: (error: Error) => void;
  private timer?: NodeJS.Timeout;
  private callbackPromise?: Promise<OAuthLoopbackResult>;
  private callbackPath = '';
  private expectedState = '';
  private port = 0;

  async start(expectedState: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
    if (this.server) throw new Error('OAuth callback receiver is already active');
    if (!expectedState || expectedState.length > 512) throw new Error('Invalid OAuth state');
    this.expectedState = expectedState;
    this.callbackPath = `/oauth/callback/${randomBytes(24).toString('base64url')}`;
    this.server = createServer();
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('OAuth loopback listener did not bind a TCP port');
    this.port = address.port;
    this.callbackPromise = new Promise<OAuthLoopbackResult>((resolve, reject) => {
      this.rejectPending = reject;
      this.server!.on('request', (request, response) => {
        void this.handleRequest(request, response, resolve, reject);
      });
    });
    this.timer = setTimeout(() => this.cancel(new Error('Google authorization timed out')), timeoutMs);
    this.timer.unref();
    return `http://127.0.0.1:${this.port}${this.callbackPath}`;
  }

  wait(): Promise<OAuthLoopbackResult> {
    if (!this.callbackPromise) throw new Error('OAuth callback receiver has not started');
    return this.callbackPromise;
  }

  cancel(error = new Error('Google authorization was cancelled')): void {
    if (this.consumed) return;
    this.consumed = true;
    this.close();
    this.rejectPending?.(error);
  }

  private async handleRequest(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
    resolve: (result: OAuthLoopbackResult) => void,
    reject: (error: Error) => void,
  ): Promise<void> {
    if (this.consumed) {
      response.writeHead(410).end('Authorization callback already used.');
      return;
    }
    const remoteAddress = request.socket.remoteAddress?.replace(/^::ffff:/, '');
    const exactHost = `127.0.0.1:${this.port}`;
    let callbackUrl: URL;
    try {
      if (request.method !== 'GET' || request.url === undefined || request.url.length > MAX_CALLBACK_URL_LENGTH
        || request.headers.host !== exactHost || remoteAddress !== '127.0.0.1') throw new Error('Invalid OAuth callback origin');
      callbackUrl = new URL(request.url, `http://${exactHost}`);
      if (callbackUrl.pathname !== this.callbackPath) throw new Error('Invalid OAuth callback path');
      if (callbackUrl.searchParams.get('state') !== this.expectedState) throw new Error('Invalid OAuth callback state');
      const providerError = callbackUrl.searchParams.get('error');
      if (providerError) throw new Error(providerError === 'access_denied' ? 'Google authorization was cancelled' : 'Google authorization failed');
      const code = callbackUrl.searchParams.get('code');
      if (!code || code.length > MAX_CODE_LENGTH) throw new Error('Invalid OAuth authorization code');
      this.consumed = true;
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      }).end('<!doctype html><title>Private Browser connected</title><p>You may close this window and return to Private Browser.</p>');
      await this.close();
      resolve({ code });
    } catch (error) {
      this.consumed = true;
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('Invalid authorization callback.');
      await this.close();
      reject(error instanceof Error ? error : new Error('Invalid OAuth callback'));
    }
  }

  private close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    const server = this.server;
    this.server = undefined;
    if (!server?.listening) return Promise.resolve();
    return new Promise((resolve) => server.close(() => resolve()));
  }
}

export function createPkceMaterial(): { verifier: string; challenge: string; state: string; nonce: string } {
  const verifier = randomBytes(64).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return {
    verifier,
    challenge,
    state: randomBytes(32).toString('base64url'),
    nonce: randomBytes(32).toString('base64url'),
  };
}
