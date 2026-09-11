import * as vscode from 'vscode';
import { connect, type Socket } from 'node:net';
import { realpath } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const TOKEN_KEY = 'privateBrowser.agentBridge.token.v1';
const MAX_MESSAGE_BYTES = 256 * 1024;
const CAPABILITIES = ['editor.context', 'editor.open', 'editor.save', 'editor.task', 'editor.refresh'];

interface WireMessage {
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
  result?: any;
  error?: { message?: string };
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function endpoint(): string {
  if (process.platform === 'win32') return '\\\\.\\pipe\\private-browser-agent-v1';
  const user = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return resolve(tmpdir(), `private-browser-agent-${user}.sock`);
}

function safeText(value: unknown, max = 1_000): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}

function severityName(severity: vscode.DiagnosticSeverity): 'error' | 'warning' | 'information' | 'hint' {
  return severity === vscode.DiagnosticSeverity.Error ? 'error'
    : severity === vscode.DiagnosticSeverity.Warning ? 'warning'
      : severity === vscode.DiagnosticSeverity.Hint ? 'hint' : 'information';
}

async function safeWorkspaceFile(input: string): Promise<vscode.Uri> {
  if (!vscode.workspace.isTrusted) throw new Error('Trust the VS Code workspace first');
  const roots = vscode.workspace.workspaceFolders ?? [];
  if (!roots.length) throw new Error('Open a workspace folder first');
  for (const folder of roots) {
    const candidate = resolve(folder.uri.fsPath, input);
    try {
      const [rootPath, candidatePath] = await Promise.all([realpath(folder.uri.fsPath), realpath(candidate)]);
      const rel = relative(rootPath, candidatePath);
      if (rel && (rel.startsWith('..') || resolve(rootPath, rel) !== candidatePath)) continue;
      return vscode.Uri.file(candidatePath);
    } catch {
      // Missing and out-of-root paths are not valid open targets.
    }
  }
  throw new Error('Source location is outside the trusted workspace');
}

async function editorContext() {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const root = folders[0];
  const editor = vscode.window.activeTextEditor;
  const document = editor?.document;
  const documentFolder = document ? vscode.workspace.getWorkspaceFolder(document.uri) : undefined;
  const selected = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection).slice(0, 20_000) : undefined;
  const diagnostics = vscode.languages.getDiagnostics().flatMap(([uri, entries]) => {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return [];
    return entries.map((item) => ({
      severity: severityName(item.severity),
      message: safeText(item.message, 1_000),
      file: relative(folder.uri.fsPath, uri.fsPath),
      line: item.range.start.line + 1,
      ...(item.source ? { source: safeText(item.source, 100) } : {}),
    }));
  }).slice(0, 100);
  const tasks = (await vscode.tasks.fetchTasks()).map((task) => task.name).filter(Boolean).slice(0, 100);

  let git: { branch?: string; dirty: boolean; changedFiles: number } | undefined;
  try {
    const extension = vscode.extensions.getExtension('vscode.git')?.exports as { getAPI?: (version: number) => any } | undefined;
    const api = extension?.getAPI?.(1);
    const repository = api?.repositories?.find((candidate: any) => root && candidate.rootUri.fsPath === root.uri.fsPath) ?? api?.repositories?.[0];
    if (repository) {
      const state = repository.state;
      git = {
        ...(state.HEAD?.name ? { branch: safeText(state.HEAD.name, 200) } : {}),
        dirty: Boolean(state.workingTreeChanges?.length || state.indexChanges?.length || state.mergeChanges?.length),
        changedFiles: new Set([
          ...(state.workingTreeChanges ?? []).map((item: any) => item.uri?.fsPath),
          ...(state.indexChanges ?? []).map((item: any) => item.uri?.fsPath),
          ...(state.mergeChanges ?? []).map((item: any) => item.uri?.fsPath),
        ].filter(Boolean)).size,
      };
    }
  } catch {
    // Git is optional and must never stop the editor bridge.
  }

  return {
    workspaceTrusted: vscode.workspace.isTrusted,
    ...(vscode.workspace.name ? { workspaceName: safeText(vscode.workspace.name, 200) } : {}),
    ...(root ? { rootName: root.name, rootPath: root.uri.fsPath } : {}),
    ...(document && documentFolder ? {
      activeFile: {
        path: relative(documentFolder.uri.fsPath, document.uri.fsPath),
        absolutePath: document.uri.fsPath,
        language: document.languageId,
        ...(selected ? { selection: selected } : {}),
        line: (editor?.selection.active.line ?? 0) + 1,
      },
    } : {}),
    diagnostics,
    ...(git ? { git } : {}),
    tasks,
    capturedAt: new Date().toISOString(),
  };
}

