import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { AGENT_UNTRUSTED, agentTools, isAgentMethod, type AgentMethod } from '@private-browser/bridge-protocol/agent';
import { z } from 'zod';

export function describeAgentTools(): Tool[] {
  return Object.entries(agentTools).map(([name, { description, input }]) => ({
    name,
    description: `${description} ${AGENT_UNTRUSTED}`,
    inputSchema: z.toJSONSchema(input, { io: 'input' }) as Tool['inputSchema'],
  }));
}

type Request = (method: AgentMethod, input: unknown, signal: AbortSignal) => Promise<unknown>;

export async function invokeAgentTool(name: string, input: unknown, signal: AbortSignal, request: Request): Promise<CallToolResult> {
  if (!isAgentMethod(name)) return failure('Unknown Private Browser tool.');
  const valid = agentTools[name].input.safeParse(input ?? {});
  if (!valid.success) return failure('Invalid arguments. Check the tool schema.');
  try {
    const result = await request(name, valid.data, signal);
    const image = (result as { untrusted_page_content?: { jpeg?: unknown } } | null)?.untrusted_page_content?.jpeg;
    if (name === 'screenshot' && typeof image === 'string') {
      return {
        content: [
          { type: 'text', text: JSON.stringify({ untrusted_page_content: AGENT_UNTRUSTED }) },
          { type: 'image', mimeType: 'image/jpeg', data: image },
        ],
      };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
  } catch (error) {
    return failure(error instanceof Error ? error.message : 'The browser could not complete the tool call.');
  }
}

function failure(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

export async function runAgentStdio(request: Request, onClose: () => void): Promise<void> {
  const server = new Server(
    { name: 'private-browser-mcp', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: AGENT_UNTRUSTED },
  );
  server.onclose = onClose;
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: describeAgentTools() }));
  server.setRequestHandler(CallToolRequestSchema, ({ params }, { signal }) => invokeAgentTool(params.name, params.arguments, signal, request));
  await server.connect(new StdioServerTransport());
}
