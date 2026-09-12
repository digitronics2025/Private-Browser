import * as vscode from 'vscode';
import { BridgeClient } from './bridge-client.js';
import { ProjectService } from './project-service.js';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  status.command = 'privateBrowser.showStatus'; status.name = 'Private Browser Bridge'; status.text = '$(debug-disconnect) Private Browser'; status.tooltip = 'Private Browser is disconnected'; status.show();
  let state: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected'; let detail = '';
  let client: BridgeClient;
  const service = new ProjectService(context, (event, payload) => { void client?.notify(event as never, payload); });
  client = new BridgeClient(context, (method, payload) => service.handle(method, payload), (next, nextDetail) => {
    state = next; detail = nextDetail ?? '';
    status.text = next === 'connected' ? '$(link) Private Browser' : next === 'connecting' ? '$(sync~spin) Private Browser' : next === 'error' ? '$(error) Private Browser' : '$(debug-disconnect) Private Browser';
    status.tooltip = next === 'connected' ? `Connected. ${detail}` : detail || 'Private Browser is disconnected';
  });

  context.subscriptions.push(status, client,
    vscode.commands.registerCommand('privateBrowser.pair', async () => {
      const code = await vscode.window.showInputBox({ title: 'Pair Private Browser', prompt: 'Enter the eight-digit code shown in Private Browser → Dev → Project.', placeHolder: '12345678', password: true, validateInput: (value) => /^\d{8}$/.test(value) ? undefined : 'Enter exactly eight digits.' });
      if (code) await client.pair(code).then(() => vscode.window.showInformationMessage('Private Browser paired securely.'));
    }),
    vscode.commands.registerCommand('privateBrowser.reconnect', () => client.reconnect()),
    vscode.commands.registerCommand('privateBrowser.disconnect', () => client.disconnect(false)),
    vscode.commands.registerCommand('privateBrowser.revoke', async () => {
      const answer = await vscode.window.showWarningMessage('Disconnect and revoke Private Browser pairing?', { modal: true }, 'Revoke');
      if (answer === 'Revoke') await client.disconnect(true);
    }),
    vscode.commands.registerCommand('privateBrowser.showStatus', () => vscode.window.showInformationMessage(`Private Browser Bridge: ${state}${detail ? ` — ${detail}` : ''}`)),
    vscode.window.onDidChangeActiveTextEditor((editor) => void client.notify('active-editor', editor?.document.uri.scheme === 'file' ? { path: editor.document.uri.fsPath, line: editor.selection.active.line + 1, column: editor.selection.active.character + 1 } : {})),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void client.notify('status', { workspaceChanged: true })),
    vscode.workspace.onDidGrantWorkspaceTrust(() => void client.notify('status', { trusted: true })),
  );
  await client.start();
}

export function deactivate(): void {}
