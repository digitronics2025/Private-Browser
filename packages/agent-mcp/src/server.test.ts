import { describe, expect, it, vi } from 'vitest';
import { AGENT_DISABLED, AGENT_UNTRUSTED, agentTools } from '@private-browser/bridge-protocol/agent';
import { describeAgentTools, invokeAgentTool } from './server.js';
import { readAgentRendezvous } from './client.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

describe('Private Browser MCP stdio surface', () => {
  it('lists only typed tools with the untrusted-content instruction', () => {
    const tools = describeAgentTools();
    expect(tools.map(({ name }) => name)).toEqual(Object.keys(agentTools));
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.description).toContain(AGENT_UNTRUSTED);
    }
  });

  it('validates input before contacting the browser and maps remote errors', async () => {
    const request = vi.fn().mockRejectedValue(new Error(AGENT_DISABLED));
    const signal = new AbortController().signal;
    expect(await invokeAgentTool('click', { ref: 'e1', confirm: true }, signal, request)).toMatchObject({ isError: true });
    expect(request).not.toHaveBeenCalled();
    expect(await invokeAgentTool('snapshot', {}, signal, request)).toMatchObject({
      isError: true, content: [{ type: 'text', text: AGENT_DISABLED }],
    });
  });

  it('tells the owner how to enable Agent Mode when no pipe exists', async () => {
    await expect(readAgentRendezvous(join(tmpdir(), randomUUID()))).rejects.toThrow(AGENT_DISABLED);
  });
});
