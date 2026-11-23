import { writeFileSync } from 'node:fs';

const pins = (process.env.PRIVATE_BROWSER_WINDOWS_PUBLISHERS ?? '').toLowerCase().split(/\s+/).filter(Boolean);
if (pins.some(pin => !/^[a-f0-9]{64}$/.test(pin))) throw new Error('Invalid approved Windows publisher fingerprint.');
if (process.env.PRIVATE_BROWSER_STABLE_BUILD === 'true' && pins.length === 0) {
  throw new Error('A stable installer requires at least one approved Windows publisher.');
}
writeFileSync(new URL('../dist-electron/windows-publishers.json', import.meta.url), JSON.stringify([...new Set(pins)]) + '\n');
