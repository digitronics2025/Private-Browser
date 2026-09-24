import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { developerEvidence } from '../electron/control-center-link';
import { validateIpcArguments } from '../electron/ipc-contracts';

/**
 * The seven Control Center channels (docs/systems/control-center-link.md):
 * every one is written in main.ts, preload.cts, ipc-contracts.ts and the
 * preview mock, and the contract refuses anything but the exact shape.
 */

const CHANNELS = ['control-center:status', 'control-center:pair', 'control-center:disconnect', 'control-center:repositories', 'control-center:tasks', 'control-center:send', 'control-center:recheck'];
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
/** An approval id is a random UUID; made at runtime so no token-shaped literal is committed. */
const APPROVAL = randomUUID();

describe('Control Center IPC contract', () => {
  it('is written in main, preload, the validator and the preview mock, and nowhere else', () => {
    const main = read('electron/main.ts');
    const preload = read('electron/preload.cts');
    const contracts = read('electron/ipc-contracts.ts');
    const preview = read('src/preview-api.ts');
    for (const channel of CHANNELS) {
      expect(main, channel).toContain(`handle('${channel}'`);
      expect(preload, channel).toContain(`ipcRenderer.invoke('${channel}'`);
      expect(contracts, channel).toContain(`case '${channel}':`);
    }
    const found = new Set([...main.matchAll(/'(control-center:[a-z-]+)'/g)].map((m) => m[1]));
    expect([...found].sort()).toEqual([...CHANNELS].sort());
    for (const method of ['getControlCenterStatus', 'listControlCenterRepositories', 'listControlCenterTasks', 'sendToControlCenter', 'recheckControlCenterTask']) {
      expect(preview, method).toContain(`${method}:`);
    }
    // The renderer never sees the app token or the evidence it sends.
    expect(preload).not.toMatch(/control-center[^\n]*token\s*:/i);
  });

  it('accepts only the exact shapes', () => {
    for (const channel of ['control-center:status', 'control-center:disconnect', 'control-center:repositories', 'control-center:tasks']) {
      expect(() => validateIpcArguments(channel, [])).not.toThrow();
      expect(() => validateIpcArguments(channel, ['extra'])).toThrow();
    }
    expect(() => validateIpcArguments('control-center:pair', ['12345678'])).not.toThrow();
    for (const bad of ['1234', '1234567a', 12345678, '123456789']) expect(() => validateIpcArguments('control-center:pair', [bad]), String(bad)).toThrow();

    const send = { approvalToken: APPROVAL, repositoryId: 'repo-1', note: 'The cart page crashes' };
    expect(() => validateIpcArguments('control-center:send', [send])).not.toThrow();
    expect(() => validateIpcArguments('control-center:send', [{ ...send, note: '' }])).toThrow();
    expect(() => validateIpcArguments('control-center:send', [{ ...send, note: 'x'.repeat(2001) }])).toThrow();
    expect(() => validateIpcArguments('control-center:send', [{ ...send, approvalToken: 'not-a-token' }])).toThrow();
    // Nothing the renderer adds rides along: no evidence, no screenshot, no mode.
    expect(() => validateIpcArguments('control-center:send', [{ ...send, evidence: 'forged' }])).toThrow();
    expect(() => validateIpcArguments('control-center:send', [{ ...send, mode: 'autopilot' }])).toThrow();

    expect(() => validateIpcArguments('control-center:recheck', [{ approvalToken: APPROVAL, taskId: 'TASK-0042' }])).not.toThrow();
    expect(() => validateIpcArguments('control-center:recheck', [{ approvalToken: APPROVAL, taskId: '../TASK-1' }])).toThrow();
    expect(() => validateIpcArguments('control-center:recheck', [{ approvalToken: APPROVAL, taskId: 'TASK-0042', evidence: 'x' }])).toThrow();
  });

  it('sends exactly the approved preview text and chosen DOM, bounded', () => {
    expect(developerEvidence({ text: '{"console":[]}' })).toBe('{"console":[]}');
    expect(developerEvidence({ text: 'a', dom: '[{"tag":"main"}]' })).toBe('a\n\nStructural DOM:\n[{"tag":"main"}]');
    expect(developerEvidence({ text: 'x'.repeat(40_000) })).toHaveLength(30_000);
  });

  it('spends the approval before any other check, and only for the Development workspace', () => {
    const main = read('electron/main.ts').replace(/\r\n/g, '\n');
    const body = (name: string) => {
      const start = main.indexOf(`  async ${name}(`);
      expect(start, name).toBeGreaterThan(0);
      return main.slice(start, main.indexOf('\n  }\n', start));
    };
    for (const name of ['sendToControlCenter', 'recheckControlCenterTask']) {
      const code = body(name);
      expect(code.indexOf('this.requireDeveloperWorkspace()')).toBeGreaterThan(0);
      expect(code.indexOf('this.requireDeveloperWorkspace()')).toBeLessThan(code.indexOf('this.consumeDeveloperApproval('));
      expect(code).not.toMatch(/executeJavaScript|capturePage|captureDeveloperDiagnostics/); // never re-reads the page
    }
    const consume = main.slice(main.indexOf('  private consumeDeveloperApproval('), main.indexOf('  private pageOrigin('));
    expect(consume.indexOf('this.consumeAiApproval(token)')).toBeLessThan(consume.indexOf('this.developerPreviewIds.delete'));
  });
});
