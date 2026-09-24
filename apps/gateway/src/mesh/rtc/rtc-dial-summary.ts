import type { PeerConnectionLike } from './native';
import { rtcLog } from './rtc-log';
import {
  type RtcDialAggregate,
  createRtcDialAggregate,
  emptyPairCounts,
  formatPairCounts,
  selectedCandidatePairType,
} from './rtc-peer-helpers';

export function noteRtcDialSummary(
  aggregates: Map<string, RtcDialAggregate>,
  input: {
    peer: string;
    pc: PeerConnectionLike;
    outcome: 'success' | 'failure';
    durationMs: number;
    now: number;
    intervalMs: number;
  }
): void {
  const aggregate = aggregates.get(input.peer) ?? createRtcDialAggregate();
  aggregates.set(input.peer, aggregate);
  const pairType = selectedCandidatePairType(input.pc);
  aggregate[input.outcome === 'success' ? 'successes' : 'failures'][pairType] += 1;
  aggregate.attempts += 1;
  aggregate.durationTotalMs += input.durationMs;
  aggregate.durationMaxMs = Math.max(aggregate.durationMaxMs, input.durationMs);
  if (aggregate.lastEmittedAt !== null && input.now - aggregate.lastEmittedAt < input.intervalMs) {
    return;
  }
  rtcLog('summary', {
    peer: input.peer,
    success_by_pair: formatPairCounts(aggregate.successes),
    failure_by_pair: formatPairCounts(aggregate.failures),
    attempts: aggregate.attempts,
    dial_ms_avg: Math.round(aggregate.durationTotalMs / aggregate.attempts),
    dial_ms_max: Math.round(aggregate.durationMaxMs),
  });
  aggregate.lastEmittedAt = input.now;
  aggregate.successes = emptyPairCounts();
  aggregate.failures = emptyPairCounts();
  aggregate.attempts = 0;
  aggregate.durationTotalMs = 0;
  aggregate.durationMaxMs = 0;
}
