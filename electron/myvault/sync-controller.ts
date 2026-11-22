import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { VaultBroker } from './vault-broker.js';
import { MyVaultSyncClient, VaultSyncConflictError, type RemoteVault } from './vault-sync.js';
import type { VaultEnvelope } from './types.js';
import type { VaultEntryDecision } from './conflict-items.js';

export type VaultConflictResolution = 'cloud' | 'local' | { entries: VaultEntryDecision[] };

interface ConflictReview {
  id: string;
  expiresAt: number;
  generation: number;
  local: VaultEnvelope;
  cloud: RemoteVault;
}

export class VaultSyncController {
  private active?: Promise<void>;
  private review?: ConflictReview;

  constructor(private readonly broker: VaultBroker, private readonly client: MyVaultSyncClient) {}

  syncNow(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.perform().finally(() => { this.active = undefined; });
    return this.active;
  }

  async pair(endpoint: string, enrollmentCode: string, password: string): Promise<void> {
    const redeemed = await this.client.redeem(endpoint, enrollmentCode);
    const remote = await this.client.fetchVault(endpoint, redeemed.token);
    if (!remote) throw new Error('The connected MyVault has no cloud envelope');
    this.broker.installEncryptedVault(remote.envelope, { endpoint, deviceToken: redeemed.token, remoteVersion: remote.version, dirty: false, lastSyncAt: new Date().toISOString() });
    await this.broker.unlock(password);
  }

  async reviewConflict() {
    const { envelope: local, generation } = this.broker.trustedSyncSnapshot();
    const cloud = this.broker.pendingConflict();
    const details = await this.broker.conflictReview();
    const after = this.broker.trustedSyncSnapshot();
    if (after.envelope !== local || after.generation !== generation || this.broker.pendingConflict() !== cloud) {
      throw new Error('The conflict changed. Review it again.');
    }
    const id = randomUUID();
    this.review = { id, local, cloud, generation, expiresAt: Date.now() + 5 * 60_000 };
    return { ...details, id, cloudVersion: cloud.version };
  }

  clearConflictReview(): void {
    this.review = undefined;
  }

  resolveConflict(choice: VaultConflictResolution, id: string, assertOwner?: () => void): Promise<void> {
    if (this.active) throw new Error('Wait for the current MyVault sync to finish.');
    const review = this.review;
    this.review = undefined;
    if (!review || review.id !== id || review.expiresAt <= Date.now()) throw new Error('Review the current MyVault conflict first.');
    this.active = this.applyConflictChoice(choice, review, assertOwner).finally(() => { this.active = undefined; });
    return this.active;
  }

  private async applyConflictChoice(choice: VaultConflictResolution, review: ConflictReview, assertOwner?: () => void): Promise<void> {
    const checkCurrent = () => {
      assertOwner?.();
      const snapshot = this.broker.trustedSyncSnapshot();
      if (snapshot.envelope !== review.local || snapshot.generation !== review.generation || this.broker.pendingConflict() !== review.cloud) {
        throw new Error('The conflict changed. Review it again.');
      }
      return snapshot;
    };
    const { connection } = checkCurrent();
    const latest = await this.client.fetchVault(connection.endpoint, connection.deviceToken);
    checkCurrent();
    if (!latest) throw new Error('The cloud copy is unavailable. Review it again when it returns.');
    if (latest.version !== review.cloud.version || !isDeepStrictEqual(latest.envelope, review.cloud.envelope)) {
      this.broker.setConflict(latest);
      throw new Error('The cloud vault changed. Review the latest copies first.');
    }
    this.broker.saveConflictRecovery(review.local, latest.envelope);
    if (choice === 'cloud') {
      if (await this.broker.acceptRemote(latest, { basis: review.local, assertOwner }) === 'conflict') {
        throw new Error('The local vault changed. Review the latest copies first.');
      }
      return;
    }
    const desired = choice === 'local' ? review.local : await this.broker.prepareVaultEntryResolution(review.local, latest.envelope, choice.entries);
    checkCurrent();
    let written: RemoteVault | undefined;
    try {
      written = await this.client.pushVault(connection.endpoint, connection.deviceToken, desired, latest.version);
      if (choice === 'local') {
        this.broker.markPushSucceeded(review.local, written.version);
      } else {
        checkCurrent();
        if (!isDeepStrictEqual(written.envelope, desired)) throw new Error('The cloud copy changed after saving. Review it again.');
        if (await this.broker.acceptRemote(written, { basis: review.local, assertOwner }) === 'conflict') {
          throw new Error('The local vault changed after saving. Review the two copies again.');
        }
      }
    } catch (error) {
      if (error instanceof VaultSyncConflictError) this.broker.setConflict(error.remote);
      else if (written && choice !== 'local') this.broker.setConflict(written);
      throw error;
    }
  }

  private async perform(): Promise<void> {
    const { envelope, connection } = this.broker.trustedSyncSnapshot();
    this.broker.markSyncing();
    try {
      if (connection.dirty) {
        const remote = await this.client.pushVault(connection.endpoint, connection.deviceToken, envelope, connection.remoteVersion);
        this.broker.markPushSucceeded(envelope, remote.version);
        return;
      }
      const remote = await this.client.fetchVault(connection.endpoint, connection.deviceToken);
      if (!remote || remote.version <= connection.remoteVersion) {
        this.broker.markPushSucceeded(envelope, connection.remoteVersion);
        return;
      }
      // A local change made while the pull was in flight must not be overwritten.
      if (await this.broker.acceptRemote(remote, { basis: envelope }) === 'conflict') throw new VaultSyncConflictError(remote);
    } catch (error) {
      if (error instanceof VaultSyncConflictError) this.broker.setConflict(error.remote);
      else this.broker.markSyncError();
      throw error;
    }
  }
}
