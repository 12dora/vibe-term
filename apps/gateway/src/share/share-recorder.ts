import type { StateSnapshotPayload } from '@tmex/shared';
import type {
  PaneDataSegment,
  PaneIdentity,
  PaneRetentionConsumerCallbacks,
  PaneRetentionConsumerLease,
  PaneScreenCheckpoint,
} from '../tmux-client/pane-retention';
import type { ShareLogAppend } from './share-store';

export const SHARE_CHECKPOINT_BYTE_LIMIT = 512 * 1024;
export const SHARE_RECORDER_FLUSH_MS = 250;
export const SHARE_RECORDER_POLL_MS = 2_000;

export type ShareRecorderRuntime = {
  getPaneIdentity(paneId: string): PaneIdentity | null;
  attachPaneConsumer(callbacks: PaneRetentionConsumerCallbacks): PaneRetentionConsumerLease;
  captureCanonicalScreen(paneId: string, byteLimit: number): Promise<PaneScreenCheckpoint | null>;
  getCurrentSnapshot(): StateSnapshotPayload | null;
};

export type ShareRecorderDeps = {
  acquireRuntime(deviceId: string): Promise<ShareRecorderRuntime>;
  releaseRuntime(deviceId: string, runtime: ShareRecorderRuntime): Promise<void>;
  /** 返回 null 表示日志已停止（超上限 / 分享已结束）。 */
  appendLog(shareId: string, entries: readonly ShareLogAppend[]): { truncated: boolean } | null;
  now(): number;
  flushIntervalMs?: number;
  pollIntervalMs?: number;
  onError?(shareId: string, error: unknown): void;
};

type PaneState = {
  ready: boolean;
  baseSeq: bigint | null;
  pending: PaneDataSegment[];
};

function windowPanes(snapshot: StateSnapshotPayload | null, windowId: string): string[] {
  const window = snapshot?.session?.windows.find((item) => item.id === windowId);
  return window ? window.panes.map((pane) => pane.id) : [];
}

export function hasWindow(snapshot: StateSnapshotPayload | null, windowId: string): boolean {
  return Boolean(snapshot?.session?.windows.some((item) => item.id === windowId));
}

function trimSegment(segment: PaneDataSegment, baseSeq: bigint): Uint8Array | null {
  if (segment.seqEnd <= baseSeq) return null;
  const offset = baseSeq > segment.seqStart ? Number(baseSeq - segment.seqStart) : 0;
  if (offset >= segment.data.byteLength) return null;
  return offset === 0 ? segment.data : segment.data.subarray(offset);
}

/** 一个分享的录屏记录器：window 内所有 pane 的首帧快照 + 输出 / 输入 / 尺寸事件。 */
export class ShareRecorder {
  private runtime: ShareRecorderRuntime | null = null;
  private lease: PaneRetentionConsumerLease | null = null;
  private readonly panes = new Map<string, PaneState>();
  private readonly queue: ShareLogAppend[] = [];
  private generation = 0n;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private syncing = false;
  private stopped = false;

  constructor(
    readonly shareId: string,
    readonly deviceId: string,
    readonly windowId: string,
    private readonly deps: ShareRecorderDeps
  ) {}

  get active(): boolean {
    return !this.stopped && this.runtime !== null;
  }

  snapshot(): StateSnapshotPayload | null {
    return this.runtime?.getCurrentSnapshot() ?? null;
  }

  async start(): Promise<void> {
    if (this.stopped || this.runtime) return;
    const runtime = await this.deps.acquireRuntime(this.deviceId);
    if (this.stopped) {
      await this.deps.releaseRuntime(this.deviceId, runtime);
      return;
    }
    this.runtime = runtime;
    this.lease = runtime.attachPaneConsumer({
      onData: (segment) => this.handleSegment(segment),
    });
    this.flushTimer = setInterval(
      () => this.flush(),
      this.deps.flushIntervalMs ?? SHARE_RECORDER_FLUSH_MS
    );
    this.pollTimer = setInterval(() => {
      void this.sync();
    }, this.deps.pollIntervalMs ?? SHARE_RECORDER_POLL_MS);
    await this.sync();
  }

