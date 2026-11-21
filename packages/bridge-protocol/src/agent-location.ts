import { homedir } from 'node:os';
import { join } from 'node:path';

export function agentDataRoot(): string {
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Private Browser Agents');
  return join(homedir(), '.local', 'share', 'private-browser-agents');
}

export function isAgentPipeName(path: string): boolean {
  if (process.platform === 'win32') return /^\\\\\.\\pipe\\private-browser-agent-[a-f0-9-]{36}$/.test(path);
  return /^\/[^\0]*\/pb-agent-[a-zA-Z0-9]+\/agent\.sock$/.test(path);
}
