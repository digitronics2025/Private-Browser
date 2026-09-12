import { randomUUID } from 'node:crypto';
import type {
  AccountSpaceId,
  CalendarEventSummary,
  ContactSummary,
  DriveFileSummary,
  GmailMessageHeader,
  GmailOverview,
  GoogleModule,
  GoogleMutationConfirmation,
  GoogleOperationResult,
  GoogleService,
} from './types.js';
import { requireBoundedStringArray, requireBoundedText } from './account-space-validation.js';
import { GoogleMutationConfirmations } from './google-confirmations.js';
import { GoogleTokenBroker, GoogleTokenError, parseRetryAfter, readBoundedJson } from './google-token-broker.js';

const API_TIMEOUT_MS = 10_000;
const MAX_API_RESPONSE_BYTES = 2 * 1024 * 1024;
const SAFE_READ_ATTEMPTS = 3;
const MAX_DRIVE_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface GmailSendInput {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
}

export interface CalendarWriteInput {
  calendarId?: string;
  eventId?: string;
  summary: string;
  description?: string;
  start: string;
  end: string;
  attendees?: string[];
  createMeet?: boolean;
}

export interface DriveCreateInput {
  name: string;
  kind: 'document' | 'spreadsheet' | 'folder';
}

export class GoogleServices {
  constructor(
    private readonly tokens: GoogleTokenBroker,
    private readonly confirmations = new GoogleMutationConfirmations(),
    private readonly request: typeof fetch = fetch,
    private readonly wait: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly random: () => number = Math.random,
  ) {}

  prepareGmailSend(accountSpaceId: AccountSpaceId, input: GmailSendInput, sourceRevision?: string): GoogleMutationConfirmation {
    const normalized = normalizeGmailSend(input);
    return this.confirmations.prepare(accountSpaceId, 'gmail', 'Send email', normalized.to.join(', '), normalized, sourceRevision);
  }

