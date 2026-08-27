import { bytesEqual, cloneIdentity, copyBytes, safeCallback } from './bytes';
import { assembleHistoryChunks, selectHistoryRange } from './history-range';
import type { RetentionKernel } from './kernel';
import type {
  PaneDataSegment,
  PaneHistoryPage,
  PaneIdentity,
  PaneReplayGap,
  PaneReplayGapReason,
  PaneReplayPlan,
  PaneScreenCheckpoint,
  PaneState,
  PaneSubscriptionRequest,
  PaneTerminalCursor,
} from './types';

export class PaneReplayStore {
  constructor(private readonly kernel: RetentionKernel) {}

  createPane(paneId: string, paneEpoch: Uint8Array, known: boolean): PaneState {
    if (paneEpoch.byteLength !== 16) throw new Error('pane epoch must be 16 bytes');
    const state: PaneState = {
      paneId,
      paneEpoch: copyBytes(paneEpoch),
      known,
      latestSeq: 0n,
      dirtyWhileCold: false,
      mode: 'cold',
      explicitHot: false,
      graceUntil: null,
      hotUntil: null,
      lastTouchedAt: this.kernel.now(),
      createOrder: this.kernel.nextCreateOrder++,
      replay: [],
      replayBytes: 0,
      checkpoint: null,
    };
    this.kernel.syncHotIndex(state);
    return state;
  }

  ensurePane(paneId: string, paneEpoch: Uint8Array, known: boolean): PaneState {
    let state = this.kernel.panes.get(paneId);
    if (!state) {
      state = this.createPane(paneId, paneEpoch, known);
      this.kernel.panes.set(paneId, state);
      return state;
    }
    if (known) state.known = true;
    if (!bytesEqual(state.paneEpoch, paneEpoch)) {
      this.rotatePaneEpoch(state, paneEpoch);
    }
    return state;
  }

  rotatePaneEpoch(state: PaneState, paneEpoch: Uint8Array): void {
    const previousEpoch = state.paneEpoch;
    const previousSeq = state.latestSeq;
    const retained = this.kernel.paneRetainedBytes(state);
    if (retained > 0) {
      this.recordEviction('epoch_changed');
      this.kernel.adjustRetainedBytes(-retained);
    }
    state.paneEpoch = copyBytes(paneEpoch);
    state.latestSeq = 0n;
    state.dirtyWhileCold = false;
    state.replay = [];
    state.replayBytes = 0;
    state.checkpoint = null;
    state.mode = 'cold';
    state.explicitHot = false;
    state.graceUntil = null;
    state.hotUntil = null;
    this.kernel.syncHotIndex(state);
    for (const consumer of this.kernel.consumers.values()) {
      const request = consumer.active.get(state.paneId) ?? consumer.hot.get(state.paneId);
      if (!request) continue;
      consumer.active.delete(state.paneId);
      consumer.hot.delete(state.paneId);
      const gap: PaneReplayGap = {
        ...cloneIdentity(state),
        reason: 'epoch_changed',
        expectedPaneEpoch: copyBytes(previousEpoch),
        expectedSeq: previousSeq,
        availableSeq: 0n,
      };
      safeCallback(() => consumer.callbacks.onGap?.(gap));
    }
  }

  append(state: PaneState, data: Uint8Array, now: number): PaneDataSegment {
    const ownedData = copyBytes(data);
    const seqStart = state.latestSeq;
    const seqEnd = seqStart + BigInt(ownedData.byteLength);
    state.latestSeq = seqEnd;

    const retain = state.mode !== 'cold';
    if (retain) {
      state.replay.push({ seqStart, seqEnd, data: ownedData, receivedAt: now });
      state.replayBytes += ownedData.byteLength;
      this.kernel.adjustRetainedBytes(ownedData.byteLength);
    } else {
      state.dirtyWhileCold = true;
    }

    return {
      paneId: state.paneId,
      paneEpoch: copyBytes(state.paneEpoch),
      seqStart,
      seqEnd,
      data: ownedData,
    };
  }

