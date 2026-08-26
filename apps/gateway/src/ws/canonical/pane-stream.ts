import { wsBorsh } from '@tmex/shared';

import type { PaneDataSegment, PaneReplayGap } from '../../tmux-client/pane-retention';
import {
  GATEWAY_TERM_OUTPUT_BATCH_DELAY_MS,
  GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES,
} from '../terminal-output-batcher';
import { bytesEqual, copyBytes, paneKey } from './bytes';
import type { CanonicalTransactionSender } from './transaction-sender';
import type { CanonicalEvent, CanonicalPaneTarget } from './types';

interface PendingPaneDataBatch {
  deviceId: string;
  paneId: string;
  paneEpoch: Uint8Array;
  seqStart: bigint;
  seqEnd: bigint;
  chunks: Uint8Array[];
  length: number;
  timer: ReturnType<typeof setTimeout>;
}

function sourceGapReason(reason: PaneReplayGap['reason']): number {
  if (reason === 'epoch_changed') return wsBorsh.SOURCE_GAP_REASON_EPOCH_CHANGED;
  if (reason === 'cache_evicted') return wsBorsh.SOURCE_GAP_REASON_CACHE_EVICTED;
  return wsBorsh.SOURCE_GAP_REASON_PANE_GAP;
}

export interface CanonicalPaneStreamOptions {
  sender: CanonicalTransactionSender;
  getServerEpoch: (deviceId: string) => Uint8Array | null | undefined;
  maxPendingPaneGaps: number;
  onPendingWork: () => void;
}

export interface CanonicalPaneStreamStats {
  pendingPaneGaps: number;
  pendingPaneGapLimit: number;
  streamGapPending: boolean;
  paneDataDeliveries: number;
  paneDataBytes: number;
  paneDataDrops: number;
  paneDataDropBytes: number;
  pendingPaneGapOverflows: number;
  paneGapsSent: number;
  paneGapsByReason: Record<PaneReplayGap['reason'], number>;
  streamGapsSent: number;
}

export class CanonicalPaneStream {
  private readonly paneSendGaps = new Map<string, PaneReplayGap>();
  private readonly paneDataBatches = new Map<string, PendingPaneDataBatch>();
  private streamGapPendingReason: number | null = null;
  private paneDataDeliveries = 0;
  private paneDataBytes = 0;
  private paneDataDrops = 0;
  private paneDataDropBytes = 0;
  private pendingPaneGapOverflows = 0;
  private paneGapsSent = 0;
  private readonly paneGapsByReason: Record<PaneReplayGap['reason'], number> = {
    pane_gap: 0,
    epoch_changed: 0,
    cache_evicted: 0,
  };
  private streamGapsSent = 0;

  constructor(private readonly options: CanonicalPaneStreamOptions) {}

  snapshotStats(): CanonicalPaneStreamStats {
    return {
      pendingPaneGaps: this.paneSendGaps.size,
      pendingPaneGapLimit: this.options.maxPendingPaneGaps,
      streamGapPending: this.streamGapPendingReason !== null,
      paneDataDeliveries: this.paneDataDeliveries,
      paneDataBytes: this.paneDataBytes,
      paneDataDrops: this.paneDataDrops,
      paneDataDropBytes: this.paneDataDropBytes,
      pendingPaneGapOverflows: this.pendingPaneGapOverflows,
      paneGapsSent: this.paneGapsSent,
      paneGapsByReason: { ...this.paneGapsByReason },
      streamGapsSent: this.streamGapsSent,
    };
  }

  hasPendingWork(): boolean {
    return this.streamGapPendingReason !== null || this.paneSendGaps.size > 0;
  }

