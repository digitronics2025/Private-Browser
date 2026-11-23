import { writeFileSync } from 'node:fs';

const pins = (process.env.PRIVATE_BROWSER_WINDOWS_PUBLISHERS ?? '').toLowerCase().split(/\s+/).filter(Boolean);
if (pins.some(pin => !/^[a-f0-9]{64}$/.test(pin))) throw new Error('Invalid approved Windows publisher fingerprint.');
const signingConfigured = Boolean(process.env.PRIVATE_BROWSER_WINDOWS_SIGNER_THUMBPRINT);
if (process.env.PRIVATE_BROWSER_STABLE_BUILD === 'true' && signingConfigured && pins.length === 0) {
  throw new Error('A signed stable installer requires an approved Windows publisher.');
}
if (process.env.PRIVATE_BROWSER_STABLE_BUILD === 'true' && !signingConfigured && pins.length > 0) {
  throw new Error('An unsigned stable installer must not carry publisher pins.');
}
writeFileSync(new URL('../dist-electron/windows-publishers.json', import.meta.url), JSON.stringify([...new Set(pins)]) + '\n');
