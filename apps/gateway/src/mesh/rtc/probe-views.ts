import type { StunProbeRecord } from './stun-probe-types';
import type { TurnProbeRecord } from './turn-probe';

// 探测栈（stun-probe / turn-probe）加载时把只读视图登记到这里；未加载即从未探测过，视图为空。
let stunRows: () => readonly StunProbeRecord[] = () => [];
let turnRows: () => readonly TurnProbeRecord[] = () => [];
let turnUrl: (configured: unknown) => string | null = () => null;

export function publishStunProbeRows(rows: () => readonly StunProbeRecord[]): void {
  stunRows = rows;
}

export function publishTurnProbeRows(
  rows: () => readonly TurnProbeRecord[],
  urlOf: (configured: unknown) => string | null
): void {
  turnRows = rows;
  turnUrl = urlOf;
}

export function stunProbeRows(): readonly StunProbeRecord[] {
  return stunRows();
}

export function latestProbeForUrl<T extends { url: string }>(
  url: string | null,
  probes: readonly T[]
): T | null {
  if (!url) return null;
  for (let i = probes.length - 1; i >= 0; i--) {
    const row = probes[i];
    if (row?.url === url) return row;
  }
  return null;
}

export function matchingTurnProbeRow(configured: unknown): TurnProbeRecord | null {
  return latestProbeForUrl(turnUrl(configured), turnRows());
}
