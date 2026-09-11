import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../vscode-extension/package.json', import.meta.url), 'utf8'));
const extensionSource = readFileSync(new URL('../vscode-extension/src/extension.ts', import.meta.url), 'utf8');
const mcpSource = readFileSync(new URL('../vscode-extension/src/mcp-server.ts', import.meta.url), 'utf8');

describe('VS Code companion packaging and security', () => {
  it('registers a local MCP provider and resolves its credential from SecretStorage', () => {
    expect(manifest.contributes.mcpServerDefinitionProviders).toContainEqual(expect.objectContaining({ id: 'private-browser-agent-tools' }));
    expect(extensionSource).toContain("context.secrets.get(TOKEN_KEY)");
    expect(extensionSource).toContain('McpStdioServerDefinition');
    expect(extensionSource).toContain('PRIVATE_BROWSER_AGENT_TOKEN');
  });

  it('exposes focused MCP tools and marks read-only operations accurately', () => {
    expect(mcpSource).toContain("name: 'private_browser_diagnostics'");
    expect(mcpSource).toContain("name: 'vscode_context'");
    expect(mcpSource).toContain("name: 'vscode_run_task'");
    expect(mcpSource).toContain('readOnlyHint: true');
    expect(mcpSource).toContain('readOnlyHint: false');
    expect(mcpSource).not.toContain('child_process');
  });
});
