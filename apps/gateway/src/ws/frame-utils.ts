import { ENVELOPE_OVERHEAD_BYTES } from './types';

export function payloadNeedsChunking(payloadLength: number, maxFrameBytes: number): boolean {
  return payloadLength > maxFrameBytes - ENVELOPE_OVERHEAD_BYTES;
}

export function parseWindowLayoutSize(
  layout: string | undefined
): { cols: number; rows: number } | null {
  if (!layout) return null;
  const match = /^[0-9a-fA-F]{4},(\d+)x(\d+)/.exec(layout);
  if (!match) return null;
  return { cols: Number(match[1]), rows: Number(match[2]) };
}
