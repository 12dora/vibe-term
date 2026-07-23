import type {
  GatewayHistoryCursor,
  GatewayPaneHistoryPage,
  GatewayPaneScreenSnapshot,
  GatewayRebaseReason,
  GatewayTerminalData,
} from '@tmex/ws-client';

export const MAX_GENERATION_REPLAY_BYTES = 2 * 1024 * 1024;
export const MAX_GENERATION_HISTORY_BYTES = 4 * 1024 * 1024;
export const MAX_GENERATION_HISTORY_PAGES = 16;
// snapshot 的 replay 因持续 live 反复被淘汰而无法连续拼接时，重取上限。
// 超过后接受该全屏 snapshot 直接作为新 base（丢弃无法回放的旧 live），
// 由服务端 base_seq 之后的连续 replay 补齐，避免无限 cache_evicted 重取。
export const MAX_GENERATION_REBASE_ATTEMPTS = 3;
// 离屏 generation 重建时，回放的 replay 每累计这么多字节就让渡一次主线程（宏任务），
// 让 metadata 的 React 更新、rAF 绘制和其它传输消息在大回放期间仍能穿插运行，
// 避免一次性 2MiB writeVt 突发霸占主线程冻住 metadata。小于该阈值的回放（常态）不让渡。
export const MAX_GENERATION_REPLAY_YIELD_BYTES = 256 * 1024;

function macrotaskYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export interface TerminalGenerationTarget {
  dispose(): void;
}

export type TerminalGenerationRecoveryState = 'initializing' | 'live' | 'recovering' | 'disposed';

export interface TerminalGenerationDiagnosticState {
  paneEpoch: Uint8Array | null;
  terminalSeq: bigint | null;
  historyEpoch: Uint8Array | null;
  historyBeforeLine: number | null;
  recoveryState: TerminalGenerationRecoveryState;
  recoveryReason: GatewayRebaseReason | null;
  replayBytes: number;
  replayBytesLimit: number;
  historyBytes: number;
  historyBytesLimit: number;
  historyPages: number;
  historyPagesLimit: number;
}

export interface TerminalGenerationOptions<Target extends TerminalGenerationTarget> {
  createTarget(): Promise<Target>;
  writeSnapshot(
    target: Target,
    snapshot: GatewayPaneScreenSnapshot,
    historyPages: readonly GatewayPaneHistoryPage[]
  ): void;
  writeLive(target: Target, data: Uint8Array): void;
  waitForFirstRender(target: Target): Promise<void>;
  captureScrollDistance(target: Target): number;
  activate(target: Target, previous: Target | null, scrollDistanceFromBottom: number): void;
  onRecoveryRequired(reason: GatewayRebaseReason): void;
  onGenerationActivated?(target: Target, snapshot: GatewayPaneScreenSnapshot | null): void;
  maxReplayBytes?: number;
  maxHistoryBytes?: number;
  maxHistoryPages?: number;
  maxRebaseAttempts?: number;
  replayYieldBytes?: number;
  scheduleYield?: () => Promise<void>;
}

interface Cursor {
  paneEpoch: Uint8Array;
  terminalSeq: bigint;
}

