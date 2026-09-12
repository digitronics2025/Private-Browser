import { VaultBroker } from './vault-broker.js';
import { MyVaultSyncClient, VaultSyncConflictError } from './vault-sync.js';

export class VaultSyncController {
  private active?: Promise<void>;

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

  async chooseCloud(): Promise<void> {
    const remote = this.broker.pendingConflict();
    await this.broker.acceptRemote(remote.envelope, remote.version);
  }

  async chooseLocal(): Promise<void> {
    const conflict = this.broker.pendingConflict();
    const { envelope, connection } = this.broker.trustedSyncSnapshot();
    this.broker.markSyncing();
    try {
      const remote = await this.client.pushVault(connection.endpoint, connection.deviceToken, envelope, conflict.version);
      this.broker.markPushSucceeded(envelope, remote.version);
    } catch (error) {
      this.broker.markSyncError();
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
      await this.broker.acceptRemote(remote.envelope, remote.version);
    } catch (error) {
      if (error instanceof VaultSyncConflictError) this.broker.setConflict(error.remote);
      else this.broker.markSyncError();
      throw error;
    }
  }
}