  async sync(): Promise<void> {
    if (this.stopped || this.syncing || !this.runtime) return;
    this.syncing = true;
    try {
      const wanted = new Set(windowPanes(this.runtime.getCurrentSnapshot(), this.windowId));
      let changed = false;
      for (const paneId of this.panes.keys()) {
        if (wanted.has(paneId)) continue;
        this.panes.delete(paneId);
        changed = true;
      }
      const fresh: string[] = [];
      for (const paneId of wanted) {
        if (this.panes.has(paneId)) continue;
        if (!this.runtime.getPaneIdentity(paneId)) continue;
        this.panes.set(paneId, { ready: false, baseSeq: null, pending: [] });
        fresh.push(paneId);
        changed = true;
      }
      if (changed) this.resubscribe();
      for (const paneId of fresh) await this.checkpointPane(paneId);
    } catch (error) {
      this.deps.onError?.(this.shareId, error);
    } finally {
      this.syncing = false;
    }
  }

  recordInput(paneId: string, bytes: Uint8Array): void {
    if (this.stopped || bytes.byteLength === 0) return;
    this.trackPane(paneId);
    this.queue.push({ at: this.deps.now(), kind: 'in', paneId, data: new Uint8Array(bytes) });
  }

  recordResize(paneId: string, cols: number, rows: number): void {
    if (this.stopped) return;
    this.trackPane(paneId);
    this.queue.push({
      at: this.deps.now(),
      kind: 'resize',
      paneId,
      data: new Uint8Array(0),
      cols,
      rows,
    });
  }

  private trackPane(paneId: string): void {
    if (this.panes.has(paneId)) return;
    void this.sync();
  }

  flush(): void {
    if (this.queue.length === 0) return;
    const entries = this.queue.splice(0, this.queue.length);
    const result = this.deps.appendLog(this.shareId, entries);
    if (result === null || result.truncated) void this.stop();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.flushTimer = null;
    this.pollTimer = null;
    if (this.queue.length > 0) {
      const entries = this.queue.splice(0, this.queue.length);
      this.deps.appendLog(this.shareId, entries);
    }
    this.lease?.close();
    this.lease = null;
    const runtime = this.runtime;
    this.runtime = null;
    this.panes.clear();
    if (runtime) await this.deps.releaseRuntime(this.deviceId, runtime);
  }

  private resubscribe(): void {
    if (!this.lease || !this.runtime) return;
    const requests = [];
    for (const paneId of this.panes.keys()) {
      const identity = this.runtime.getPaneIdentity(paneId);
      if (!identity) continue;
      requests.push({ paneId, paneEpoch: identity.paneEpoch, cursor: null });
    }
    this.generation += 1n;
    try {
      this.lease.applySubscriptions(this.generation, requests, []);
    } catch (error) {
      this.deps.onError?.(this.shareId, error);
    }
  }

  private async checkpointPane(paneId: string): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    let checkpoint: PaneScreenCheckpoint | null = null;
    try {
      checkpoint = await runtime.captureCanonicalScreen(paneId, SHARE_CHECKPOINT_BYTE_LIMIT);
    } catch (error) {
      this.deps.onError?.(this.shareId, error);
    }
    const state = this.panes.get(paneId);
    if (!state || this.stopped) return;
    if (!checkpoint) {
      this.panes.delete(paneId);
      return;
    }
    this.queue.push({
      at: this.deps.now(),
      kind: 'checkpoint',
      paneId,
      data: checkpoint.data,
      cols: checkpoint.cols,
      rows: checkpoint.rows,
    });
    state.baseSeq = checkpoint.baseSeq;
    state.ready = true;
    for (const segment of state.pending) this.enqueueOutput(paneId, segment, checkpoint.baseSeq);
    state.pending = [];
  }

  private handleSegment(segment: PaneDataSegment): void {
    if (this.stopped) return;
    const state = this.panes.get(segment.paneId);
    if (!state) return;
    if (!state.ready) {
      if (state.pending.length < 256) state.pending.push(segment);
      return;
    }
    this.enqueueOutput(segment.paneId, segment, state.baseSeq ?? 0n);
  }

  private enqueueOutput(paneId: string, segment: PaneDataSegment, baseSeq: bigint): void {
    const data = trimSegment(segment, baseSeq);
    if (!data || data.byteLength === 0) return;
    this.queue.push({ at: this.deps.now(), kind: 'out', paneId, data: new Uint8Array(data) });
  }
}
