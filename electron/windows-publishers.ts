import { readFileSync } from 'node:fs';

export function loadApprovedPublishers(path: string): readonly string[] {
  try {
    const pins: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (Array.isArray(pins) && pins.every(pin => typeof pin === 'string' && /^[a-f0-9]{64}$/.test(pin))) {
      return pins;
    }
  } catch {
    // Missing packaged policy disables installer launch.
  }
  return [];
}
