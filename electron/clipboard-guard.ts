/**
 * Holds a copied secret on the clipboard for a bounded time, then removes it —
 * but only when the clipboard still holds the value we put there, so an
 * auto-clear can never destroy something the user copied afterwards.
 *
 * The clipboard API changed shape across Electron versions: `readText()` and
 * `writeText()` are synchronous in older majors and promise-returning from the
 * W3C-modelled API in Electron 44. Both are accepted here so the guard does not
 * silently stop clearing the next time that changes.
 */
import { createHash } from 'node:crypto';

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64');
}

export interface ClipboardLike {
  writeText(text: string): Promise<void> | void;
  readText(): Promise<string> | string;
  clear(): Promise<void> | void;
}

export const CLIPBOARD_HOLD_MS = 30_000;

export class ClipboardGuard {
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: { digest: string; expiresAt: number };
  private operation = Promise.resolve();
  private pendingWrites = 0;
  private clearing = false;

  constructor(private readonly clipboard: ClipboardLike, private readonly holdMs = CLIPBOARD_HOLD_MS) {}

  /** Copy a secret and schedule its removal. A second copy replaces the first. */
  copy(value: string, beforeWrite?: () => void): Promise<void> {
    this.pendingWrites += 1;
    return this.enqueue(async () => {
      beforeWrite?.();
      await this.clipboard.writeText(value);
      this.cancelTimer();
      const pending = { digest: digest(value), expiresAt: Date.now() + this.holdMs };
      this.pending = pending;
      this.timer = setTimeout(() => { void this.enqueue(() => this.clearIfUnchanged(pending)); }, this.holdMs);
      this.timer.unref?.();
    }).finally(() => { this.pendingWrites -= 1; });
  }

  /**
   * Clear now if the clipboard still holds the pending secret. Safe to call at
   * any time, including twice, and on quit — which is what closes the gap where
   * the app exits inside the hold window and leaves the secret behind.
   */
  flush(): Promise<boolean> {
    return this.enqueue(() => this.clearIfUnchanged(this.pending));
  }

  private async clearIfUnchanged(pending: typeof this.pending): Promise<boolean> {
    if (!pending || this.pending !== pending) return false;
    this.cancelTimer();
    this.pending = undefined;
    this.clearing = true;
    try {
      if (digest(await this.clipboard.readText()) !== pending.digest) return false;
      await this.clipboard.clear();
      return true;
    } catch {
      return false;
    } finally {
      this.clearing = false;
    }
  }

  /** True while a copied secret is still scheduled for removal. */
  get isPending(): boolean {
    return this.pending !== undefined || this.pendingWrites > 0 || this.clearing;
  }

  get expiresAt(): number | undefined {
    return this.pending?.expiresAt;
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const result = this.operation.then(action);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  private cancelTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
