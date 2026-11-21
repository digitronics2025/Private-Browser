import { setTimeout as delay } from 'node:timers/promises';
import { nativeImage, type WebContents } from 'electron';
import axe from 'axe-core';
import { sanitizeDiagnosticText, sanitizeDiagnosticUrl } from './developer-tools.js';
import { createAgentPage } from './agent-page.js';
import { AgentError, type AgentElementAction } from './agent-policy.js';
import type { AgentInput } from '@private-browser/bridge-protocol/agent';

const WORLD = 'private-browser-agent';
const INSTALL = `globalThis.__privateBrowserAgent = (${createAgentPage.toString()})(); void 0;`;
const DIAGNOSTIC_LIMIT = 80;
type Box = { x: number; y: number; width: number; height: number };
type Mask = Box & { revision: string; crop?: Box; masks: Box[] };
export type TargetDetails = AgentElementAction & { revision: string; private: boolean; role: string };

export const untrusted = <T>(value: T) => ({ untrusted_page_content: value });
export const clean = (value: string, size?: number) => sanitizeDiagnosticText(value, size).text
  .replace(/\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){11,30}\b/g, '[redacted]')
  .replace(/\b(otp|pin|cvv|cvc|verification code)\s*[:=]\s*\d{3,12}\b/gi, '$1: [redacted]');
export const cleanUrl = (url: string) => sanitizeDiagnosticUrl(url).text;

export class AgentDriver {
  private world?: { frame: string; id: number };
  private generation = 0;
  private dialog?: string;
  private dialogGeneration = 0;
  private dialogListener?: () => void;
  private lastNetworkAt = 0;
  private requests = new Set<number>();
  private consoleLog: { at: number; level: string; message: string; source: string }[] = [];
  private networkLog: { at: number; method: string; url: string; status?: number; error?: string }[] = [];

