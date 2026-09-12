import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AccountStore, type SafeStorageAdapter } from '../electron/account-store';
import { GoogleMutationConfirmations } from '../electron/google-confirmations';
import { GoogleConfigurationStore } from '../electron/google-config';
import { GoogleServices, type CalendarWriteInput, type GmailSendInput } from '../electron/google-services';
import { scopesForModules } from '../electron/google-scopes';
import { GoogleTokenBroker } from '../electron/google-token-broker';
import type { AccountSpaceId, GoogleModule } from '../electron/types';

class TestEncryption implements SafeStorageAdapter {
  isEncryptionAvailable(): boolean { return true; }
  encryptString(value: string): Buffer { return Buffer.from(value).reverse(); }
  decryptString(value: Buffer): string { return Buffer.from(value).reverse().toString(); }
}

const ID = '122b503d-a1b3-497a-a610-e193af8d0702' as AccountSpaceId;
const CLIENT_ID = `${'1'.repeat(40)}.apps.googleusercontent.com`;
const MODULES: GoogleModule[] = ['identity', 'gmail-metadata', 'gmail-read', 'gmail-send', 'drive-files', 'drive-metadata', 'calendar-read', 'calendar-write', 'contacts-read'];

function json(value: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function fixture(request: typeof fetch, seedToken = true) {
  const root = mkdtempSync(join(tmpdir(), 'google-services-'));
  const encryption = new TestEncryption();
  const accounts = new AccountStore(join(root, 'accounts'), encryption, () => new Date('2026-09-12T10:00:00Z'));
  accounts.createLocal({ id: ID, workspaceId: 'personal', label: 'Personal', color: 'emerald', order: 0 });
  accounts.saveGoogleGrant(ID, { sub: 'subject', email: 'person@example.test', emailVerified: true }, 'refresh-secret', MODULES, scopesForModules(MODULES), [ID]);
  const configuration = new GoogleConfigurationStore(join(root, 'google.enc'), encryption, CLIENT_ID);
  const broker = new GoogleTokenBroker(configuration, accounts, request, () => new Date('2026-09-12T10:00:00Z'));
  if (seedToken) broker.seedAccessToken(ID, 'access-secret', Date.parse('2026-09-12T11:00:00Z'));
  const confirmations = new GoogleMutationConfirmations(() => new Date('2026-09-12T10:00:00Z'));
  const waits: number[] = [];
  const services = new GoogleServices(broker, confirmations, request, async (milliseconds) => { waits.push(milliseconds); }, () => 0);
  return { root, accounts, broker, confirmations, services, waits };
}

describe('narrow resilient Google services', () => {
  it('coalesces refreshes and keeps refreshed access tokens memory-only', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const request = vi.fn<typeof fetch>(async () => {
      await gate;
      return json({ access_token: 'fresh-access', expires_in: 3600 });
    });
    const { root, broker } = fixture(request, false);
    const first = broker.getAccessToken(ID, 'gmail-metadata');
    const second = broker.getAccessToken(ID, 'gmail-metadata');
    release();
    await expect(Promise.all([first, second])).resolves.toEqual(['fresh-access', 'fresh-access']);
    expect(request).toHaveBeenCalledOnce();
    expect(readFileSync(join(root, 'accounts', `${ID}.account.enc`), 'utf8')).not.toContain('fresh-access');
  });

  it('returns Gmail unread count and only recent metadata headers', async () => {
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/labels/INBOX')) return json({ messagesUnread: 7 });
      if (url.includes('/messages?')) return json({ messages: [{ id: 'm1' }] });
      return json({ id: 'm1', threadId: 't1', payload: { headers: [
        { name: 'From', value: 'Sender <sender@example.test>' },
        { name: 'Subject', value: 'Quarterly update' },
        { name: 'Date', value: 'Fri, 12 Sep 2026 10:00:00 GMT' },
      ] } });
    });
    const { services } = fixture(request);
    const result = await services.gmailOverview(ID);
    expect(result).toEqual({ ok: true, data: { unreadCount: 7, recent: [{ id: 'm1', threadId: 't1', from: 'Sender <sender@example.test>', subject: 'Quarterly update', date: 'Fri, 12 Sep 2026 10:00:00 GMT' }] } });
    expect(request.mock.calls.every(([, init]) => (init?.headers as Record<string, string>).Authorization === 'Bearer access-secret')).toBe(true);
    expect(request.mock.calls.some(([input]) => String(input).includes('format=metadata'))).toBe(true);
  });

  it('requires a payload-bound one-use confirmation before Gmail send', async () => {
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { raw: string };
      const decoded = Buffer.from(body.raw, 'base64url').toString();
      expect(decoded).toContain('To: recipient@example.test');
      expect(decoded).toContain('Subject: Exact subject');
      expect(decoded).toContain('Sensitive body');
      return json({ id: 'sent-1', threadId: 'thread-1' });
    });
    const { root, services } = fixture(request);
    const input: GmailSendInput = { to: ['recipient@example.test'], subject: 'Exact subject', body: 'Sensitive body' };
    const confirmation = services.prepareGmailSend(ID, input, 'AI-REV-1');
    await expect(services.sendGmail(ID, { ...input, subject: 'Changed' }, confirmation.token, 'AI-REV-1')).resolves.toMatchObject({ ok: false });
    const second = services.prepareGmailSend(ID, input, 'AI-REV-1');
    await expect(services.sendGmail(ID, input, second.token, 'AI-REV-1')).resolves.toMatchObject({ ok: true, data: { id: 'sent-1' } });
    await expect(services.sendGmail(ID, input, second.token, 'AI-REV-1')).resolves.toMatchObject({ ok: false });
    expect(readFileSync(join(root, 'accounts', `${ID}.account.enc`), 'utf8')).not.toContain('Sensitive body');
  });

  it('confirms calendar invitations and creates a unique Meet request ID', async () => {
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { conferenceData: { createRequest: { requestId: string } } };
      expect(body.conferenceData.createRequest.requestId).toMatch(/^[0-9a-f-]{36}$/);
      return json({ id: 'event-1', summary: 'Planning', start: { dateTime: '2026-09-12T12:00:00Z' }, end: { dateTime: '2026-09-12T13:00:00Z' }, htmlLink: 'https://calendar.google.com/event?eid=1', conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' }] } });
    });
    const { services } = fixture(request);
    const input: CalendarWriteInput = { summary: 'Planning', start: '2026-09-12T12:00:00Z', end: '2026-09-12T13:00:00Z', attendees: ['guest@example.test'], createMeet: true };
    const confirmation = services.prepareCalendarWrite(ID, 'create', input);
    expect(confirmation.target).toContain('guest@example.test');
    const result = await services.writeCalendarEvent(ID, 'create', input, confirmation.token);
    expect(result).toMatchObject({ ok: true, data: { id: 'event-1', meetLink: 'https://meet.google.com/abc-defg-hij' } });
  });

  it('handles quota retry, policy denial, revocation and offline failures without retrying mutations', async () => {
    const retrying = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 429, { 'Retry-After': '2' }))
      .mockResolvedValueOnce(json({ files: [] }));
    const retried = fixture(retrying);
    await expect(retried.services.listDriveFiles(ID)).resolves.toEqual({ ok: true, data: [] });
    expect(retried.waits).toEqual([2000]);

    const denied = fixture(vi.fn<typeof fetch>(async () => json({}, 403)));
    await expect(denied.services.listDriveFiles(ID)).resolves.toMatchObject({ ok: false, error: { code: 'GOOGLE_SCOPE_MISSING' } });

    const revoked = fixture(vi.fn<typeof fetch>(async () => json({}, 401)));
    await expect(revoked.services.createDriveFile(ID, { name: 'Doc', kind: 'document' })).resolves.toMatchObject({ ok: false, error: { code: 'GOOGLE_REVOKED' } });

    const offlineRequest = vi.fn<typeof fetch>(async () => { throw new Error('offline'); });
    const offline = fixture(offlineRequest);
    const send = { to: ['recipient@example.test'], subject: 'One try', body: 'Body' };
    const confirmation = offline.services.prepareGmailSend(ID, send);
    await expect(offline.services.sendGmail(ID, send, confirmation.token)).resolves.toMatchObject({ ok: false, error: { code: 'GOOGLE_OFFLINE' } });
    expect(offlineRequest).toHaveBeenCalledOnce();
  });

  it('parses narrow Drive, Calendar and Contacts responses', async () => {
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/drive/v3/files')) return json({ files: [{ id: 'f1', name: 'Budget', mimeType: 'application/vnd.google-apps.spreadsheet', webViewLink: 'https://docs.google.com/spreadsheets/d/f1' }] });
      if (url.includes('/calendar/v3/')) return json({ items: [{ id: 'e1', summary: 'Review', start: { dateTime: '2026-09-12T12:00:00Z' }, end: { dateTime: '2026-09-12T13:00:00Z' } }] });
      return json({ connections: [{ resourceName: 'people/c1', names: [{ displayName: 'Ada' }], emailAddresses: [{ value: 'ada@example.test' }] }] });
    });
    const { services } = fixture(request);
    await expect(services.listDriveFiles(ID)).resolves.toMatchObject({ ok: true, data: [{ id: 'f1', name: 'Budget' }] });
    await expect(services.upcomingCalendarEvents(ID)).resolves.toMatchObject({ ok: true, data: [{ id: 'e1', summary: 'Review' }] });
    await expect(services.listContacts(ID)).resolves.toEqual({ ok: true, data: [{ resourceName: 'people/c1', displayName: 'Ada', email: 'ada@example.test' }] });
  });

  it('uploads bounded non-executable bytes through drive.file only', async () => {
    const request = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toContain('/upload/drive/v3/files?uploadType=multipart');
      expect(String((init?.headers as Record<string, string>)['Content-Type'])).toContain('multipart/related');
      return json({ id: 'f2', name: 'notes.txt', mimeType: 'text/plain' });
    });
    const { services } = fixture(request);
    await expect(services.uploadDriveFile(ID, 'notes.txt', 'text/plain', new TextEncoder().encode('safe content'))).resolves.toMatchObject({ ok: true, data: { id: 'f2' } });
    await expect(services.uploadDriveFile(ID, 'program.exe', 'application/octet-stream', new Uint8Array([0x4d, 0x5a, 0, 0]))).resolves.toMatchObject({ ok: false });
    expect(request).toHaveBeenCalledOnce();
  });
});
