import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { reviewedPatchInputSchema } from '@private-browser/bridge-protocol';
import { ReviewedWorkspacePatches } from '../vscode-extension/src/reviewed-patches';
import type { ExtensionContext, WorkspaceFolder } from 'vscode';

interface BufferState {
  text: string;
  version: number;
  isDirty: boolean;
}

const mock = vi.hoisted(() => ({ files: new Map<string, BufferState>(), prompt: vi.fn(), diff: vi.fn(), content: undefined as ((uri: { authority: string; query: string }) => string) | undefined }));

vi.mock('vscode', () => ({
  Uri: { file: (fsPath: string) => ({ fsPath }), from: (uri: object) => uri },
  EndOfLine: { LF: 1, CRLF: 2 },
  Range: class { constructor(readonly start: number, readonly end: number) {} },
  WorkspaceEdit: class {
    readonly changes: Array<{ path: string; text: string }> = [];
    replace(uri: { fsPath: string }, _range: unknown, text: string): void { this.changes.push({ path: uri.fsPath, text }); }
  },
  window: { showWarningMessage: mock.prompt },
  commands: { executeCommand: mock.diff },
  workspace: {
    isTrusted: true,
    registerTextDocumentContentProvider: (_scheme: string, provider: { provideTextDocumentContent: typeof mock.content }) => {
      mock.content = provider.provideTextDocumentContent;
      return { dispose: () => undefined };
    },
    openTextDocument: async (uri: { fsPath: string }) => {
      if (!mock.files.has(uri.fsPath)) mock.files.set(uri.fsPath, { text: readFileSync(uri.fsPath, 'utf8'), version: 1, isDirty: false });
      const state = mock.files.get(uri.fsPath)!;
      return {
        uri, eol: 1, isClosed: false, positionAt: (index: number) => index,
        get version() { return state.version; }, get isDirty() { return state.isDirty; }, getText: () => state.text,
      };
    },
    applyEdit: async ({ changes }: { changes: Array<{ path: string; text: string }> }) => {
      for (const { path, text } of changes) {
        const file = mock.files.get(path)!;
        file.text = text;
        file.version++;
        file.isDirty = true;
      }
      return true;
    },
  },
}));

it('opens an exact read-only diff, applies once, checks the saved contents before rerun and can undo', async () => {
  const root = mkdtempSync(join(tmpdir(), 'private-browser-patch-fixture-'));
  const source = join(root, 'example.ts');
  const old = 'const visible = false;\n';
  const next = 'const visible = true;\n';
  const reportId = '12345678-abcd-4000-9000-123456789abc';
  const context = { subscriptions: [] } as unknown as ExtensionContext;
  const folder = async () => ({ uri: { fsPath: root } }) as WorkspaceFolder;
  try {
    mock.diff.mockClear();
    mock.prompt.mockImplementation((_title, _options, action) => Promise.resolve(action));
    const patches = new ReviewedWorkspacePatches(context, folder);
    writeFileSync(source, old);
    const proposal = await patches.review('project-a', { edits: [{ path: 'example.ts', newText: next }], reportId });
    expect(mock.diff.mock.calls[0]?.[0]).toBe('vscode.diff');
    expect(mock.content!(mock.diff.mock.calls[0]?.[2])).toBe(next);
    expect(readFileSync(source, 'utf8')).toBe(old);
    await expect(patches.change('project-b', proposal.id)).rejects.toThrow(/no longer available/);
    await expect(patches.change('project-a', proposal.id)).resolves.toEqual(proposal);
    const buffer = [...mock.files.values()][0];
    expect(buffer.text).toBe(next);
    expect(readFileSync(source, 'utf8')).toBe(old);
    await expect(patches.change('project-a', proposal.id)).rejects.toThrow(/no longer available/);
    await expect(patches.savedReport('project-a', proposal.id)).rejects.toThrow(/Save the reviewed version/);
    writeFileSync(source, next);
    buffer.isDirty = false;
    await expect(patches.savedReport('project-a', proposal.id)).resolves.toBe(reportId);
    await patches.change('project-a', proposal.id, true);
    expect(buffer.text).toBe(old);
  } finally {
    mock.files.clear();
    rmSync(root, { recursive: true, force: true });
  }
});

it('keeps changes that appear during approval and rejects unsupported paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'private-browser-patch-fixture-'));
  const source = join(root, 'example.ts');
  const context = { subscriptions: [] } as unknown as ExtensionContext;
  const folder = async () => ({ uri: { fsPath: root } }) as WorkspaceFolder;
  try {
    for (const path of ['../example.ts', 'C:/example.ts', '.git/config', 'example.ts:stream', 'example.ts.', 'node_modules/example.ts']) {
      expect(reviewedPatchInputSchema.safeParse({ edits: [{ path, newText: 'fixture' }] }).success).toBe(false);
    }
    writeFileSync(source, 'original');
    const patches = new ReviewedWorkspacePatches(context, folder);
    const proposal = await patches.review('project-a', { edits: [{ path: 'example.ts', newText: 'proposal' }] });
    mock.prompt.mockImplementation((_title, _options, action) => {
      const buffer = [...mock.files.values()][0];
      buffer.text = 'user edit';
      buffer.version++;
      buffer.isDirty = true;
      return Promise.resolve(action);
    });
    await expect(patches.change('project-a', proposal.id)).rejects.toThrow(/changed since review/);
    expect([...mock.files.values()][0].text).toBe('user edit');
    expect(readFileSync(source, 'utf8')).toBe('original');
  } finally {
    mock.files.clear();
    rmSync(root, { recursive: true, force: true });
  }
});
