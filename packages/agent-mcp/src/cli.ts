#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import { AGENT_PROTOCOL_VERSION, AGENT_DISABLED, type AgentMethod } from '@private-browser/bridge-protocol/agent';
import { agentDataRoot } from '@private-browser/bridge-protocol/agent-location';
import { AgentClient, readAgentRendezvous } from './client.js';
import { createAgentIdentity, loadAgentIdentity, saveAgentIdentity } from './identity.js';
import { runAgentStdio } from './server.js';

const profiles = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
};
const root = process.env.PRIVATE_BROWSER_AGENT_DATA_DIR ?? join(agentDataRoot());

function argumentsForCli() {
  const args = process.argv.slice(2);
  const command = args.length && !args[0].startsWith('--') ? args.shift() : 'serve';
  let client = 'codex';
  if (args.length === 2 && args[0] === '--client') client = args[1];
  else if (args.length) throw new Error('Usage: private-browser-mcp [pair|doctor] --client codex|claude-code');
  if (!Object.hasOwn(profiles, client)) throw new Error('Choose --client codex or --client claude-code.');
  return { command, client, name: profiles[client as keyof typeof profiles] };
}

async function pairingCode(): Promise<string> {
  process.stderr.write('Enter the eight-digit code from Settings → Agents: ');
  if (!process.stdin.isTTY) {
    const terminal = createInterface({ input: process.stdin, terminal: false });
    try {
      for await (const line of terminal) return line.trim();
      throw new Error('Enter a pairing code.');
    } finally { terminal.close(); }
  }
  const stdin = process.stdin;
  let result = '';
  stdin.setRawMode(true);
  try {
    return await new Promise<string>((resolve, reject) => {
      const onData = (data: Buffer) => {
        for (const char of data.toString()) {
          if (char === '\u0003' || char === '\r' || char === '\n') {
            stdin.off('data', onData);
            if (char === '\u0003') reject(new Error('Pairing cancelled.'));
            else resolve(result);
            return;
          }
          if (char === '\b' || char === '\u007f') result = result.slice(0, -1);
          else if (/^\d$/.test(char) && result.length < 8) result += char;
        }
      };
      stdin.on('data', onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    process.stderr.write('\n');
  }
}

async function main() {
  const { command, client, name } = argumentsForCli();
  if (command === 'pair') {
    await readAgentRendezvous(root);
    const code = await pairingCode();
    if (!/^\d{8}$/.test(code)) throw new Error('Enter the eight digits shown in Private Browser.');
    const identity = createAgentIdentity();
    const connection = await AgentClient.connect(root, name, identity, code);
    try { await saveAgentIdentity(root, client, { ...identity, browserFingerprint: connection.fingerprint }); }
    finally { connection.close(); }
    process.stdout.write(`Paired ${name} with Private Browser.\n`);
    return;
  }
  if (command === 'doctor') {
    process.stdout.write(`Private Browser Agent protocol ${AGENT_PROTOCOL_VERSION}\n`);
    await readAgentRendezvous(root);
    const identity = await loadAgentIdentity(root, client);
    if (!identity) throw new Error(`Generate a code in Settings → Agents, then run private-browser-mcp pair --client ${client}.`);
    const connection = await AgentClient.connect(root, name, identity);
    try { process.stdout.write(JSON.stringify(await connection.request('browser_status', {}), null, 2) + '\n'); }
    finally { connection.close(); }
    return;
  }
  if (command !== 'serve') throw new Error('Usage: private-browser-mcp [pair|doctor] --client codex|claude-code');
  let connection: AgentClient | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const request = (method: AgentMethod, input: unknown, signal: AbortSignal) => {
    const run = queue.then(async () => {
      signal.throwIfAborted();
      const cancel = () => connection?.close();
      signal.addEventListener('abort', cancel, { once: true });
      try {
        if (!connection || connection.closed) {
          await readAgentRendezvous(root);
          const identity = await loadAgentIdentity(root, client);
          if (!identity) throw new Error(`Pair this client first with private-browser-mcp pair --client ${client}.`);
          signal.throwIfAborted();
          connection = await AgentClient.connect(root, name, identity);
        }
        signal.throwIfAborted();
        return await connection.request(method, input);
      } finally { signal.removeEventListener('abort', cancel); }
    });
    queue = run.catch(() => undefined);
    return run;
  };
  await runAgentStdio(request, () => connection?.close());
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error && error.name === 'Error' ? error.message : AGENT_DISABLED}\n`);
  process.exitCode = 1;
});
