import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import * as vscode from 'vscode';
import { reviewedPatchInputSchema, type ReviewedPatchResult } from '@private-browser/bridge-protocol';
import { resolveInsideWorkspace } from './security.js';

interface Change {
  path: string;
  file: string;
  diskHash: string;
  version: number;
  before: string;
  after: string;
}

interface Patch {
  projectId: string;
  id: string;
  expires: number;
  reportId?: string;
  changes: Change[];
}

const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const sizeLimit = 256 * 1024;
const reviewLifetime = 10 * 60_000;
const normalizeLines = (text: string) => text.replace(/\r\n?/g, '\n');

async function readSource(file: string): Promise<Buffer> {
  const info = await stat(file);
  if (!info.isFile() || info.size > sizeLimit) throw new Error('Select an existing text file under 256 kB.');
  const bytes = await readFile(file);
  if (bytes.byteLength > sizeLimit || bytes.includes(0)) throw new Error('Select an existing text file under 256 kB.');
  return bytes;
}

/** Holds one review and one undo in the extension session. Browser responses contain paths only. */
export class ReviewedWorkspacePatches {
  private pending?: Patch;
  private applied?: Patch;
  private epoch = 0;
  private busy = false;

  constructor(context: vscode.ExtensionContext, private readonly folder: (id: string) => Promise<vscode.WorkspaceFolder>) {
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('private-browser-patch', {
      provideTextDocumentContent: (uri) => {
        const patch = this.pending;
        if (!patch || uri.authority !== patch.id || Date.now() >= patch.expires) return 'This patch review has expired.';
        return patch.changes[Number(uri.query)]?.after ?? '';
      },
    }));
  }

  clear(): void {
    this.pending = undefined;
    this.applied = undefined;
    this.epoch++;
  }

  async review(projectId: string, value: unknown): Promise<ReviewedPatchResult> {
    if (this.busy) throw new Error('Finish the current patch action in VS Code first.');
    const request = reviewedPatchInputSchema.parse(value);
    this.busy = true;
    const epoch = this.epoch;
    try {
      const root = (await this.folder(projectId)).uri.fsPath;
      const changes: Change[] = [];
      const seen = new Set<string>();
      for (const edit of request.edits) {
        const file = await resolveInsideWorkspace(root, edit.path);
        const key = process.platform === 'win32' ? file.toLowerCase() : file;
        if (seen.has(key)) throw new Error('Two proposed paths refer to the same file.');
        seen.add(key);
        const bytes = await readSource(file);
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        const before = document.getText();
        if (document.isDirty || normalizeLines(bytes.toString('utf8').replace(/^\uFEFF/, '')) !== normalizeLines(before)) {
          throw new Error(`Save the current edits in ${basename(file)} before reviewing this patch.`);
        }
        const normalized = normalizeLines(edit.newText);
        const after = document.eol === vscode.EndOfLine.CRLF ? normalized.replaceAll('\n', '\r\n') : normalized;
        if (after !== before) changes.push({ path: edit.path, file, diskHash: digest(bytes), version: document.version, before, after });
      }
      if (!changes.length) throw new Error('The proposal matches the files already open.');
      if (this.epoch !== epoch) throw new Error('Reconnect and review the patch again.');
      const patch = { id: randomUUID(), projectId, reportId: request.reportId, changes, expires: Date.now() + reviewLifetime };
      this.pending = patch;
      for (const [index, item] of changes.entries()) {
        const original = vscode.Uri.file(item.file);
        const proposed = vscode.Uri.from({ scheme: 'private-browser-patch', authority: patch.id, path: '/' + basename(item.file), query: String(index) });
        await vscode.commands.executeCommand('vscode.diff', original, proposed, `Private Browser proposal — ${item.path}`, { preview: false });
      }
      if (this.epoch !== epoch) throw new Error('Reconnect and review the patch again.');
      return this.summary(patch);
    } finally { this.busy = false; }
  }

  async change(projectId: string, id: string, undo = false): Promise<ReviewedPatchResult> {
    if (this.busy) throw new Error('Finish the current patch action in VS Code first.');
    const patch = this.require(undo ? this.applied : this.pending, projectId, id);
    this.busy = true;
    const epoch = this.epoch;
    try {
      const action = undo ? 'Undo approved patch' : 'Apply reviewed patch';
      const files = patch.changes.map(({ path }) => path).join('\n');
      const confirm = await vscode.window.showWarningMessage(action + '?', { modal: true, detail: files }, action);
      if (confirm !== action) throw new Error('Patch action cancelled.');
      this.require(undo ? this.applied : this.pending, projectId, id);
      const root = (await this.folder(projectId)).uri.fsPath;
      const verified: Array<{ item: Change; document: vscode.TextDocument; version: number }> = [];
      for (const item of patch.changes) {
        if (await resolveInsideWorkspace(root, item.path) !== item.file) throw new Error('A reviewed path changed. Review the patch again.');
        const bytes = await readSource(item.file);
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(item.file));
        const diskMatches = digest(bytes) === item.diskHash || (undo && normalizeLines(bytes.toString('utf8').replace(/^\uFEFF/, '')) === normalizeLines(item.after));
        if (!diskMatches || document.getText() !== (undo ? item.after : item.before) || (!undo && (document.isDirty || document.version !== item.version))) {
          throw new Error(`${item.path} changed since review. Confirm its current content first.`);
        }
        verified.push({ item, document, version: document.version });
      }
      if (entryChanged(verified) || this.epoch !== epoch || !vscode.workspace.isTrusted) throw new Error('The reviewed workspace changed. Review the patch again.');
      const edit = new vscode.WorkspaceEdit();
      for (const { item, document } of verified) {
        edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), undo ? item.before : item.after);
      }
      if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code could not apply the reviewed edits.');
      if (undo) this.applied = undefined;
      else {
        this.pending = undefined;
        if (this.epoch === epoch) this.applied = { ...patch, expires: Date.now() + reviewLifetime };
      }
      return this.summary(patch);
    } finally { this.busy = false; }
  }

  async savedReport(projectId: string, id: string): Promise<string> {
    if (this.busy) throw new Error('Finish the current patch action in VS Code first.');
    const patch = this.require(this.applied, projectId, id);
    if (!patch.reportId) throw new Error('No test report was selected when the patch was reviewed.');
    const root = (await this.folder(projectId)).uri.fsPath;
    for (const item of patch.changes) {
      if (await resolveInsideWorkspace(root, item.path) !== item.file) throw new Error('A reviewed path changed. Review the patch again.');
      const bytes = await readSource(item.file);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(item.file));
      if (document.isDirty || document.getText() !== item.after || normalizeLines(bytes.toString('utf8').replace(/^\uFEFF/, '')) !== normalizeLines(item.after)) {
        throw new Error(`Save the reviewed version of ${item.path} before rerunning.`);
      }
    }
    this.require(this.applied, projectId, id);
    return patch.reportId;
  }

  private require(patch: Patch | undefined, projectId: string, id: string): Patch {
    if (!patch || patch.id !== id || patch.projectId !== projectId || Date.now() >= patch.expires) throw new Error('The patch review is no longer available.');
    return patch;
  }

  private summary(patch: Patch): ReviewedPatchResult {
    return { id: patch.id, files: patch.changes.map(({ path }) => path), ...(patch.reportId ? { reportId: patch.reportId } : {}) };
  }
}

function entryChanged(entries: Array<{ document: vscode.TextDocument; version: number }>): boolean {
  return entries.some(({ document, version }) => document.isClosed || document.version !== version);
}
