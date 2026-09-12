const WINDOW_MS = 10_000;
const MAX_CALLS = 300;
const DEFAULT_CHANNEL_MAX_CALLS = 100;
const MAX_PAYLOAD_BYTES = 256 * 1024;

interface Budget {
  startedAt: number;
  calls: number;
}

export class IpcGuard {
  private readonly budgets = new Map<number, Budget>();
  private readonly channelBudgets = new Map<string, Budget>();

  check(senderId: number, channel: string, args: unknown[], now = Date.now()): void {
    let budget = this.budgets.get(senderId);
    if (!budget || now - budget.startedAt >= WINDOW_MS) {
      budget = { startedAt: now, calls: 0 };
      this.budgets.set(senderId, budget);
    }
    budget.calls += 1;
    if (budget.calls > MAX_CALLS) throw new Error('Too many browser commands; wait a moment and try again');

    const channelKey = `${senderId}:${channel}`;
    let channelBudget = this.channelBudgets.get(channelKey);
    if (!channelBudget || now - channelBudget.startedAt >= WINDOW_MS) {
      channelBudget = { startedAt: now, calls: 0 };
      this.channelBudgets.set(channelKey, channelBudget);
    }
    channelBudget.calls += 1;
    const maximum = sensitiveChannelMaximum(channel);
    if (channelBudget.calls > maximum) throw new Error('Too many requests for this browser command; wait a moment and try again');

    let serialized: string | undefined;
    try { serialized = JSON.stringify(args); } catch { throw new Error('Invalid browser command payload'); }
    if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
      throw new Error('Browser command payload is too large');
    }

    if (this.budgets.size > 20) {
      for (const [id, candidate] of this.budgets) {
        if (now - candidate.startedAt >= WINDOW_MS) this.budgets.delete(id);
      }
    }
    if (this.channelBudgets.size > 200) {
      for (const [key, candidate] of this.channelBudgets) {
        if (now - candidate.startedAt >= WINDOW_MS) this.channelBudgets.delete(key);
      }
    }
  }
}

function sensitiveChannelMaximum(channel: string): number {
  if (channel.startsWith('google:') || channel.startsWith('backup:')) return 20;
  if (channel === 'accounts:delete' || channel === 'accounts:clear-data' || channel === 'permissions:respond') return 10;
  return DEFAULT_CHANNEL_MAX_CALLS;
}