  async sendGmail(accountSpaceId: AccountSpaceId, input: GmailSendInput, confirmationToken: string, sourceRevision?: string, signal?: AbortSignal): Promise<GoogleOperationResult<{ id: string; threadId?: string }>> {
    const normalized = normalizeGmailSend(input);
    try {
      this.confirmations.consume(confirmationToken, accountSpaceId, 'gmail', normalized, sourceRevision);
      const raw = encodeEmail(normalized);
      const response = await this.apiJson(accountSpaceId, 'gmail-send', 'gmail', 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw }),
      }, false, signal);
      const record = requireRecord(response);
      return success({ id: requireString(record.id, 'message id', 512), threadId: optionalString(record.threadId, 512) });
    } catch (error) { return operationFailure(error); }
  }

  async gmailOverview(accountSpaceId: AccountSpaceId, signal?: AbortSignal): Promise<GoogleOperationResult<GmailOverview>> {
    try {
      const label = requireRecord(await this.apiJson(accountSpaceId, 'gmail-metadata', 'gmail', 'https://gmail.googleapis.com/gmail/v1/users/me/labels/INBOX?fields=messagesUnread', {}, true, signal));
      const listed = requireRecord(await this.apiJson(accountSpaceId, 'gmail-metadata', 'gmail', 'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10&labelIds=INBOX', {}, true, signal));
      const messages = Array.isArray(listed.messages) ? listed.messages.slice(0, 10) : [];
      const recent: GmailMessageHeader[] = [];
      for (const item of messages) {
        const id = requireString(requireRecord(item).id, 'message id', 512);
        const message = requireRecord(await this.apiJson(accountSpaceId, 'gmail-metadata', 'gmail', `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, {}, true, signal));
        recent.push(parseGmailHeader(message));
      }
      return success({ unreadCount: boundedNumber(label.messagesUnread), recent });
    } catch (error) { return operationFailure(error); }
  }

  async searchGmail(accountSpaceId: AccountSpaceId, queryValue: string, signal?: AbortSignal): Promise<GoogleOperationResult<GmailMessageHeader[]>> {
    const query = requireBoundedText(queryValue, 'Gmail search query', 500).trim();
    try {
      const listed = requireRecord(await this.apiJson(accountSpaceId, 'gmail-read', 'gmail', `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20&q=${encodeURIComponent(query)}`, {}, true, signal));
      const result: GmailMessageHeader[] = [];
      for (const item of Array.isArray(listed.messages) ? listed.messages.slice(0, 20) : []) {
        const id = requireString(requireRecord(item).id, 'message id', 512);
        const message = requireRecord(await this.apiJson(accountSpaceId, 'gmail-read', 'gmail', `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, {}, true, signal));
        result.push(parseGmailHeader(message));
      }
      return success(result);
    } catch (error) { return operationFailure(error); }
  }

  async listDriveFiles(accountSpaceId: AccountSpaceId, queryValue = '', wholeDrive = false, signal?: AbortSignal): Promise<GoogleOperationResult<DriveFileSummary[]>> {
    const query = requireBoundedText(queryValue, 'Drive search query', 500).trim();
    const module: GoogleModule = wholeDrive ? 'drive-metadata' : 'drive-files';
    const parameters = new URLSearchParams({ pageSize: '20', orderBy: 'modifiedTime desc', fields: 'files(id,name,mimeType,modifiedTime,webViewLink)' });
    if (query) parameters.set('q', `name contains '${query.replaceAll("'", "\\'")}' and trashed = false`);
    try {
      const payload = requireRecord(await this.apiJson(accountSpaceId, module, 'drive', `https://www.googleapis.com/drive/v3/files?${parameters}`, {}, true, signal));
      const files = Array.isArray(payload.files) ? payload.files.slice(0, 20).map(parseDriveFile) : [];
      return success(files);
    } catch (error) { return operationFailure(error); }
  }

  async createDriveFile(accountSpaceId: AccountSpaceId, input: DriveCreateInput, signal?: AbortSignal): Promise<GoogleOperationResult<DriveFileSummary>> {
    const name = requireBoundedText(input.name, 'Drive file name', 255).trim();
    const mimeType = input.kind === 'document' ? 'application/vnd.google-apps.document'
      : input.kind === 'spreadsheet' ? 'application/vnd.google-apps.spreadsheet'
        : input.kind === 'folder' ? 'application/vnd.google-apps.folder' : '';
    if (!mimeType) return operationFailure(new Error('Invalid Drive file kind'));
    try {
      const payload = await this.apiJson(accountSpaceId, 'drive-files', 'drive', 'https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,modifiedTime,webViewLink', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType }),
      }, false, signal);
      return success(parseDriveFile(payload));
    } catch (error) { return operationFailure(error); }
  }

  async uploadDriveFile(accountSpaceId: AccountSpaceId, nameValue: string, mimeTypeValue: string, bytes: Uint8Array, signal?: AbortSignal): Promise<GoogleOperationResult<DriveFileSummary>> {
    const name = requireBoundedText(nameValue, 'Drive upload name', 255).trim();
    const mimeType = requireBoundedText(mimeTypeValue, 'Drive upload MIME type', 255).trim().toLowerCase();
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_DRIVE_UPLOAD_BYTES || isExecutable(bytes)) {
      return operationFailure(new Error('Drive upload is empty, too large, or executable'));
    }
    if (!/^[a-z0-9][a-z0-9!#$&^_.+-]+\/[a-z0-9][a-z0-9!#$&^_.+-]+$/.test(mimeType)) {
      return operationFailure(new Error('Invalid Drive upload MIME type'));
    }
    const boundary = `private-browser-${randomUUID()}`;
    const prefix = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name })}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`);
    const suffix = Buffer.from(`\r\n--${boundary}--`);
    const body = new Uint8Array(Buffer.concat([prefix, Buffer.from(bytes), suffix]));
    try {
      const payload = await this.apiJson(accountSpaceId, 'drive-files', 'drive', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,modifiedTime,webViewLink', {
        method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
      }, false, signal);
      return success(parseDriveFile(payload));
    } catch (error) { return operationFailure(error); }
  }

  prepareDriveShare(accountSpaceId: AccountSpaceId, fileId: string, email: string, role: 'reader' | 'writer', sourceRevision?: string): GoogleMutationConfirmation {
    const payload = { fileId: requireIdentifier(fileId), email: requireEmail(email), role };
    return this.confirmations.prepare(accountSpaceId, 'drive', 'Share Drive file', `${payload.fileId} with ${payload.email} as ${role}`, payload, sourceRevision);
  }

  async shareDriveFile(accountSpaceId: AccountSpaceId, fileId: string, email: string, role: 'reader' | 'writer', token: string, sourceRevision?: string, signal?: AbortSignal): Promise<GoogleOperationResult<{ id: string }>> {
    const payload = { fileId: requireIdentifier(fileId), email: requireEmail(email), role };
    try {
      this.confirmations.consume(token, accountSpaceId, 'drive', payload, sourceRevision);
      const result = requireRecord(await this.apiJson(accountSpaceId, 'drive-files', 'drive', `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(payload.fileId)}/permissions?sendNotificationEmail=true&fields=id`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'user', role, emailAddress: payload.email }),
      }, false, signal));
      return success({ id: requireString(result.id, 'permission id', 512) });
    } catch (error) { return operationFailure(error); }
  }

  async upcomingCalendarEvents(accountSpaceId: AccountSpaceId, queryValue = '', signal?: AbortSignal): Promise<GoogleOperationResult<CalendarEventSummary[]>> {
    const query = requireBoundedText(queryValue, 'Calendar search query', 500).trim();
    const parameters = new URLSearchParams({ maxResults: '20', singleEvents: 'true', orderBy: 'startTime', timeMin: new Date().toISOString() });
    if (query) parameters.set('q', query);
    try {
      const payload = requireRecord(await this.apiJson(accountSpaceId, 'calendar-read', 'calendar', `https://www.googleapis.com/calendar/v3/calendars/primary/events?${parameters}`, {}, true, signal));
      return success(Array.isArray(payload.items) ? payload.items.slice(0, 20).map(parseCalendarEvent) : []);
    } catch (error) { return operationFailure(error); }
  }

  prepareCalendarWrite(accountSpaceId: AccountSpaceId, action: 'create' | 'update' | 'delete', input: CalendarWriteInput, sourceRevision?: string): GoogleMutationConfirmation {
    const normalized = normalizeCalendarInput(input);
    const attendeeTarget = normalized.attendees.length ? `; invite ${normalized.attendees.join(', ')}` : '';
    return this.confirmations.prepare(accountSpaceId, 'calendar', `${action} calendar event`, `${normalized.summary}${attendeeTarget}`, { action, input: normalized }, sourceRevision);
  }

  async writeCalendarEvent(accountSpaceId: AccountSpaceId, action: 'create' | 'update' | 'delete', input: CalendarWriteInput, token: string, sourceRevision?: string, signal?: AbortSignal): Promise<GoogleOperationResult<CalendarEventSummary | { deleted: true }>> {
    const normalized = normalizeCalendarInput(input);
    const confirmationPayload = { action, input: normalized };
    try {
      this.confirmations.consume(token, accountSpaceId, 'calendar', confirmationPayload, sourceRevision);
      const calendarId = encodeURIComponent(normalized.calendarId);
      if (action === 'delete') {
        if (!normalized.eventId) throw new Error('Calendar event identifier is required');
        await this.apiJson(accountSpaceId, 'calendar-write', 'calendar', `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(normalized.eventId)}?sendUpdates=all`, { method: 'DELETE' }, false, signal, true);
        return success({ deleted: true });
      }
      const body = {
        summary: normalized.summary,
        description: normalized.description || undefined,
        start: { dateTime: normalized.start },
        end: { dateTime: normalized.end },
        attendees: normalized.attendees.map((email) => ({ email })),
        conferenceData: normalized.createMeet ? { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } } : undefined,
      };
      const eventPath = action === 'update'
        ? `/events/${encodeURIComponent(normalized.eventId ?? '')}`
        : '/events';
      if (action === 'update' && !normalized.eventId) throw new Error('Calendar event identifier is required');
      const payload = await this.apiJson(accountSpaceId, 'calendar-write', 'calendar', `https://www.googleapis.com/calendar/v3/calendars/${calendarId}${eventPath}?sendUpdates=all&conferenceDataVersion=1`, {
        method: action === 'update' ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }, false, signal);
      return success(parseCalendarEvent(payload));
    } catch (error) { return operationFailure(error); }
  }

  async listContacts(accountSpaceId: AccountSpaceId, signal?: AbortSignal): Promise<GoogleOperationResult<ContactSummary[]>> {
    try {
      const payload = requireRecord(await this.apiJson(accountSpaceId, 'contacts-read', 'contacts', 'https://people.googleapis.com/v1/people/me/connections?pageSize=100&personFields=names,emailAddresses', {}, true, signal));
      const contacts: ContactSummary[] = [];
      for (const personValue of Array.isArray(payload.connections) ? payload.connections.slice(0, 100) : []) {
        const person = requireRecord(personValue);
        const name = Array.isArray(person.names) ? requireRecord(person.names[0] ?? {}) : {};
        const email = Array.isArray(person.emailAddresses) ? requireRecord(person.emailAddresses[0] ?? {}) : {};
        if (typeof email.value !== 'string') continue;
        contacts.push({
          resourceName: requireString(person.resourceName, 'contact resource', 512),
          displayName: optionalString(name.displayName, 200) ?? email.value,
          email: requireEmail(email.value),
        });
      }
      return success(contacts);
    } catch (error) { return operationFailure(error); }
  }

  clearAccount(accountSpaceId: AccountSpaceId): void {
    this.tokens.clear(accountSpaceId);
    this.confirmations.clearAccount(accountSpaceId);
  }

  private async apiJson(
    accountSpaceId: AccountSpaceId,
    module: GoogleModule,
    _service: GoogleService,
    urlValue: string,
    init: RequestInit,
    safeRead: boolean,
    callerSignal?: AbortSignal,
    allowEmpty = false,
  ): Promise<unknown> {
    const url = new URL(urlValue);
    if (url.protocol !== 'https:' || !['gmail.googleapis.com', 'www.googleapis.com', 'people.googleapis.com'].includes(url.hostname)) {
      throw new Error('Refused an unexpected Google API endpoint');
    }
    const attempts = safeRead ? SAFE_READ_ATTEMPTS : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (callerSignal?.aborted) throw new Error('Google operation was cancelled');
      const token = await this.tokens.getAccessToken(accountSpaceId, module, callerSignal);
      const controller = new AbortController();
      const cancel = () => controller.abort();
      callerSignal?.addEventListener('abort', cancel, { once: true });
      const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
      try {
        const response = await this.request(url, {
          ...init,
          headers: { ...init.headers, Authorization: `Bearer ${token}`, Accept: 'application/json' },
          signal: controller.signal,
          redirect: 'error',
        });
        if (response.status === 401) {
          this.tokens.invalidate(accountSpaceId);
          if (safeRead && attempt + 1 < attempts) continue;
          throw new GoogleTokenError('revoked', 'Google access was revoked');
        }
        if (response.status === 403) throw new GoogleTokenError('scope-missing', 'Google policy denied this operation');
        if (response.status === 429) {
          const seconds = parseRetryAfter(response.headers.get('retry-after'));
          if (safeRead && attempt + 1 < attempts) {
            await this.wait(Math.min(seconds * 1000, 30_000) + Math.floor(this.random() * 250));
            continue;
          }
          throw new GoogleTokenError('quota', 'Google API quota is temporarily limited', seconds);
        }
        if (safeRead && [500, 502, 503, 504].includes(response.status) && attempt + 1 < attempts) {
          await this.wait(250 * (2 ** attempt) + Math.floor(this.random() * 250));
          continue;
        }
        if (!response.ok) throw new Error('Google API request failed');
        if (allowEmpty && response.status === 204) return {};
        return await readBoundedJson(response, MAX_API_RESPONSE_BYTES);
      } catch (error) {
        if (error instanceof GoogleTokenError) throw error;
        if (safeRead && attempt + 1 < attempts) {
          await this.wait(250 * (2 ** attempt) + Math.floor(this.random() * 250));
          continue;
        }
        throw new GoogleTokenError('offline', 'Google API is unavailable');
      } finally {
        clearTimeout(timeout);
        callerSignal?.removeEventListener('abort', cancel);
      }
    }
    throw new GoogleTokenError('offline', 'Google API is unavailable');
  }
}