  // tmux 一次整屏重绘会以几十个独立 %output 到达；legacy 广播路径经 TerminalOutputBatcher
  // 合帧，canonical 路径若逐段直发，同样的重绘就变成几十个独立帧一路放大到客户端
  // （每帧独立编码/加密/系统调用，公网上被 RTT 摊开跨渲染帧到达，表现为逐行扫描式重绘，
  // 客户端主线程也被 message 洪水填满拖慢输入）。此处按 legacy 相同参数（16ms/64KiB）
  // 对 seq 连续的同 pane 段合帧；发出任何同 pane 的 gap/快照/目标 gap 前必须先 flush，
  // 保持 pane 内事件全序。
  handlePaneData(deviceId: string, segment: PaneDataSegment): void {
    const key = paneKey(deviceId, segment.paneId);
    const pending = this.paneDataBatches.get(key);
    if (pending) {
      if (bytesEqual(pending.paneEpoch, segment.paneEpoch) && pending.seqEnd === segment.seqStart) {
        pending.chunks.push(segment.data);
        pending.length += segment.data.byteLength;
        pending.seqEnd = segment.seqEnd;
        if (pending.length >= GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES) this.flushPaneDataBatch(key);
        return;
      }
      this.flushPaneDataBatch(key);
    }
    if (segment.data.byteLength >= GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES) {
      this.sendPaneData(deviceId, segment);
      return;
    }
    this.paneDataBatches.set(key, {
      deviceId,
      paneId: segment.paneId,
      paneEpoch: segment.paneEpoch,
      seqStart: segment.seqStart,
      seqEnd: segment.seqEnd,
      chunks: [segment.data],
      length: segment.data.byteLength,
      timer: setTimeout(() => this.flushPaneDataBatch(key), GATEWAY_TERM_OUTPUT_BATCH_DELAY_MS),
    });
  }

  flushPaneDataBatch(key: string): void {
    const pending = this.paneDataBatches.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.paneDataBatches.delete(key);
    const data = concatChunks(pending.chunks, pending.length);
    this.sendPaneData(pending.deviceId, {
      paneId: pending.paneId,
      paneEpoch: pending.paneEpoch,
      seqStart: pending.seqStart,
      seqEnd: pending.seqEnd,
      data,
    });
  }

  flushPaneDataBatchesForDevice(deviceId: string): void {
    for (const key of Array.from(this.paneDataBatches.keys())) {
      if (key.startsWith(`${deviceId}\0`)) this.flushPaneDataBatch(key);
    }
  }

  discardPaneDataBatches(): void {
    for (const pending of this.paneDataBatches.values()) clearTimeout(pending.timer);
    this.paneDataBatches.clear();
  }

  handlePaneGap(deviceId: string, gap: PaneReplayGap): void {
    this.flushPaneDataBatch(paneKey(deviceId, gap.paneId));
    if (!this.sendPaneGap(deviceId, gap)) {
      this.queuePaneGap(paneKey(deviceId, gap.paneId), gap);
    }
  }

  sendPaneData(deviceId: string, segment: PaneDataSegment): boolean {
    const serverEpoch = this.options.getServerEpoch(deviceId);
    if (!serverEpoch) {
      this.recordPaneDataDrop(segment.data.byteLength);
      return false;
    }
    const key = paneKey(deviceId, segment.paneId);
    const target = { deviceId, serverEpoch, paneId: segment.paneId };
    const maxDataBytes = this.options.sender.sizer.maxPaneDataBytes(target, segment.paneEpoch);
    if (maxDataBytes <= 0) {
      this.recordPaneDataDrop(segment.data.byteLength);
      return false;
    }
    let offset = 0;
    while (offset < segment.data.byteLength) {
      const data = segment.data.slice(offset, offset + maxDataBytes);
      const seqStart = segment.seqStart + BigInt(offset);
      const event: CanonicalEvent = {
        PaneData: {
          pane: target,
          paneEpoch: copyBytes(segment.paneEpoch),
          seqStart,
          seqEnd: seqStart + BigInt(data.byteLength),
          data,
        },
      };
      if (!this.options.sender.send(event)) {
        const gap: PaneReplayGap = {
          paneId: segment.paneId,
          paneEpoch: copyBytes(segment.paneEpoch),
          reason: 'pane_gap',
          expectedPaneEpoch: copyBytes(segment.paneEpoch),
          expectedSeq: seqStart,
          availableSeq: segment.seqEnd,
        };
        this.recordPaneDataDrop(segment.data.byteLength - offset);
        this.queuePaneGap(key, gap);
        return false;
      }
      this.paneDataDeliveries += 1;
      this.paneDataBytes += data.byteLength;
      offset += data.byteLength;
    }
    return true;
  }

  sendPaneGap(deviceId: string, gap: PaneReplayGap): boolean {
    const serverEpoch = this.options.getServerEpoch(deviceId);
    if (!serverEpoch) return false;
    const sent = this.options.sender.send({
      SourceGap: {
        reason: sourceGapReason(gap.reason),
        scope: {
          Pane: {
            pane: { deviceId, serverEpoch, paneId: gap.paneId },
            expectedPaneEpoch: copyBytes(gap.expectedPaneEpoch),
            availablePaneEpoch: copyBytes(gap.paneEpoch),
            expectedSeq: gap.expectedSeq,
            availableSeq: gap.availableSeq,
          },
        },
      },
    });
    if (sent) {
      this.paneGapsSent += 1;
      this.paneGapsByReason[gap.reason] += 1;
    }
    return sent;
  }

