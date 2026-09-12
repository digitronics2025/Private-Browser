import { createHash, randomUUID } from 'node:crypto';
import type { AccountSpaceId, GoogleMutationConfirmation, GoogleService } from './types.js';

interface PendingConfirmation {
  publicValue: GoogleMutationConfirmation;
  payloadHash: string;
}

export class GoogleMutationConfirmations {
  private readonly pending = new Map<string, PendingConfirmation>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  prepare(
    accountSpaceId: AccountSpaceId,
    service: GoogleService,
    action: string,
    target: string,
    payload: unknown,
    sourceRevision?: string,
  ): GoogleMutationConfirmation {
    if (!action || action.length > 100 || !target || target.length > 500) throw new Error('Invalid Google mutation confirmation');
    const token = randomUUID();
    const expiresAt = new Date(this.now().getTime() + 5 * 60_000).toISOString();
    const publicValue = { token, accountSpaceId, service, action, target, sourceRevision, expiresAt };
    this.pending.set(token, { publicValue, payloadHash: hashPayload(payload) });
    while (this.pending.size > 50) this.pending.delete(this.pending.keys().next().value!);
    return publicValue;
  }

  consume(token: string, accountSpaceId: AccountSpaceId, service: GoogleService, payload: unknown, sourceRevision?: string): void {
    const pending = this.pending.get(token);
    this.pending.delete(token);
    if (!pending || Date.parse(pending.publicValue.expiresAt) < this.now().getTime()) throw new Error('Google mutation confirmation expired or was already used');
    if (pending.publicValue.accountSpaceId !== accountSpaceId
      || pending.publicValue.service !== service
      || pending.publicValue.sourceRevision !== sourceRevision
      || pending.payloadHash !== hashPayload(payload)) {
      throw new Error('Google mutation confirmation does not match the exact action');
    }
  }

  clearAccount(accountSpaceId: AccountSpaceId): void {
    for (const [token, pending] of this.pending) if (pending.publicValue.accountSpaceId === accountSpaceId) this.pending.delete(token);
  }
}

function hashPayload(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}