  fanout(state: PaneState, segment: PaneDataSegment): void {
    for (const consumer of this.kernel.consumers.values()) {
      const request = consumer.active.get(state.paneId) ?? consumer.hot.get(state.paneId);
      if (!request || !bytesEqual(request.paneEpoch, state.paneEpoch)) continue;
      safeCallback(() => consumer.callbacks.onData(segment));
    }
  }

  getLatestCursor(paneId: string): PaneTerminalCursor | null {
    const state = this.kernel.panes.get(paneId);
    if (!state?.known) return null;
    return { paneEpoch: copyBytes(state.paneEpoch), terminalSeq: state.latestSeq };
  }

  isPaneRetained(paneId: string): boolean {
    const state = this.kernel.panes.get(paneId);
    return Boolean(state?.known && state.mode !== 'cold');
  }

  readReplay(paneId: string, cursor: PaneTerminalCursor): PaneReplayPlan | null {
    const state = this.kernel.panes.get(paneId);
    if (!state?.known) return null;
    return this.buildReplayPlan({ paneId, paneEpoch: state.paneEpoch, cursor });
  }

  getScreenCheckpoint(paneId: string): PaneScreenCheckpoint | null {
    const state = this.kernel.panes.get(paneId);
    const checkpoint = state?.checkpoint;
    if (!state?.known || !checkpoint || !bytesEqual(checkpoint.paneEpoch, state.paneEpoch)) {
      return null;
    }
    state.lastTouchedAt = this.kernel.now();
    return {
      ...checkpoint,
      paneEpoch: copyBytes(checkpoint.paneEpoch),
      data: copyBytes(checkpoint.data),
      historyCursor: checkpoint.historyCursor
        ? {
            paneEpoch: copyBytes(checkpoint.historyCursor.paneEpoch),
            historyEpoch: copyBytes(checkpoint.historyCursor.historyEpoch),
            beforeLine: checkpoint.historyCursor.beforeLine,
          }
        : null,
    };
  }

  storeScreenCheckpoint(checkpoint: PaneScreenCheckpoint): boolean {
    const state = this.kernel.panes.get(checkpoint.paneId);
    if (
      !state?.known ||
      !bytesEqual(state.paneEpoch, checkpoint.paneEpoch) ||
      checkpoint.baseSeq > state.latestSeq ||
      checkpoint.data.byteLength > this.kernel.maxCheckpointBytesPerPane
    ) {
      return false;
    }
    const now = this.kernel.now();
    const previousBytes = state.checkpoint?.data.byteLength ?? 0;
    state.checkpoint = {
      ...checkpoint,
      paneEpoch: copyBytes(checkpoint.paneEpoch),
      data: copyBytes(checkpoint.data),
      historyCursor: checkpoint.historyCursor
        ? {
            paneEpoch: copyBytes(checkpoint.historyCursor.paneEpoch),
            historyEpoch: copyBytes(checkpoint.historyCursor.historyEpoch),
            beforeLine: checkpoint.historyCursor.beforeLine,
          }
        : null,
      capturedAt: checkpoint.capturedAt,
    };
    this.kernel.adjustRetainedBytes(state.checkpoint.data.byteLength - previousBytes);
    state.lastTouchedAt = now;
    return true;
  }

  readHistory(
    paneId: string,
    beforeCursor: PaneTerminalCursor | null,
    byteLimit: number
  ): PaneHistoryPage | null {
    const state = this.kernel.panes.get(paneId);
    if (!state?.known) return null;
    const limit = Math.max(0, Math.min(byteLimit, this.kernel.maxReplayBytesPerPane));
    const beforeSeq = beforeCursor?.terminalSeq ?? state.latestSeq;
    const expectedEpoch = beforeCursor?.paneEpoch ?? state.paneEpoch;
    const identity = cloneIdentity(state);
    const oldestSeq = state.replay[0]?.seqStart ?? state.latestSeq;
    const range = selectHistoryRange({
      paneEpoch: state.paneEpoch,
      expectedEpoch,
      beforeSeq,
      latestSeq: state.latestSeq,
      oldestSeq,
      limit,
    });
    if (range.kind === 'gap') {
      return this.gapHistoryPage(state, identity, range.reason, expectedEpoch, beforeSeq);
    }
    const assembled = assembleHistoryChunks(state.replay, range.beforeSeq, range.limit);
    state.lastTouchedAt = this.kernel.now();
    return {
      ...identity,
      seqStart: assembled.seqStart,
      seqEnd: range.beforeSeq,
      data: assembled.data,
      nextCursor:
        assembled.seqStart > oldestSeq
          ? { paneEpoch: copyBytes(state.paneEpoch), terminalSeq: assembled.seqStart }
          : null,
      gap: null,
    };
  }

