import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { ExternalBrowserId } from './types.js';

export interface ExternalBrowserChoice {
  id: ExternalBrowserId;
  name: string;
  executablePath: string;
}

type SpawnBrowser = (executablePath: string, args: string[], options: { shell: false; detached: true; stdio: 'ignore' }) => Pick<ChildProcess, 'unref'>;

export class ExternalBrowserLauncher {
  constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly platform = process.platform,
    private readonly spawnBrowser: SpawnBrowser = spawn,
  ) {}

  discover(): ExternalBrowserChoice[] {
    const candidates = this.platform === 'win32' ? this.windowsCandidates() : this.unixCandidates();
    const seen = new Set<string>();
    return candidates.filter((candidate) => {
      const key = candidate.executablePath.toLowerCase();
      if (seen.has(key) || !existsSync(candidate.executablePath)) return false;
      seen.add(key);
      return true;
    });
  }

  launch(browserId: ExternalBrowserId, authorizationUrl: string): void {
    const parsed = new URL(authorizationUrl);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'accounts.google.com' || parsed.pathname !== '/o/oauth2/v2/auth') {
      throw new Error('Refused to open a non-Google authorization URL');
    }
    const browser = this.discover().find((candidate) => candidate.id === browserId);
    if (!browser) throw new Error('Selected trusted external browser is not installed');
    const child = this.spawnBrowser(browser.executablePath, [parsed.toString()], { shell: false, detached: true, stdio: 'ignore' });
    child.unref();
  }

  private windowsCandidates(): ExternalBrowserChoice[] {
    const programFiles = this.environment.ProgramFiles;
    const programFilesX86 = this.environment['ProgramFiles(x86)'];
    const localAppData = this.environment.LOCALAPPDATA;
    const appData = this.environment.APPDATA;
    return [
      programFiles && { id: 'edge' as const, name: 'Microsoft Edge', executablePath: join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
      programFilesX86 && { id: 'edge' as const, name: 'Microsoft Edge', executablePath: join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
      programFiles && { id: 'chrome' as const, name: 'Google Chrome', executablePath: join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      programFilesX86 && { id: 'chrome' as const, name: 'Google Chrome', executablePath: join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      localAppData && { id: 'chrome' as const, name: 'Google Chrome', executablePath: join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      programFiles && { id: 'firefox' as const, name: 'Mozilla Firefox', executablePath: join(programFiles, 'Mozilla Firefox', 'firefox.exe') },
      programFilesX86 && { id: 'firefox' as const, name: 'Mozilla Firefox', executablePath: join(programFilesX86, 'Mozilla Firefox', 'firefox.exe') },
      appData && { id: 'firefox' as const, name: 'Mozilla Firefox', executablePath: join(appData, 'Mozilla', 'Firefox', 'firefox.exe') },
    ].filter((candidate): candidate is ExternalBrowserChoice => Boolean(candidate));
  }

  private unixCandidates(): ExternalBrowserChoice[] {
    return [
      { id: 'edge', name: 'Microsoft Edge', executablePath: '/usr/bin/microsoft-edge' },
      { id: 'chrome', name: 'Google Chrome', executablePath: '/usr/bin/google-chrome' },
      { id: 'firefox', name: 'Mozilla Firefox', executablePath: '/usr/bin/firefox' },
    ];
  }
}