interface PendingGeneration<Target> {
  id: number;
  target: Target;
  paneEpoch: Uint8Array;
  nextSeq: bigint;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function copyHistoryCursor(cursor: GatewayHistoryCursor | null): GatewayHistoryCursor | null {
  return cursor
    ? {
        paneEpoch: Uint8Array.from(cursor.paneEpoch),
        historyEpoch: Uint8Array.from(cursor.historyEpoch),
        beforeLine: cursor.beforeLine,
      }
    : null;
}

function copySnapshot(snapshot: GatewayPaneScreenSnapshot): GatewayPaneScreenSnapshot {
  return {
    ...snapshot,
    requestId: snapshot.requestId ? Uint8Array.from(snapshot.requestId) : undefined,
    paneEpoch: Uint8Array.from(snapshot.paneEpoch),
    data: Uint8Array.from(snapshot.data),
    historyCursor: copyHistoryCursor(snapshot.historyCursor),
  };
}

function copyHistoryPage(page: GatewayPaneHistoryPage): GatewayPaneHistoryPage {
  return {
    ...page,
    requestId: page.requestId ? Uint8Array.from(page.requestId) : undefined,
    paneEpoch: Uint8Array.from(page.paneEpoch),
    historyEpoch: Uint8Array.from(page.historyEpoch),
    data: Uint8Array.from(page.data),
    nextCursor: copyHistoryCursor(page.nextCursor),
  };
}

function copyTerminalFrame(frame: GatewayTerminalData): GatewayTerminalData {
  return {
    ...frame,
    data: Uint8Array.from(frame.data),
    paneEpoch: frame.paneEpoch ? Uint8Array.from(frame.paneEpoch) : undefined,
  };
}

function isSequencedFrame(frame: GatewayTerminalData): frame is GatewayTerminalData & {
  paneEpoch: Uint8Array;
  seqStart: bigint;
  seqEnd: bigint;
} {
  return (
    frame.paneEpoch !== undefined && frame.seqStart !== undefined && frame.seqEnd !== undefined
  );
}

export class TerminalGeneration<Target extends TerminalGenerationTarget> {
  private readonly maxReplayBytes: number;
  private readonly maxHistoryBytes: number;
  private readonly maxHistoryPages: number;
  private readonly maxRebaseAttempts: number;
  private readonly replayYieldBytes: number;
  private readonly scheduleYield: () => Promise<void>;
  private rebaseAttempts = 0;
  private visible: Target | null = null;
  private visibleCursor: Cursor | null = null;
  private pending: PendingGeneration<Target> | null = null;
  private replay: GatewayTerminalData[] = [];
  private replayBytes = 0;
  private observedPaneEpoch: Uint8Array | null = null;
  private observedEnd = 0n;
  private latestSnapshot: GatewayPaneScreenSnapshot | null = null;
  private historyPages: GatewayPaneHistoryPage[] = [];
  private historyBytes = 0;
  private nextHistoryCursor: GatewayHistoryCursor | null = null;
  private buildId = 0;
  private recoveryRequested = false;
  private recovering = false;
  private recoveryReason: GatewayRebaseReason | null = null;
  private disposed = false;

  constructor(private readonly options: TerminalGenerationOptions<Target>) {
    this.maxReplayBytes = options.maxReplayBytes ?? MAX_GENERATION_REPLAY_BYTES;
    this.maxHistoryBytes = options.maxHistoryBytes ?? MAX_GENERATION_HISTORY_BYTES;
    this.maxHistoryPages = options.maxHistoryPages ?? MAX_GENERATION_HISTORY_PAGES;
    this.maxRebaseAttempts = options.maxRebaseAttempts ?? MAX_GENERATION_REBASE_ATTEMPTS;
    this.replayYieldBytes = options.replayYieldBytes ?? MAX_GENERATION_REPLAY_YIELD_BYTES;
    this.scheduleYield = options.scheduleYield ?? macrotaskYield;
  }

  async initialize(): Promise<Target> {
    if (this.disposed) throw new Error('terminal generation disposed');
    if (this.visible) return this.visible;
    const target = await this.options.createTarget();
    if (this.disposed) {
      target.dispose();
      throw new Error('terminal generation disposed');
    }
    this.visible = target;
    this.options.activate(target, null, 0);
    this.options.onGenerationActivated?.(target, null);
    return target;
  }

  getVisibleTarget(): Target | null {
    return this.visible;
  }

  getNextHistoryCursor(): GatewayHistoryCursor | null {
    return copyHistoryCursor(this.nextHistoryCursor);
  }

  getDiagnosticState(): TerminalGenerationDiagnosticState {
    const cursor =
      this.visibleCursor ??
      (this.pending
        ? { paneEpoch: this.pending.paneEpoch, terminalSeq: this.pending.nextSeq }
        : this.observedPaneEpoch
          ? { paneEpoch: this.observedPaneEpoch, terminalSeq: this.observedEnd }
          : null);
    return {
      paneEpoch: cursor ? Uint8Array.from(cursor.paneEpoch) : null,
      terminalSeq: cursor?.terminalSeq ?? null,
      historyEpoch: this.nextHistoryCursor
        ? Uint8Array.from(this.nextHistoryCursor.historyEpoch)
        : null,
      historyBeforeLine: this.nextHistoryCursor?.beforeLine ?? null,
      recoveryState: this.disposed
        ? 'disposed'
        : this.recovering || this.recoveryRequested || this.pending
          ? 'recovering'
          : this.visible
            ? 'live'
            : 'initializing',
      recoveryReason: this.recoveryReason,
      replayBytes: this.replayBytes,
      replayBytesLimit: this.maxReplayBytes,
      historyBytes: this.historyBytes,
      historyBytesLimit: this.maxHistoryBytes,
      historyPages: this.historyPages.length,
      historyPagesLimit: this.maxHistoryPages,
    };
  }

