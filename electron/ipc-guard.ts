const WINDOW_MS = 10_000;
const MAX_CALLS = 300;
const MAX_PAYLOAD_BYTES = 256 * 1024;

interface Budget {
  startedAt: number;
  calls: number;
}

export class IpcGuard {
  private readonly budgets = new Map<number, Budget>();

  check(senderId: number, args: unknown[], now = Date.now()): void {
    let budget = this.budgets.get(senderId);
    if (!budget || now - budget.startedAt >= WINDOW_MS) {
      budget = { startedAt: now, calls: 0 };
      this.budgets.set(senderId, budget);
    }
    budget.calls += 1;
    if (budget.calls > MAX_CALLS) throw new Error('Too many browser commands; wait a moment and try again');

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
  }
}
