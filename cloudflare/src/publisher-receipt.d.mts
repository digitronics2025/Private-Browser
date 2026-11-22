export type PublisherStatus = { status: 'unsigned' } | { status: 'verified'; name: string };
export const MAX_PUBLISHER_RECEIPT_BYTES: number;
export function parsePublisherReceipt(value: unknown, sha256: string): PublisherStatus | undefined;