  write(frame: GatewayTerminalData): void {
    if (this.disposed) return;
    if (!isSequencedFrame(frame)) {
      if (this.visible) this.options.writeLive(this.visible, frame.data);
      return;
    }
    if (
      frame.seqEnd < frame.seqStart ||
      frame.seqEnd - frame.seqStart !== BigInt(frame.data.length)
    ) {
      this.enterRecovery('pane_gap');
      return;
    }

    const owned = copyTerminalFrame(frame) as GatewayTerminalData & {
      paneEpoch: Uint8Array;
      seqStart: bigint;
      seqEnd: bigint;
    };
    this.observe(owned);
    this.appendReplay(owned);

    const pending = this.pending;
    if (pending && bytesEqual(pending.paneEpoch, owned.paneEpoch)) {
      const next = this.writeAtCursor(pending.target, pending.nextSeq, owned);
      if (next === null) {
        this.cancelPending();
        this.enterRecovery('pane_gap');
      } else {
        pending.nextSeq = next;
      }
    }

    if (this.recovering || !this.visible || !this.visibleCursor) return;
    if (!bytesEqual(this.visibleCursor.paneEpoch, owned.paneEpoch)) {
      this.enterRecovery('epoch_changed');
      return;
    }
    const next = this.writeAtCursor(this.visible, this.visibleCursor.terminalSeq, owned);
    if (next === null) {
      this.enterRecovery('pane_gap');
      return;
    }
    this.visibleCursor.terminalSeq = next;
  }

  replace(snapshot: GatewayPaneScreenSnapshot): void {
    if (this.disposed) return;
    const owned = copySnapshot(snapshot);
    this.latestSnapshot = owned;
    this.historyPages = [];
    this.historyBytes = 0;
    this.nextHistoryCursor = copyHistoryCursor(owned.historyCursor);
    this.recoveryRequested = false;
    if (
      !this.visibleCursor ||
      !bytesEqual(this.visibleCursor.paneEpoch, owned.paneEpoch) ||
      owned.baseSeq > this.visibleCursor.terminalSeq
    ) {
      this.recovering = true;
    }
    this.startBuild(owned, []);
  }

  applyHistoryPage(page: GatewayPaneHistoryPage): boolean {
    if (this.disposed || !this.latestSnapshot || !this.nextHistoryCursor) return false;
    const expected = this.nextHistoryCursor;
    if (
      page.deviceId !== this.latestSnapshot.deviceId ||
      page.paneId !== this.latestSnapshot.paneId ||
      !bytesEqual(page.paneEpoch, this.latestSnapshot.paneEpoch) ||
      !bytesEqual(page.paneEpoch, expected.paneEpoch) ||
      !bytesEqual(page.historyEpoch, expected.historyEpoch) ||
      page.lineEnd !== expected.beforeLine ||
      page.lineStart > page.lineEnd
    ) {
      this.enterRecovery('cache_evicted');
      return false;
    }
    if (
      page.nextCursor &&
      (!bytesEqual(page.nextCursor.paneEpoch, page.paneEpoch) ||
        !bytesEqual(page.nextCursor.historyEpoch, page.historyEpoch) ||
        page.nextCursor.beforeLine !== page.lineStart)
    ) {
      this.enterRecovery('cache_evicted');
      return false;
    }
    if (
      this.historyPages.length >= this.maxHistoryPages ||
      this.historyBytes + page.data.byteLength > this.maxHistoryBytes
    ) {
      this.nextHistoryCursor = null;
      return false;
    }

    const owned = copyHistoryPage(page);
    this.historyPages.push(owned);
    this.historyPages.sort((left, right) => left.lineStart - right.lineStart);
    this.historyBytes += owned.data.byteLength;
    this.nextHistoryCursor = copyHistoryCursor(owned.nextCursor);
    this.startBuild(this.latestSnapshot, this.historyPages);
    return true;
  }