function normalizeGmailSend(input: GmailSendInput): Required<GmailSendInput> {
  const to = requireBoundedStringArray(input.to, 'Gmail recipients').map(requireEmail);
  const cc = requireBoundedStringArray(input.cc ?? [], 'Gmail copy recipients').map(requireEmail);
  if (to.length === 0) throw new Error('At least one recipient is required');
  return {
    to,
    cc,
    subject: requireBoundedText(input.subject, 'Gmail subject', 998).replace(/[\r\n]/g, ' '),
    body: requireBoundedText(input.body, 'Gmail body', 64 * 1024),
  };
}

function encodeEmail(input: Required<GmailSendInput>): string {
  const lines = [`To: ${input.to.join(', ')}`];
  if (input.cc.length) lines.push(`Cc: ${input.cc.join(', ')}`);
  lines.push(`Subject: ${input.subject}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', '', input.body);
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

function normalizeCalendarInput(input: CalendarWriteInput) {
  const start = requireIsoTimestamp(input.start, 'Calendar start');
  const end = requireIsoTimestamp(input.end, 'Calendar end');
  if (Date.parse(end) <= Date.parse(start)) throw new Error('Calendar end must be after start');
  return {
    calendarId: input.calendarId ? requireIdentifier(input.calendarId) : 'primary',
    eventId: input.eventId ? requireIdentifier(input.eventId) : undefined,
    summary: requireBoundedText(input.summary, 'Calendar summary', 500).trim(),
    description: requireBoundedText(input.description ?? '', 'Calendar description', 16 * 1024),
    start,
    end,
    attendees: requireBoundedStringArray(input.attendees ?? [], 'Calendar attendees').map(requireEmail),
    createMeet: input.createMeet === true,
  };
}

function parseGmailHeader(value: unknown): GmailMessageHeader {
  const record = requireRecord(value);
  const payload = requireRecord(record.payload);
  const headers = Array.isArray(payload.headers) ? payload.headers.map(requireRecord) : [];
  const header = (name: string) => optionalString(headers.find((entry) => String(entry.name).toLowerCase() === name.toLowerCase())?.value, 2000) ?? '';
  return { id: requireString(record.id, 'message id', 512), threadId: requireString(record.threadId, 'thread id', 512), from: header('From'), subject: header('Subject'), date: header('Date') };
}

function parseDriveFile(value: unknown): DriveFileSummary {
  const record = requireRecord(value);
  return {
    id: requireString(record.id, 'Drive file id', 512),
    name: requireString(record.name, 'Drive file name', 1000),
    mimeType: requireString(record.mimeType, 'Drive MIME type', 255),
    modifiedTime: optionalString(record.modifiedTime, 100),
    webViewLink: optionalHttpsUrl(record.webViewLink),
  };
}

function parseCalendarEvent(value: unknown): CalendarEventSummary {
  const record = requireRecord(value);
  const start = requireRecord(record.start);
  const end = requireRecord(record.end ?? {});
  const conference = requireRecord(record.conferenceData ?? {});
  const entryPoints = Array.isArray(conference.entryPoints) ? conference.entryPoints.map(requireRecord) : [];
  return {
    id: requireString(record.id, 'Calendar event id', 512),
    summary: optionalString(record.summary, 1000) ?? '(untitled event)',
    start: requireString(start.dateTime ?? start.date, 'Calendar event start', 100),
    end: optionalString(end.dateTime ?? end.date, 100),
    htmlLink: optionalHttpsUrl(record.htmlLink),
    meetLink: optionalHttpsUrl(entryPoints.find((entry) => entry.entryPointType === 'video')?.uri),
  };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Google returned an invalid response');
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) throw new Error(`Invalid ${field}`);
  return value;
}

function optionalString(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' && value.length <= maximum ? value : undefined;
}

function optionalHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096) return undefined;
  try { const url = new URL(value); return url.protocol === 'https:' ? url.toString() : undefined; } catch { return undefined; }
}

function requireEmail(value: string): string {
  const email = requireBoundedText(value, 'email address', 320).trim();
  if (!/^\S+@\S+\.\S+$/.test(email) || /[\r\n]/.test(email)) throw new Error('Invalid email address');
  return email;
}

function requireIdentifier(value: string): string {
  const id = requireBoundedText(value, 'Google resource identifier', 512).trim();
  if (!/^[a-zA-Z0-9_@.=-]+$/.test(id)) throw new Error('Invalid Google resource identifier');
  return id;
}

function requireIsoTimestamp(value: string, field: string): string {
  const timestamp = requireBoundedText(value, field, 100);
  if (Number.isNaN(Date.parse(timestamp))) throw new Error(`Invalid ${field}`);
  return timestamp;
}

function boundedNumber(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000_000) : 0;
}

function isExecutable(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 2) return false;
  const first = bytes[0];
  const second = bytes[1];
  return (first === 0x4d && second === 0x5a)
    || (first === 0x7f && second === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46)
    || (first === 0xca && second === 0xfe && bytes[2] === 0xba && bytes[3] === 0xbe);
}

function success<T>(data: T): GoogleOperationResult<T> { return { ok: true, data }; }

function operationFailure<T>(error: unknown): GoogleOperationResult<T> {
  const requestId = randomUUID();
  if (error instanceof GoogleTokenError) {
    const code = error.code === 'quota' ? 'GOOGLE_QUOTA'
      : error.code === 'revoked' ? 'GOOGLE_REVOKED'
        : error.code === 'scope-missing' ? 'GOOGLE_SCOPE_MISSING'
          : error.code === 'invalid-response' ? 'GOOGLE_INVALID_RESPONSE'
            : 'GOOGLE_OFFLINE';
    return { ok: false, error: { code, message: error.message, requestId, retryAfterSeconds: error.retryAfterSeconds } };
  }
  return { ok: false, error: { code: 'GOOGLE_INTERNAL', message: error instanceof Error ? error.message : 'Google operation failed', requestId } };
}
