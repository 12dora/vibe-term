export const ENVELOPE_BYTES = 16;
export const CANONICAL_PENDING_SWEEP_MS = 250;

export function copyBytes(value: Uint8Array): Uint8Array {
  return Uint8Array.from(value);
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

export function bytesHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function paneKey(deviceId: string, paneId: string): string {
  return `${deviceId}\0${paneId}`;
}

export function defaultCreateEpoch(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}
