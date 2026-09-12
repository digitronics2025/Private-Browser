export type SecureDialogKind = 'unlock' | 'edit-login' | 'confirm-delete' | 'confirm-fill' | 'confirm-capture' | 'confirm-replace' | 'confirm-cleanup' | 'pair';

export interface UnlockDialogValue { password: string }
export interface EditLoginDialogValue { title: string; url: string; username: string; password: string; totpSecret?: string }
export interface ConfirmDeleteDialogValue { confirmed: true }
export interface PairDialogValue { endpoint: string; enrollmentCode: string; password: string }
export type SecureDialogValue = UnlockDialogValue | EditLoginDialogValue | ConfirmDeleteDialogValue | PairDialogValue;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid secure dialog submission');
  return value as Record<string, unknown>;
}

function textField(input: Record<string, unknown>, key: string, max: number, required = true): string | undefined {
  const value = input[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.length > max || (required && value.length === 0)) throw new Error('Invalid secure dialog submission');
  return value;
}

export function parseSecureDialogValue(kind: SecureDialogKind, value: unknown): SecureDialogValue {
  const input = record(value);
  if (kind === 'unlock') return { password: textField(input, 'password', 1024)! };
  if (kind === 'edit-login') {
    const url = textField(input, 'url', 2048)!;
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Invalid secure dialog submission');
    return {
      title: textField(input, 'title', 200)!.normalize('NFKC').trim(),
      url: parsed.origin,
      username: textField(input, 'username', 500)!.normalize('NFKC').trim(),
      password: textField(input, 'password', 5000)!,
      totpSecret: textField(input, 'totpSecret', 500, false),
    };
  }
  if (kind === 'pair') {
    const endpoint = new URL(textField(input, 'endpoint', 2048)!);
    if (endpoint.protocol !== 'https:') throw new Error('Invalid secure dialog submission');
    const enrollmentCode = textField(input, 'enrollmentCode', 128)!;
    if (!/^mve_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/.test(enrollmentCode)) throw new Error('Invalid secure dialog submission');
    return { endpoint: endpoint.origin, enrollmentCode, password: textField(input, 'password', 1024)! };
  }
  if (input.confirmed !== true) throw new Error('Invalid secure dialog submission');
  return { confirmed: true };
}