  rebase(reason: GatewayRebaseReason): void {
    if (this.disposed) return;
    this.cancelPending();
    this.enterRecovery(reason);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.buildId += 1;
    const pending = this.pending;
    this.pending = null;
    if (pending && pending.target !== this.visible) pending.target.dispose();
    this.visible?.dispose();
    this.visible = null;
    this.visibleCursor = null;
    this.replay = [];
    this.historyPages = [];
  }

  private observe(
    frame: GatewayTerminalData & {
      paneEpoch: Uint8Array;
      seqStart: bigint;
      seqEnd: bigint;
    }
  ): void {
    if (!this.observedPaneEpoch || !bytesEqual(this.observedPaneEpoch, frame.paneEpoch)) {
      this.observedPaneEpoch = Uint8Array.from(frame.paneEpoch);
      this.observedEnd = frame.seqEnd;
      return;
    }
    if (frame.seqEnd > this.observedEnd) this.observedEnd = frame.seqEnd;
  }

  private appendReplay(frame: GatewayTerminalData): void {
    this.replay.push(frame);
    this.replayBytes += frame.data.byteLength;
    while (this.replayBytes > this.maxReplayBytes && this.replay.length > 0) {
      const removed = this.replay.shift();
      if (removed) this.replayBytes -= removed.data.byteLength;
    }
    if (frame.data.byteLength > this.maxReplayBytes) {
      this.replay = [];
      this.replayBytes = 0;
      this.cancelPending();
      this.enterRecovery('resource_exhausted');
    }
  }

  private writeAtCursor(
    target: Target,
    expectedSeq: bigint,
    frame: GatewayTerminalData & { seqStart: bigint; seqEnd: bigint }
  ): bigint | null {
    if (frame.seqEnd <= expectedSeq) return expectedSeq;
    if (frame.seqStart > expectedSeq) return null;
    const offset = Number(expectedSeq - frame.seqStart);
    this.options.writeLive(target, offset === 0 ? frame.data : frame.data.subarray(offset));
    return frame.seqEnd;
  }

  private collectReplay(
    paneEpoch: Uint8Array,
    baseSeq: bigint
  ): { frames: GatewayTerminalData[]; nextSeq: bigint } | null {
    const targetEnd =
      this.observedPaneEpoch && bytesEqual(this.observedPaneEpoch, paneEpoch)
        ? this.observedEnd
        : baseSeq;
    if (targetEnd <= baseSeq) return { frames: [], nextSeq: baseSeq };

    const candidates = this.replay
      .filter(
        (frame) =>
          isSequencedFrame(frame) &&
          bytesEqual(frame.paneEpoch, paneEpoch) &&
          frame.seqEnd > baseSeq
      )
      .sort((left, right) => {
        const leftStart = left.seqStart ?? 0n;
        const rightStart = right.seqStart ?? 0n;
        return leftStart < rightStart ? -1 : leftStart > rightStart ? 1 : 0;
      });
    const frames: GatewayTerminalData[] = [];
    let cursor = baseSeq;
    for (const frame of candidates) {
      if (!isSequencedFrame(frame) || frame.seqEnd <= cursor) continue;
      if (frame.seqStart > cursor) return null;
      const offset = Number(cursor - frame.seqStart);
      frames.push({
        ...frame,
        seqStart: cursor,
        data: offset === 0 ? frame.data : frame.data.subarray(offset),
      });
      cursor = frame.seqEnd;
      if (cursor >= targetEnd) break;
    }
    return cursor >= targetEnd ? { frames, nextSeq: cursor } : null;
  }

  private startBuild(
    snapshot: GatewayPaneScreenSnapshot,
    historyPages: readonly GatewayPaneHistoryPage[]
  ): void {
    const id = ++this.buildId;
    this.cancelPending(false);
    const snapshotCopy = copySnapshot(snapshot);
    const pages = historyPages.map(copyHistoryPage);
    void this.build(id, snapshotCopy, pages);
  }

