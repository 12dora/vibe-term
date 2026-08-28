import { concatBytes } from '../../bytes';
import { bytesEqual } from './bytes';
import type { PaneReplayGapReason, ReplayChunk } from './types';

export type HistoryRangeDecision =
  | { kind: 'gap'; reason: PaneReplayGapReason }
  | { kind: 'page'; beforeSeq: bigint; oldestSeq: bigint; limit: number };

export function selectHistoryRange(input: {
  paneEpoch: Uint8Array;
  expectedEpoch: Uint8Array;
  beforeSeq: bigint;
  latestSeq: bigint;
  oldestSeq: bigint;
  limit: number;
}): HistoryRangeDecision {
  if (!bytesEqual(input.expectedEpoch, input.paneEpoch)) {
    return { kind: 'gap', reason: 'epoch_changed' };
  }
  if (input.beforeSeq > input.latestSeq) {
    return { kind: 'gap', reason: 'pane_gap' };
  }
  if (input.beforeSeq < input.oldestSeq) {
    return { kind: 'gap', reason: 'cache_evicted' };
  }
  return {
    kind: 'page',
    beforeSeq: input.beforeSeq,
    oldestSeq: input.oldestSeq,
    limit: input.limit,
  };
}

export function sliceReplayChunk(
  chunk: ReplayChunk,
  beforeSeq: bigint,
  remaining: number
): { data: Uint8Array; seqStart: bigint } | null {
  if (chunk.seqStart >= beforeSeq) return null;
  const upper = chunk.seqEnd > beforeSeq ? beforeSeq : chunk.seqEnd;
  if (upper <= chunk.seqStart) return null;
  const available = Number(upper - chunk.seqStart);
  const take = Math.min(available, remaining);
  const endOffset = Number(upper - chunk.seqStart);
  return {
    data: chunk.data.slice(endOffset - take, endOffset),
    seqStart: upper - BigInt(take),
  };
}

export function assembleHistoryChunks(
  replay: readonly ReplayChunk[],
  beforeSeq: bigint,
  limit: number
): { data: Uint8Array; seqStart: bigint } {
  const reverseParts: Uint8Array[] = [];
  let remaining = limit;
  let seqStart = beforeSeq;
  for (let index = replay.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const chunk = replay[index];
    if (!chunk) continue;
    const part = sliceReplayChunk(chunk, beforeSeq, remaining);
    if (!part) continue;
    reverseParts.push(part.data);
    remaining -= part.data.byteLength;
    seqStart = part.seqStart;
  }
  reverseParts.reverse();
  return { data: concatBytes(...reverseParts), seqStart };
}
