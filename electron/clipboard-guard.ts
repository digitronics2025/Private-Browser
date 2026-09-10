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
export interface ClipboardLike {
  writeText(text: string): Promise<void> | void;
  readText(): Promise<string> | string;
  clear(): void;
}

export const CLIPBOARD_HOLD_MS = 30_000;

export class ClipboardGuard {
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: string;

  constructor(private readonly clipboard: ClipboardLike, private readonly holdMs = CLIPBOARD_HOLD_MS) {}

  /** Copy a secret and schedule its removal. A second copy replaces the first. */
  copy(value: string): void {
    void this.clipboard.writeText(value);
    this.pending = value;
    this.cancelTimer();
    this.timer = setTimeout(() => void this.flush(), this.holdMs);
    // Never hold the process open for a pending clear; quitting flushes instead.
    this.timer.unref?.();
  }

  /**
   * Clear now if the clipboard still holds the pending secret. Safe to call at
   * any time, including twice, and on quit — which is what closes the gap where
   * the app exits inside the hold window and leaves the secret behind.
   */
  async flush(): Promise<boolean> {
    this.cancelTimer();
    const value = this.pending;
    this.pending = undefined;
    if (value === undefined) return false;
    let current: string;
    try {
      current = await this.clipboard.readText();
    } catch {
      return false;
    }
    if (current !== value) return false;
    this.clipboard.clear();
    return true;
  }

  /** True while a copied secret is still scheduled for removal. */
  get isPending(): boolean {
    return this.pending !== undefined;
  }

  private cancelTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
