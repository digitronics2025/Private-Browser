export function concatBytes(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function head(major: number, value: number): Uint8Array<ArrayBuffer> {
  if (value < 24) return Uint8Array.of((major << 5) | value);
  if (value < 256) return Uint8Array.of((major << 5) | 24, value);
  if (value < 65536) return Uint8Array.of((major << 5) | 25, value >>> 8, value & 0xff);
  throw new Error('CBOR value exceeds the supported ceremony bound');
}

export function cborInt(value: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(value)) throw new Error('CBOR integers must be safe integers');
  return value >= 0 ? head(0, value) : head(1, -1 - value);
}

export function cborBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return concatBytes([head(2, value.length), value]);
}

export function cborText(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new TextEncoder().encode(value);
  return concatBytes([head(3, bytes.length), bytes]);
}

export function cborMap(entries: readonly (readonly [Uint8Array, Uint8Array])[]): Uint8Array<ArrayBuffer> {
  return concatBytes([head(5, entries.length), ...entries.flatMap(([key, value]) => [key, value])]);
}