  private async build(
    id: number,
    snapshot: GatewayPaneScreenSnapshot,
    historyPages: readonly GatewayPaneHistoryPage[]
  ): Promise<void> {
    let target: Target;
    try {
      target = await this.options.createTarget();
    } catch {
      if (id === this.buildId && !this.disposed) this.enterRecovery('resource_exhausted');
      return;
    }
    if (this.disposed || id !== this.buildId) {
      target.dispose();
      return;
    }

    let replay = this.collectReplay(snapshot.paneEpoch, snapshot.baseSeq);
    if (!replay) {
      this.rebaseAttempts += 1;
      if (this.rebaseAttempts <= this.maxRebaseAttempts) {
        target.dispose();
        this.enterRecovery('cache_evicted');
        return;
      }
      // 反复无法从 baseSeq 连续拼接：接受该全屏 snapshot 直接作为新 base，
      // 丢弃无法回放的旧 live，由服务端 base_seq 之后的连续 replay 补齐。
      replay = { frames: [], nextSeq: snapshot.baseSeq };
    }

    let replayNextSeq = replay.nextSeq;
    try {
      this.options.writeSnapshot(target, snapshot, historyPages);
      // 大回放按字节预算分片，回放到离屏 target 的同时让渡主线程，让 metadata/绘制穿插。
      let sinceYield = 0;
      let yielded = false;
      for (const frame of replay.frames) {
        this.options.writeLive(target, frame.data);
        sinceYield += frame.data.length;
        if (sinceYield >= this.replayYieldBytes) {
          sinceYield = 0;
          yielded = true;
          await this.scheduleYield();
          if (this.disposed || id !== this.buildId) {
            target.dispose();
            return;
          }
        }
      }
      // 让渡期间新到的 live 已进 replay ring；在离屏 target 上同步补齐到当前 observedEnd，
      // 使 pending.nextSeq 无缺口，激活后不会与后续 live 之间产生 seq gap 而误触 recovery。
      if (yielded) {
        const catchup = this.collectReplay(snapshot.paneEpoch, replayNextSeq);
        if (catchup === null) {
          target.dispose();
          this.enterRecovery('cache_evicted');
          return;
        }
        for (const frame of catchup.frames) this.options.writeLive(target, frame.data);
        replayNextSeq = catchup.nextSeq;
      }
    } catch {
      target.dispose();
      this.enterRecovery('resource_exhausted');
      return;
    }
    const pending: PendingGeneration<Target> = {
      id,
      target,
      paneEpoch: Uint8Array.from(snapshot.paneEpoch),
      nextSeq: replayNextSeq,
    };
    this.pending = pending;

    try {
      await this.options.waitForFirstRender(target);
    } catch {
      if (this.pending === pending) this.pending = null;
      target.dispose();
      if (id === this.buildId && !this.disposed) this.enterRecovery('resource_exhausted');
      return;
    }
    if (this.disposed || id !== this.buildId || this.pending !== pending) {
      if (target !== this.visible) target.dispose();
      return;
    }

    const previous = this.visible;
    const scrollDistance = previous ? Math.max(0, this.options.captureScrollDistance(previous)) : 0;
    this.options.activate(target, previous, scrollDistance);
    this.visible = target;
    this.visibleCursor = {
      paneEpoch: Uint8Array.from(pending.paneEpoch),
      terminalSeq: pending.nextSeq,
    };
    this.pending = null;
    this.recovering = false;
    this.recoveryRequested = false;
    this.recoveryReason = null;
    this.rebaseAttempts = 0;
    this.options.onGenerationActivated?.(target, snapshot);
    if (previous && previous !== target) previous.dispose();
  }

  private cancelPending(incrementBuild = true): void {
    if (incrementBuild) this.buildId += 1;
    const pending = this.pending;
    this.pending = null;
    if (pending && pending.target !== this.visible) pending.target.dispose();
  }

  private enterRecovery(reason: GatewayRebaseReason): void {
    this.recovering = true;
    this.recoveryReason = reason;
    if (this.recoveryRequested) return;
    this.recoveryRequested = true;
    this.options.onRecoveryRequired(reason);
  }
}
