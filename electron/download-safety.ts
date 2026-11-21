import type { DownloadEntry } from './types.js';

export function downloadExtension(filename: string): string | undefined {
  return /\.([a-z0-9]{1,10})$/i.exec(filename.trim().replace(/[. ]+$/, ''))?.[1]?.toUpperCase();
}

export function downloadOpenBlock(item: Pick<DownloadEntry, 'state' | 'checksum' | 'risk'>): string | undefined {
  if (item.state !== 'completed') return 'Open is available after the download finishes.';
  if (item.checksum === 'checking') return 'Wait for the installer verification to finish.';
  if (item.checksum === 'mismatch') return 'The published checksum did not match. Download a fresh copy.';
  if (item.risk !== 'ordinary' && item.checksum !== 'verified') {
    return 'Use Show folder to review and scan this file before opening.';
  }
}
