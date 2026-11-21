import { randomUUID } from 'node:crypto';
import { googleMutationDigest } from './google-confirmations.js';
import type { AccountSpaceId, GoogleActionReceipt } from './types.js';

const RETENTION_MS = 24 * 60 * 60_000;
const MAX_RECEIPTS = 100;

export interface StoredGoogleActionReceipt extends GoogleActionReceipt {
  digest: string;
}

export interface GoogleActionReceiptStore {
  read(account: AccountSpaceId): StoredGoogleActionReceipt[];
  write(account: AccountSpaceId, receipts: StoredGoogleActionReceipt[]): void;
}

export class GoogleActionReceipts {
  constructor(private readonly store: GoogleActionReceiptStore, private readonly now = Date.now) {}

  begin(account: AccountSpaceId, service: 'gmail' | 'drive' | 'calendar', payload: unknown) {
    const at = this.now();
    const current = this.store.read(account).filter((entry) => Date.parse(entry.at) > at - RETENTION_MS);
    const digest = googleMutationDigest({ service, payload });
    const existing = current.find((entry) => entry.digest === digest);
    if (existing) return { fresh: false as const, receipt: publicReceipt(existing) };
    if (current.length >= MAX_RECEIPTS) throw new Error('Too many Google actions were reviewed in the last 24 hours. Use the Google app for any further actions today.');
    const entry: StoredGoogleActionReceipt = { digest, id: randomUUID(), state: 'pending', at: new Date(at).toISOString() };
    this.store.write(account, [entry, ...current]);
    return { fresh: true as const, receipt: publicReceipt(entry) };
  }

  finish(account: AccountSpaceId, id: string, outcome: 'confirmed' | 'unconfirmed' | 'rejected', providerId?: string): GoogleActionReceipt | undefined {
    const current = this.store.read(account);
    const entry = current.find((item) => item.id === id);
    if (!entry) return undefined;
    if (outcome === 'rejected') {
      this.store.write(account, current.filter((item) => item.id !== id));
      return undefined;
    }
    const updated: StoredGoogleActionReceipt = { ...entry, state: outcome, providerId };
    this.store.write(account, current.map((item) => item.id === id ? updated : item));
    return publicReceipt(updated);
  }
}

function publicReceipt({ id, state, at, providerId }: StoredGoogleActionReceipt): GoogleActionReceipt {
  return { id, state, at, providerId };
}

export function readGoogleActionReceipts(value: unknown): StoredGoogleActionReceipt[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, MAX_RECEIPTS).flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return [];
    const { id, state, at, providerId, digest } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id) || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)
      || (state !== 'pending' && state !== 'confirmed' && state !== 'unconfirmed')
      || typeof at !== 'string' || at.length > 30 || !Number.isFinite(Date.parse(at))) return [];
    return [{ id, state, at, digest, providerId: typeof providerId === 'string' && /^[A-Za-z0-9_@.=-]{1,512}$/.test(providerId) ? providerId : undefined }];
  });
}