  constructor(readonly contents: WebContents) {
    contents.on('console-message', ({ level, message, sourceId }) => {
      if (level !== 'warning' && level !== 'error') return;
      this.consoleLog = [{ at: Date.now(), level, message: clean(message), source: cleanUrl(sourceId) }, ...this.consoleLog].slice(0, DIAGNOSTIC_LIMIT);
    });
    contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) { this.world = undefined; this.generation += 1; }
    });
    contents.debugger.on('message', (_event, method, data) => {
      if (method === 'Page.javascriptDialogOpening') { this.dialog = String(data.type); this.dialogGeneration += 1; this.dialogListener?.(); }
      if (method === 'Page.javascriptDialogClosed') { this.dialog = undefined; this.dialogGeneration += 1; }
    });
    contents.debugger.on('detach', () => { this.world = undefined; this.generation += 1; });
  }

  async initialize(): Promise<void> {
    if (!this.contents.debugger.isAttached()) {
      this.contents.debugger.attach('1.3');
      await this.contents.debugger.sendCommand('Page.enable');
    }
  }

  networkStarted(id: number): void {
    this.lastNetworkAt = Date.now();
    if (this.requests.size < 512) this.requests.add(id);
  }

  networkEnded(details: { id: number; url: string; method: string; statusCode?: number; error?: string }): void {
    this.requests.delete(details.id);
    this.lastNetworkAt = Date.now();
    const { method, statusCode: status, error } = details;
    this.networkLog = [{ at: Date.now(), method: clean(method, 12), url: cleanUrl(details.url), status, error: error && clean(error, 80) },
      ...this.networkLog].slice(0, DIAGNOSTIC_LIMIT);
  }

  console(since = 0) { return untrusted(this.consoleLog.filter((entry) => entry.at >= since)); }
  network(filter = '') { return untrusted(this.networkLog.filter((entry) => entry.url.includes(filter))); }
  dialogRevision(): string {
    if (!this.dialog) throw new AgentError('NO_DIALOG', 'There is no open page dialog.');
    return `${this.dialogGeneration}:${this.dialog}`;
  }

  async run<T = unknown>(command: string, input: unknown = {}, signal?: AbortSignal): Promise<T> {
    const world = await this.context(signal);
    return this.evaluate(world, `globalThis.__privateBrowserAgent(${JSON.stringify(command)}, ${JSON.stringify(input)})`, signal) as Promise<T>;
  }

  async action(command: string, input: object, expected: string, signal: AbortSignal): Promise<unknown> {
    if (this.dialog) throw new AgentError('DIALOG_OPEN', 'Handle the open page dialog first.');
    try {
      return await Promise.race([
        this.run(command, { ...input, expected }, signal),
        new Promise((resolve) => { this.dialogListener = () => resolve({ dialog: this.dialog }); }),
      ]);
    } finally { this.dialogListener = undefined; }
  }

  async respondToDialog(accept: boolean, text?: string): Promise<void> {
    if (!this.dialog) throw new AgentError('NO_DIALOG', 'There is no open page dialog.');
    await this.contents.debugger.sendCommand('Page.handleJavaScriptDialog', { accept, promptText: text });
  }

  async upload(ref: string, expected: string, file: string, signal: AbortSignal): Promise<void> {
    const world = await this.context(signal);
    const result = await this.contents.debugger.sendCommand('Runtime.evaluate', {
      contextId: world, expression: `globalThis.__privateBrowserAgent('file', ${JSON.stringify({ ref, expected })})`, objectGroup: 'agent-upload',
    });
    try {
      signal.throwIfAborted();
      if (result.exceptionDetails || !result.result?.objectId) throw new AgentError('STALE_REFERENCE', 'Refresh the snapshot and choose a file input.');
      await this.contents.debugger.sendCommand('DOM.setFileInputFiles', { objectId: result.result.objectId, files: [file] });
    } finally {
      await this.contents.debugger.sendCommand('Runtime.releaseObjectGroup', { objectGroup: 'agent-upload' }).catch(() => undefined);
    }
  }

  async wait(input: AgentInput<'wait_for'>, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + (input.timeout ?? 8_000);
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (input.url && this.contents.getURL() === input.url) return;
      if (input.networkIdle && !this.requests.size && !this.contents.isLoading() && Date.now() - this.lastNetworkAt >= 500) return;
      if (input.text && (await this.run<string>('text', {}, signal)).includes(input.text)) return;
      if (input.ref && await this.run('inspect', { ref: input.ref }, signal).then(() => true, () => false)) return;
      await delay(150, undefined, { signal });
    }
    throw new AgentError('WAIT_TIMEOUT', 'The condition was not met before the timeout.');
  }

  async emulate(input: AgentInput<'emulate'>): Promise<void> {
    const presets = { desktop: { width: 1280, height: 800 }, tablet: { width: 768, height: 980 }, mobile: { width: 375, height: 812 } };
    const viewport = input.viewport ?? (input.device && presets[input.device]);
    if (viewport) {
      await this.contents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
        ...viewport, deviceScaleFactor: 1, mobile: input.device === 'mobile' || input.device === 'tablet',
      });
    }
    if (input.colorScheme !== undefined || input.reducedMotion !== undefined) {
      await this.contents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [
        { name: 'prefers-color-scheme', value: input.colorScheme ?? '' },
        { name: 'prefers-reduced-motion', value: input.reducedMotion === undefined ? '' : input.reducedMotion ? 'reduce' : 'no-preference' },
      ] });
    }
    if (input.offline !== undefined) await this.contents.debugger.sendCommand('Network.emulateNetworkConditions', {
      offline: input.offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    });
    if (input.cpuThrottle !== undefined) await this.contents.debugger.sendCommand('Emulation.setCPUThrottlingRate', { rate: input.cpuThrottle });
  }

  async audit(signal: AbortSignal): Promise<unknown> {
    const world = await this.context(signal);
    const code = `${axe.source}\n;axe.run({ resultTypes: ['violations'] }).then(({ violations }) =>
      violations.slice(0, 30).map(({ id, impact, description, nodes }) => ({ id, impact, description, count: nodes.length })))`;
    return untrusted(await this.evaluate(world, code, signal, true));
  }

  async screenshot(input: AgentInput<'screenshot'>, signal: AbortSignal): Promise<unknown> {
    const mask = await this.run<Mask>('mask', { ref: input.ref }, signal);
    let clip: Box = mask.crop ?? { x: mask.x, y: mask.y, width: mask.width, height: mask.height };
    if (input.fullPage && !mask.crop) {
      const { cssContentSize } = await this.contents.debugger.sendCommand('Page.getLayoutMetrics');
      clip = { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height };
    }
    clip = {
      x: Math.max(0, Math.floor(clip.x)), y: Math.max(0, Math.floor(clip.y)),
      width: Math.ceil(clip.width), height: Math.ceil(clip.height),
    };
    if (clip.width <= 0 || clip.height <= 0 || clip.width > 4_096 || clip.height > 4_096 || clip.width * clip.height > 8_000_000) {
      throw new AgentError('SCREENSHOT_LIMIT', 'Capture the viewport or a smaller element.');
    }
    const { data } = await this.contents.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true, clip: { ...clip, scale: 1 },
    });
    if (mask.revision !== await this.run<string>('revision', {}, signal)) throw new AgentError('PAGE_CHANGED', 'The page changed during capture. Try again.');
    const original = nativeImage.createFromBuffer(Buffer.from(data, 'base64'));
    const bitmap = original.toBitmap();
    const { width, height } = original.getSize();
    const scaleX = width / clip.width;
    const scaleY = height / clip.height;
    for (const box of mask.masks) {
      const left = Math.max(0, Math.floor((box.x - clip.x - 4) * scaleX));
      const top = Math.max(0, Math.floor((box.y - clip.y - 4) * scaleY));
      const right = Math.min(width, Math.ceil((box.x + box.width - clip.x + 4) * scaleX));
      const bottom = Math.min(height, Math.ceil((box.y + box.height - clip.y + 4) * scaleY));
      if (right <= left || bottom <= top) continue;
      for (let row = top; row < bottom; row += 1) {
        bitmap.fill(Buffer.from([0, 0, 0, 255]), (row * width + left) * 4, (row * width + right) * 4);
      }
    }
    const image = nativeImage.createFromBitmap(bitmap, { width, height });
    for (const size of [1_000, 740, 480, 300]) {
      const jpeg = image.resize({ width: Math.min(width, size) }).toJPEG(60);
      if (jpeg.byteLength <= 118_000) return untrusted({ jpeg: jpeg.toString('base64') });
    }
    throw new AgentError('SCREENSHOT_LIMIT', 'Capture a smaller element.');
  }

  private async context(signal?: AbortSignal): Promise<number> {
    signal?.throwIfAborted();
    await this.initialize();
    const generation = this.generation;
    const { frameTree: { frame } } = await this.contents.debugger.sendCommand('Page.getFrameTree');
    if (this.world && this.world.frame === frame.id) return this.world.id;
    const { executionContextId } = await this.contents.debugger.sendCommand('Page.createIsolatedWorld', { frameId: frame.id, worldName: WORLD });
    await this.evaluate(executionContextId, INSTALL, signal);
    if (generation !== this.generation) throw new AgentError('PAGE_CHANGED', 'The page changed. Refresh the snapshot.');
    this.world = { frame: frame.id, id: executionContextId };
    return executionContextId;
  }

  private async evaluate(contextId: number, expression: string, signal?: AbortSignal, awaitPromise = false): Promise<unknown> {
    signal?.throwIfAborted();
    const result = await this.contents.debugger.sendCommand('Runtime.evaluate', { contextId, expression, returnByValue: true, awaitPromise, timeout: 6_000 });
    signal?.throwIfAborted();
    if (result.exceptionDetails) throw new AgentError('PAGE_ACTION_DENIED', 'The page changed or the target is unavailable or sensitive.');
    return result.result?.value;
  }
}