  sendTargetGap(
    target: CanonicalPaneTarget,
    expectedPaneEpoch: Uint8Array,
    expectedSeq: bigint,
    availablePaneEpoch: Uint8Array,
    availableSeq: bigint
  ): void {
    this.flushPaneDataBatch(paneKey(target.deviceId, target.paneId));
    const sent = this.options.sender.send({
      SourceGap: {
        reason: wsBorsh.SOURCE_GAP_REASON_EPOCH_CHANGED,
        scope: {
          Pane: {
            pane: target,
            expectedPaneEpoch,
            availablePaneEpoch,
            expectedSeq,
            availableSeq,
          },
        },
      },
    });
    if (sent) {
      this.paneGapsSent += 1;
      this.paneGapsByReason.epoch_changed += 1;
    }
  }

  sendStreamGap(reason: number): boolean {
    const sent = this.options.sender.send({
      SourceGap: {
        reason,
        scope: { Stream: {} },
      },
    });
    if (sent) this.streamGapsSent += 1;
    return sent;
  }

  sendOrQueueStreamGap(reason: number): void {
    if (!this.sendStreamGap(reason)) {
      this.streamGapPendingReason = reason;
      this.options.onPendingWork();
    }
  }

  queuePaneGap(key: string, gap: PaneReplayGap): void {
    if (this.streamGapPendingReason !== null || this.paneSendGaps.has(key)) {
      if (this.streamGapPendingReason === null) this.paneSendGaps.set(key, gap);
      this.options.onPendingWork();
      return;
    }
    if (this.paneSendGaps.size < this.options.maxPendingPaneGaps) {
      this.paneSendGaps.set(key, gap);
      this.options.onPendingWork();
      return;
    }
    this.pendingPaneGapOverflows += 1;
    this.paneSendGaps.clear();
    this.streamGapPendingReason = wsBorsh.SOURCE_GAP_REASON_PANE_GAP;
    this.options.onPendingWork();
  }

  // 快照屏障（baseSeq）前的待发数据已包含在快照正文里，直接发出会紧贴在 ScreenBegin
  // 之前到达、被客户端 reset 抹掉的是屏障之后的部分——因此按 baseSeq 切分：
  // ≤baseSeq 丢弃（快照取代之），>baseSeq 扣到 ScreenCommit 之后补发。
  splitPaneDataBatchAtBase(
    key: string,
    paneEpoch: Uint8Array,
    baseSeq: bigint
  ): PaneDataSegment | null {
    const pending = this.paneDataBatches.get(key);
    if (!pending) return null;
    if (!bytesEqual(pending.paneEpoch, paneEpoch)) {
      this.flushPaneDataBatch(key);
      return null;
    }
    clearTimeout(pending.timer);
    this.paneDataBatches.delete(key);
    if (pending.seqEnd <= baseSeq) return null;
    let data = concatChunks(pending.chunks, pending.length);
    let seqStart = pending.seqStart;
    if (seqStart < baseSeq) {
      data = data.subarray(Number(baseSeq - seqStart));
      seqStart = baseSeq;
    }
    if (data.byteLength === 0) return null;
    return {
      paneId: pending.paneId,
      paneEpoch: pending.paneEpoch,
      seqStart,
      seqEnd: pending.seqEnd,
      data,
    };
  }

  flushStreamGapOnDrain(): boolean {
    if (this.streamGapPendingReason === null) return true;
    if (!this.sendStreamGap(this.streamGapPendingReason)) return false;
    this.streamGapPendingReason = null;
    this.paneSendGaps.clear();
    return true;
  }

  flushPaneGapsOnDrain(): void {
    for (const [key, gap] of Array.from(this.paneSendGaps)) {
      if (!this.sendPaneGap(key.split('\0')[0] ?? '', gap)) continue;
      this.paneSendGaps.delete(key);
    }
  }

  clearPending(): void {
    this.paneSendGaps.clear();
    this.streamGapPendingReason = null;
  }

  private recordPaneDataDrop(bytes: number): void {
    this.paneDataDrops += 1;
    this.paneDataDropBytes += Math.max(0, bytes);
  }
}

function concatChunks(chunks: Uint8Array[], length: number): Uint8Array {
  const first = chunks[0];
  if (chunks.length === 1 && first) return first;
  const data = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}
