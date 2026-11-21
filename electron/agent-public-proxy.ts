import { lookup } from 'node:dns/promises';
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { BlockList, createConnection, isIP, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { Session } from 'electron';

const v4Private = new BlockList();
for (const [network, length] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) v4Private.addSubnet(network, length);
const v6Global = new BlockList();
v6Global.addSubnet('2000::', 3, 'ipv6');
const v6Special = new BlockList();
for (const [network, length] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  v6Special.addSubnet(network, length, 'ipv6');
}

export function isPublicAgentAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !v4Private.check(address);
  return family === 6 && !address.includes('%')
    && v6Global.check(address, 'ipv6') && !v6Special.check(address, 'ipv6');
}

async function publicPeer(url: URL) {
  const hostname = url.hostname.replace(/^\[|\]$/gu, '');
  if (!hostname || url.username || url.password || (!hostname.includes('.') && !isIP(hostname))) throw new Error('Private destination');
  const answers = await lookup(hostname, { all: true });
  if (!answers.length || answers.some(({ address }) => !isPublicAgentAddress(address))) throw new Error('Private destination');
  return answers.find(({ family }) => family === 4) ?? answers[0];
}

function endToEnd(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const connectionHeaders = new Set((headers.connection ?? '').toLowerCase().split(',').map((name) => name.trim()));
  return Object.fromEntries(Object.entries(headers).filter(([key]) =>
    !connectionHeaders.has(key) && !['connection', 'proxy-authorization', 'proxy-authenticate', 'proxy-connection', 'keep-alive',
      'te', 'trailer', 'transfer-encoding', 'upgrade'].includes(key)));
}

async function forward(incoming: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(incoming.url ?? '');
  if (url.protocol !== 'http:') throw new Error('Unsupported proxy route');
  const peer = await publicPeer(url);
  if (incoming.destroyed || response.destroyed) return;
  const outbound = request({
    host: peer.address, port: url.port || 80, family: peer.family, method: incoming.method,
    path: url.pathname + url.search, headers: { ...endToEnd(incoming.headers), host: url.host }, agent: false,
  }, (received) => {
    response.writeHead(received.statusCode ?? 502, endToEnd(received.headers));
    received.on('error', () => response.destroy());
    received.pipe(response);
  });
  outbound.setTimeout(30_000, () => outbound.destroy());
  outbound.on('error', () => { if (response.headersSent) response.destroy(); else response.writeHead(502).end(); });
  response.once('close', () => outbound.destroy());
  incoming.pipe(outbound);
}

async function tunnel(incoming: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  socket.on('error', () => socket.destroy());
  const authority = incoming.url ?? '';
  if (!/^(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+):[0-9]{1,5}$/iu.test(authority)) throw new Error('Unsupported tunnel');
  const url = new URL('https://' + authority);
  const peer = await publicPeer(url);
  if (socket.destroyed) return;
  const destination = createConnection({ host: peer.address, family: peer.family, port: Number(url.port || 443) });
  const finish = () => { destination.destroy(); socket.destroy(); };
  socket.once('close', finish);
  destination.once('error', finish);
  destination.once('close', finish);
  destination.setTimeout(90_000, finish);
  destination.once('connect', () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) destination.write(head);
    socket.pipe(destination).pipe(socket);
  });
}

export class AgentPublicProxy {
  private server?: Server;
  private listening?: Promise<number>;
  private readonly connections = new Set<Socket>();

  async restrict(session: Session): Promise<void> {
    const port = await (this.listening ??= this.start());
    const proxyRules = '127.0.0.1:' + port;
    await session.setProxy({ mode: 'fixed_servers', proxyRules, proxyBypassRules: '<-loopback>' });
    await session.closeAllConnections();
    if (await session.resolveProxy('http://127.0.0.1/') !== 'PROXY ' + proxyRules
      || await session.resolveProxy('https://example.com/') !== 'PROXY ' + proxyRules) throw new Error('Public route unavailable');
  }

  close(): void {
    this.server?.close();
    for (const socket of this.connections) socket.destroy();
  }

  private async start(): Promise<number> {
    const server = createServer({ headersTimeout: 8_000, requestTimeout: 30_000 }, (incoming, response) => {
      void forward(incoming, response).catch(() => response.destroy());
    });
    this.server = server;
    server.maxConnections = 96;
    server.on('connection', (socket) => {
      this.connections.add(socket);
      socket.setTimeout(90_000, () => socket.destroy());
      socket.once('close', () => this.connections.delete(socket));
    });
    server.on('connect', (incoming, socket, head) => {
      void tunnel(incoming, socket, head).catch(() => socket.destroy());
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    server.on('error', () => this.close());
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Public route unavailable');
    return address.port;
  }
}
