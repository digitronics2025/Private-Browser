/** Push subscriptions return their disposer; anything else (an outdated bridge) is treated as nothing to dispose. */
export function disposer(value: unknown): (() => void) | undefined {
  return typeof value === 'function' ? value as () => void : undefined;
}