class BridgeClient implements vscode.Disposable {
  private socket?: Socket;
  private buffer = '';
  private nextId = 0;
  private pending = new Map<string, PendingRequest>();
  private reconnectTimer?: NodeJS.Timeout;
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext, private readonly status: vscode.StatusBarItem) {}

  async start(): Promise<void> {
    const token = await this.context.secrets.get(TOKEN_KEY);
    if (!token) { this.setStatus('unpaired'); return; }
    await this.open(token, false);
  }

  async pair(code: string): Promise<void> {
    this.closeSocket();
    await this.open(undefined, true);
    const result = await this.request('pair', {
      code,
      name: vscode.env.appName,
      version: vscode.version,
      capabilities: CAPABILITIES,
    }) as { token?: string };
    if (!result.token) throw new Error('Private Browser did not issue a pairing credential');
    await this.context.secrets.store(TOKEN_KEY, result.token);
    this.setStatus('connected');
  }

  async reconnect(): Promise<void> {
    this.closeSocket();
    const token = await this.context.secrets.get(TOKEN_KEY);
    if (!token) throw new Error('Pair with Private Browser first');
    await this.open(token, false);
  }

  async disconnect(): Promise<void> {
    await this.context.secrets.delete(TOKEN_KEY);
    this.closeSocket();
    this.setStatus('unpaired');
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.closeSocket();
    this.status.dispose();
  }

  private async open(token: string | undefined, pairing: boolean): Promise<void> {
    if (this.disposed) return;
    this.setStatus('connecting');
    const socket = connect(endpoint());
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.receive(chunk.toString('utf8')));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      if (this.socket === socket) this.socket = undefined;
      this.rejectPending(new Error('Private Browser connection closed'));
      if (!pairing && !this.disposed) this.scheduleReconnect();
    });
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => { socket.destroy(); rejectPromise(new Error('Private Browser bridge was not found')); }, 5_000);
      socket.once('connect', () => { clearTimeout(timer); resolvePromise(); });
      socket.once('error', (error) => { clearTimeout(timer); rejectPromise(error); });
    });
    if (token) {
      await this.request('register', { name: vscode.env.appName, version: vscode.version, capabilities: CAPABILITIES }, token);
      this.setStatus('connected');
    }
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_MESSAGE_BYTES) { this.socket?.destroy(); return; }
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) void this.handleLine(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private async handleLine(line: string): Promise<void> {
    let message: WireMessage;
    try { message = JSON.parse(line) as WireMessage; } catch { return; }
    if (message.id && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(safeText(message.error.message, 500) || 'Private Browser request failed'));
      else pending.resolve(message.result);
      return;
    }
    if (!message.id || !message.method) return;
    try {
      let result: unknown;
      if (message.method === 'editor.getContext') result = await editorContext();
      else if (message.method === 'editor.openLocation') {
        const uri = await safeWorkspaceFile(safeText(message.params?.path, 4_096));
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document);
        const line = Math.max(0, Number(message.params?.line ?? 1) - 1);
        const position = new vscode.Position(Math.min(line, Math.max(0, document.lineCount - 1)), 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        result = {};
      } else if (message.method === 'editor.saveAll') {
        if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace first');
        await vscode.workspace.saveAll(false);
        result = {};
      } else if (message.method === 'editor.runTask') {
        if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace first');
        const name = safeText(message.params?.name, 200);
        const task = (await vscode.tasks.fetchTasks()).find((candidate) => candidate.name === name);
        if (!task) throw new Error('The requested named task does not exist');
        await vscode.tasks.executeTask(task);
        result = {};
      } else throw new Error('Unsupported Private Browser request');
      this.reply(message.id, result);
    } catch (error) {
      this.reply(message.id, undefined, error instanceof Error ? error.message : 'VS Code request failed');
    }
  }

  private request(method: string, params: unknown, token?: string): Promise<any> {
    if (!this.socket) return Promise.reject(new Error('Private Browser is not connected'));
    const id = `vscode-${++this.nextId}`;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => { this.pending.delete(id); rejectPromise(new Error('Private Browser did not respond')); }, 10_000);
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      this.socket!.write(`${JSON.stringify({ id, method, params, ...(token ? { token } : {}) })}\n`);
    });
  }

  private reply(id: string, result?: unknown, error?: string): void {
    this.socket?.write(`${JSON.stringify(error ? { id, error: { message: safeText(error, 500) } } : { id, result })}\n`);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.setStatus('offline');
    this.reconnectTimer = setTimeout(() => { void this.start().catch(() => undefined); }, 5_000);
  }

  private closeSocket(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.socket?.destroy();
    this.socket = undefined;
    this.buffer = '';
    this.rejectPending(new Error('Bridge disconnected'));
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  private setStatus(state: 'connected' | 'connecting' | 'offline' | 'unpaired'): void {
    this.status.text = state === 'connected' ? '$(shield) Private Browser'
      : state === 'connecting' ? '$(sync~spin) Private Browser'
        : state === 'offline' ? '$(debug-disconnect) Private Browser' : '$(link) Pair Private Browser';
    this.status.tooltip = state === 'connected' ? 'Private Browser Agent Bridge connected'
      : state === 'unpaired' ? 'Pair this editor with Private Browser' : 'Private Browser Agent Bridge offline';
    this.status.command = state === 'unpaired' ? 'privateBrowser.pair' : 'privateBrowser.connect';
    this.status.show();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  const client = new BridgeClient(context, status);
  const mcpChanged = new vscode.EventEmitter<void>();
  const mcpScript = context.asAbsolutePath('dist/mcp-server.js');
  context.subscriptions.push(
    client,
    mcpChanged,
    vscode.lm.registerMcpServerDefinitionProvider('private-browser-agent-tools', {
      onDidChangeMcpServerDefinitions: mcpChanged.event,
      provideMcpServerDefinitions: () => [new vscode.McpStdioServerDefinition(
        'Private Browser',
        process.execPath,
        [mcpScript],
        {},
        '0.4.0',
      )],
      resolveMcpServerDefinition: async (server) => {
        if (!(server instanceof vscode.McpStdioServerDefinition)) return undefined;
        const token = await context.secrets.get(TOKEN_KEY);
        if (!token) throw new Error('Pair the Private Browser Agent Bridge first');
        server.env = { ...server.env, PRIVATE_BROWSER_AGENT_TOKEN: token };
        return server;
      },
    }),
    vscode.commands.registerCommand('privateBrowser.pair', async () => {
      const code = await vscode.window.showInputBox({
        title: 'Pair with Private Browser',
        prompt: 'Enter the eight-digit code shown in Developer Cockpit',
        password: true,
        validateInput: (value) => /^\d{8}$/.test(value) ? undefined : 'Enter exactly eight digits',
      });
      if (!code) return;
      try { await client.pair(code); mcpChanged.fire(); void vscode.window.showInformationMessage('Private Browser Agent Bridge connected.'); }
      catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Pairing failed'); }
    }),
    vscode.commands.registerCommand('privateBrowser.connect', async () => {
      try { await client.reconnect(); void vscode.window.showInformationMessage('Private Browser Agent Bridge connected.'); }
      catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Connection failed'); }
    }),
    vscode.commands.registerCommand('privateBrowser.disconnect', async () => {
      await client.disconnect();
      mcpChanged.fire();
      void vscode.window.showInformationMessage('Private Browser Agent Bridge disconnected.');
    }),
  );
  void client.start().catch(() => undefined);
}

export function deactivate(): void {}
