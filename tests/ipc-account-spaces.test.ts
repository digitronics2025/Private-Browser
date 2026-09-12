import { describe, expect, it } from 'vitest';
import { validateIpcArguments } from '../electron/ipc-contracts';

const ID = '122b503d-a1b3-497a-a610-e193af8d0702';

describe('Account Space IPC contracts', () => {
  it('accepts bounded, typed lifecycle and Google operations', () => {
    expect(() => validateIpcArguments('accounts:add-local', ['personal', 'Work mail', 'indigo'])).not.toThrow();
    expect(() => validateIpcArguments('google:connect', [ID, ['identity', 'gmail-metadata'], 'edge'])).not.toThrow();
    expect(() => validateIpcArguments('google:gmail-prepare-send', [ID, { to: ['person@example.com'], subject: 'Hello', body: 'Body' }, 'rev-1'])).not.toThrow();
    expect(() => validateIpcArguments('browser:import-chrome', [{ profileId: 'Default', workspaceId: 'personal', accountSpaceId: ID, bookmarks: true, history: false }])).not.toThrow();
  });

  it('rejects invalid IDs, cross-shape payloads and oversized sensitive bodies', () => {
    expect(() => validateIpcArguments('accounts:clear-data', ['personal'])).toThrow(/identifier/);
    expect(() => validateIpcArguments('google:connect', [ID, ['unknown'], 'edge'])).toThrow(/module/);
    expect(() => validateIpcArguments('google:gmail-prepare-send', [ID, { to: ['person@example.com'], subject: 'Hello', body: 'x'.repeat(65_537) }])).toThrow(/size/);
    expect(() => validateIpcArguments('accounts:delete', [ID, 'yes'])).toThrow(/Exact/);
    expect(() => validateIpcArguments('browser:import-chrome', [{ profileId: 'Default', workspaceId: 'personal', accountSpaceId: 'personal', bookmarks: true, history: false }])).toThrow(/identifier/);
  });

  it('rejects generic URL-like service requests and invalid permission decisions', () => {
    expect(() => validateIpcArguments('accounts:open-in', [ID, 'file:///secrets.txt'])).toThrow(/HTTP/);
    expect(() => validateIpcArguments('permissions:respond', [ID, 'allow-forever'])).toThrow(/decision/);
  });
});