  private gapHistoryPage(
    state: PaneState,
    identity: PaneIdentity,
    reason: PaneReplayGapReason,
    expectedPaneEpoch: Uint8Array,
    expectedSeq: bigint
  ): PaneHistoryPage {
    return {
      ...identity,
      seqStart: state.latestSeq,
      seqEnd: state.latestSeq,
      data: new Uint8Array(),
      nextCursor: null,
      gap: this.createGap(state, reason, expectedPaneEpoch, expectedSeq),
    };
  }

  buildReplayPlan(request: PaneSubscriptionRequest): PaneReplayPlan {
    const state = this.kernel.panes.get(request.paneId);
    if (!state?.known) {
      throw new Error(`accepted pane disappeared before replay: ${request.paneId}`);
    }
    const identity = cloneIdentity(state);
    if (!request.cursor) {
      this.kernel.replayMisses += 1;
      this.kernel.rebases += 1;
      return { ...identity, segments: [], gap: null, needsScreen: true };
    }
    const cursor = request.cursor;
    if (!bytesEqual(cursor.paneEpoch, state.paneEpoch)) {
      this.kernel.replayMisses += 1;
      this.kernel.rebases += 1;
      return {
        ...identity,
        segments: [],
        gap: this.createGap(state, 'epoch_changed', cursor.paneEpoch, cursor.terminalSeq),
        needsScreen: true,
      };
    }
    const oldestSeq = state.replay[0]?.seqStart ?? state.latestSeq;
    if (cursor.terminalSeq > state.latestSeq || cursor.terminalSeq < oldestSeq) {
      this.kernel.replayMisses += 1;
      this.kernel.rebases += 1;
      return {
        ...identity,
        segments: [],
        gap: this.createGap(
          state,
          cursor.terminalSeq > state.latestSeq ? 'pane_gap' : 'cache_evicted',
          cursor.paneEpoch,
          cursor.terminalSeq
        ),
        needsScreen: true,
      };
    }
    const segments: PaneDataSegment[] = [];
    for (const chunk of state.replay) {
      if (chunk.seqEnd <= cursor.terminalSeq) continue;
      const offset =
        cursor.terminalSeq > chunk.seqStart ? Number(cursor.terminalSeq - chunk.seqStart) : 0;
      const data = offset === 0 ? chunk.data : chunk.data.slice(offset);
      const seqStart = chunk.seqStart + BigInt(offset);
      segments.push({
        ...identity,
        seqStart,
        seqEnd: chunk.seqEnd,
        data,
      });
    }
    this.kernel.replayHits += 1;
    return { ...identity, segments, gap: null, needsScreen: false };
  }

  createGap(
    state: PaneState,
    reason: PaneReplayGapReason,
    expectedPaneEpoch: Uint8Array,
    expectedSeq: bigint
  ): PaneReplayGap {
    return {
      ...cloneIdentity(state),
      reason,
      expectedPaneEpoch: copyBytes(expectedPaneEpoch),
      expectedSeq,
      availableSeq: state.latestSeq,
    };
  }

  cloneKnownIdentity(state: PaneState): PaneIdentity {
    return cloneIdentity(state);
  }

  private recordEviction(reason: 'epoch_changed'): void {
    this.kernel.evictions += 1;
    this.kernel.evictionsByReason[reason] += 1;
  }
}
