import { stamp } from '../mesh/mesh-log';
import type { Carrier } from './carrier';

export type GuardLogEvent =
  | 'backpressure enter'
  | 'backpressure skip'
  | 'backpressure drain'
  | 'terminate';

export function carrierKindOf(carrier: Carrier): string {
  return carrier.logContext?.kind ?? 'unknown';
}

export function logGuardEvent(
  event: GuardLogEvent,
  carrier: Carrier,
  extra: Record<string, unknown>
): void {
  const ctx = carrier.logContext ?? {};
  const fields: Record<string, unknown> = {
    carrier: carrierKindOf(carrier),
    session: ctx.sessionId ?? '-',
    cid: ctx.cid ?? '-',
    node: ctx.nodeId ?? '-',
    ...extra,
  };
  const bits: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    bits.push(`${key}=${String(value)}`);
  }
  console.warn(stamp(`[ws] ${event} ${bits.join(' ')}`));
}

export function carriersByKindLine(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${kind}:${n}`);
  if (parts.length === 0) return 'unknown';
  if (parts.length === 1) return parts[0]?.split(':')[0] ?? 'unknown';
  return parts.join(',');
}
