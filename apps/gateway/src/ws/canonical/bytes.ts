export const ENVELOPE_BYTES = 16;
export const CANONICAL_PENDING_SWEEP_MS = 250;

export { bytesEqual, bytesHex, copyBytes } from '../../bytes';

export function paneKey(deviceId: string, paneId: string): string {
  return `${deviceId}\0${paneId}`;
}

export function defaultCreateEpoch(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}
