import { wsBorsh } from '@tmex/shared';

import type { DeviceSessionRuntimeListener } from '../tmux-client/device-session-runtime';
import {
  type PaneHistoryCursor,
  PaneHistoryCursorError,
  type PaneHistoryPage,
} from '../tmux-client/pane-history-reader';
import {
  DEFAULT_MAX_ACTIVE_PANES,
  DEFAULT_MAX_HOT_PANES,
  type PaneIdentity,
} from '../tmux-client/pane-retention';
import {
  CANONICAL_PENDING_SWEEP_MS,
  ENVELOPE_BYTES,
  bytesEqual,
  bytesHex,
  copyBytes,
  defaultCreateEpoch,
  paneKey,
} from './canonical/bytes';
import { CanonicalFrameSizer } from './canonical/frame-sizer';
import { CanonicalPaneStream } from './canonical/pane-stream';
import { CanonicalSubscriptionCoordinator } from './canonical/subscription-coordinator';
import { CanonicalTransactionSender } from './canonical/transaction-sender';
import {
  type AttachedDevice,
  CANONICAL_MAX_HISTORY_PAGE_BYTES,
  CANONICAL_MAX_INPUT_DEDUP_IDS,
  CANONICAL_MAX_PENDING_PANE_GAPS,
  CANONICAL_MAX_SCREEN_BYTES,
  type CanonicalCommand,
  type CanonicalFeedRuntime,
  type CanonicalFeedSessionOptions,
  type CanonicalFeedSessionStats,
  type CanonicalPaneTarget,
  type ResolvedTarget,
  type ScreenJob,
  canonicalSendAccepted,
} from './canonical/types';

export {
  CANONICAL_MAX_HISTORY_PAGE_BYTES,
  CANONICAL_MAX_INPUT_DEDUP_IDS,
  CANONICAL_MAX_PENDING_PANE_GAPS,
  CANONICAL_MAX_SCREEN_BYTES,
  type CanonicalFeedRuntime,
  type CanonicalFeedSessionOptions,
  type CanonicalFeedSessionStats,
  type CanonicalSendResult,
} from './canonical/types';
export { CANONICAL_PENDING_SWEEP_MS } from './canonical/bytes';

export class CanonicalFeedSession {
  private readonly devices = new Map<string, AttachedDevice>();
  private readonly screenJobs = new Map<string, ScreenJob>();
  private readonly inputIds = new Set<string>();
  private readonly inputIdOrder: string[] = [];
  private readonly gatewayEpoch: Uint8Array;
  private readonly maxFrameBytes: number;
  private readonly sizer: CanonicalFrameSizer;
  private readonly sender: CanonicalTransactionSender;
  private readonly stream: CanonicalPaneStream;
  private readonly subscriptions = new CanonicalSubscriptionCoordinator();
  private readySent = false;
  private bootstrapped = false;
  private closed = false;
  private screenTransactionsStarted = 0;
  private screenTransactionsCompleted = 0;
  private screenTransactionsFailed = 0;
  private screenTransactionsCancelled = 0;
  private pendingSweepTimer: ReturnType<typeof setTimeout> | null = null;
  private awaitingSocketDrain = false;

  constructor(private readonly options: CanonicalFeedSessionOptions) {
    this.maxFrameBytes = Math.min(
      Math.max(ENVELOPE_BYTES + 64, options.maxFrameBytes),
      wsBorsh.CANONICAL_STATE_MAX_FRAME_BYTES
    );
    const maxPendingPaneGaps = options.maxPendingPaneGaps ?? CANONICAL_MAX_PENDING_PANE_GAPS;
    if (!Number.isSafeInteger(maxPendingPaneGaps) || maxPendingPaneGaps <= 0) {
      throw new Error('pending pane gap limit must be a positive safe integer');
    }
    this.gatewayEpoch = copyBytes((options.createEpoch ?? defaultCreateEpoch)());
    if (this.gatewayEpoch.byteLength !== 16) throw new Error('gateway epoch must be 16 bytes');
    this.sizer = new CanonicalFrameSizer(this.maxFrameBytes);
    this.sender = new CanonicalTransactionSender({
      sizer: this.sizer,
      sendEvent: (event) => {
        const result = this.options.sendEvent(event);
        if (result === 'backpressured') this.awaitingSocketDrain = true;
        return result;
      },
      isClosed: () => this.closed,
      getServerEpoch: (deviceId) => this.devices.get(deviceId)?.runtime.getServerEpoch(),
    });
    this.stream = new CanonicalPaneStream({
      sender: this.sender,
      getServerEpoch: (deviceId) => this.devices.get(deviceId)?.runtime.getServerEpoch(),
      maxPendingPaneGaps,
      onPendingWork: () => this.schedulePendingSweep(),
    });
  }

  snapshotStats(): CanonicalFeedSessionStats {
    const stream = this.stream.snapshotStats();
    return {
      attachedRuntimes: this.devices.size,
      screenJobs: this.screenJobs.size,
      gatedPanes: 0,
      pendingPaneGaps: stream.pendingPaneGaps,
      pendingPaneGapLimit: stream.pendingPaneGapLimit,
      streamGapPending: stream.streamGapPending,
      inputDedupIds: this.inputIds.size,
      inputDedupLimit: CANONICAL_MAX_INPUT_DEDUP_IDS,
      paneDataDeliveries: stream.paneDataDeliveries,
      paneDataBytes: stream.paneDataBytes,
      paneDataDrops: stream.paneDataDrops,
      paneDataDropBytes: stream.paneDataDropBytes,
      pendingPaneGapOverflows: stream.pendingPaneGapOverflows,
      paneGapsSent: stream.paneGapsSent,
      paneGapsByReason: stream.paneGapsByReason,
      streamGapsSent: stream.streamGapsSent,
      screenTransactionsStarted: this.screenTransactionsStarted,
      screenTransactionsCompleted: this.screenTransactionsCompleted,
      screenTransactionsFailed: this.screenTransactionsFailed,
      screenTransactionsCancelled: this.screenTransactionsCancelled,
    };
  }

  async handleCommand(command: CanonicalCommand): Promise<void> {
    if (this.closed) return;
    this.ensureReady();
    await this.bootstrapInitialDevices();
    try {
      if ('SetPaneSubscriptions' in command) {
        await this.handleSetPaneSubscriptions(command.SetPaneSubscriptions);
      } else if ('TerminalInput' in command) {
        await this.handleTerminalInput(command.TerminalInput);
      } else if ('ResizePane' in command) {
        await this.handleResizePane(command.ResizePane);
      } else if ('RequestScreen' in command) {
        await this.handleRequestScreen(command.RequestScreen);
      } else if ('RequestHistory' in command) {
        await this.handleRequestHistory(command.RequestHistory);
      }
    } catch (error) {
      this.sender.sendError(
        null,
        error instanceof wsBorsh.WsBorshError ? error.code : wsBorsh.ERROR_INTERNAL_ERROR,
        error instanceof Error ? error.message : 'canonical command failed',
        false
      );
    }
  }

  async attachDevice(deviceId: string, runtime?: CanonicalFeedRuntime): Promise<boolean> {
    if (this.closed) return false;
    this.ensureReady();
    const existing = this.devices.get(deviceId);
    if (existing && (!runtime || existing.runtime === runtime)) return true;
    if (existing) this.detachDevice(deviceId);
    const resolved = runtime ?? (await this.options.resolveRuntime(deviceId));
    if (!resolved) return false;

    let attached: AttachedDevice | null = null;
    const lease = resolved.attachPaneConsumer({
      onData: (segment) => this.stream.handlePaneData(deviceId, segment),
      onGap: (gap) => this.stream.handlePaneGap(deviceId, gap),
    });
    const listener: DeviceSessionRuntimeListener = {
      onMetadataPatch: (patch) => {
        if (!attached) return;
        if (!this.sizer.eventFits({ SourceMetadataPatch: patch })) {
          attached.metadataNeedsRebase = true;
          this.sender.sendMetadataSnapshot(attached);
          this.schedulePendingSweep();
          return;
        }
        if (!canonicalSendAccepted(this.sender.send({ SourceMetadataPatch: patch }))) {
          attached.metadataNeedsRebase = true;
          this.schedulePendingSweep();
        }
      },
      onMetadataRebaseRequired: () => {
        if (!attached) return;
        attached.metadataNeedsRebase = true;
        this.sender.sendMetadataSnapshot(attached);
        this.schedulePendingSweep();
      },
      onClose: () => {
        if (!attached) return;
        attached.metadataNeedsRebase = true;
        this.stream.sendOrQueueStreamGap(wsBorsh.SOURCE_GAP_REASON_EPOCH_CHANGED);
        this.schedulePendingSweep();
      },
    };
    attached = {
      deviceId,
      runtime: resolved,
      lease,
      detachListener: resolved.subscribe(listener),
      metadataNeedsRebase: true,
    };
    this.devices.set(deviceId, attached);
    this.options.onDeviceAttached?.(deviceId, resolved);
    this.sender.sendMetadataSnapshot(attached);
    this.schedulePendingSweep();
    return true;
  }

  detachDevice(deviceId: string): void {
    const attached = this.devices.get(deviceId);
    if (!attached) return;
    this.stream.flushPaneDataBatchesForDevice(deviceId);
    this.devices.delete(deviceId);
    attached.lease.close();
    attached.detachListener();
    for (const [key, job] of this.screenJobs) {
      if (key.startsWith(`${deviceId}\0`)) {
        this.cancelScreenJob(job);
        this.screenJobs.delete(key);
      }
    }
    this.options.onDeviceDetached?.(deviceId, attached.runtime);
  }

  // pending 项原本只由 Bun 的 drain 回调推进，而 drain 仅在 socket 曾经背压后排空时派发。
  // 当发送因非背压原因失败（例如 socket 暂时不可发）时，drain 永远不会到来，
  // 这些 pending 项会无限期挂起：metadata 不再刷新、pane gap 不再补、首屏也不再重启。
  // 因此在存在 pending 时挂一个低频兜底 tick，让推进不依赖 drain 事件。
  private schedulePendingSweep(): void {
    if (this.closed || this.pendingSweepTimer !== null) return;
    if (
      !this.stream.hasPendingWork() &&
      !Array.from(this.devices.values()).some((device) => device.metadataNeedsRebase)
    ) {
      return;
    }
    this.pendingSweepTimer = setTimeout(() => {
      this.pendingSweepTimer = null;
      if (this.closed) return;
      if (this.awaitingSocketDrain) return;
      this.onDrain();
    }, CANONICAL_PENDING_SWEEP_MS);
    this.pendingSweepTimer.unref?.();
  }

  onDrain(): void {
    if (this.closed) return;
    this.awaitingSocketDrain = false;
    if (!this.stream.flushStreamGapOnDrain()) {
      this.schedulePendingSweep();
      return;
    }
    for (const device of this.devices.values()) {
      if (device.metadataNeedsRebase) this.sender.sendMetadataSnapshot(device);
    }
    // gap 发出即止：首屏一律由客户端 RequestScreenSnapshot 驱动。
    // 在此自动重拍会把快照压回同一条仍拥塞的 socket，失败后再 gap，形成正反馈。
    this.stream.flushPaneGapsOnDrain();
    this.schedulePendingSweep();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stream.discardPaneDataBatches();
    for (const job of this.screenJobs.values()) this.cancelScreenJob(job);
    this.screenJobs.clear();
    this.stream.clearPending();
    this.awaitingSocketDrain = false;
    if (this.pendingSweepTimer !== null) {
      clearTimeout(this.pendingSweepTimer);
      this.pendingSweepTimer = null;
    }
    for (const deviceId of Array.from(this.devices.keys())) this.detachDevice(deviceId);
  }

  private ensureReady(): void {
    if (this.readySent) return;
    this.readySent = true;
    this.sender.send({
      FeedReady: {
        gatewayEpoch: copyBytes(this.gatewayEpoch),
        maxFrameBytes: this.maxFrameBytes,
        maxActivePanes: DEFAULT_MAX_ACTIVE_PANES,
        maxHotPanes: DEFAULT_MAX_HOT_PANES,
        maxScreenBytes: CANONICAL_MAX_SCREEN_BYTES,
        maxHistoryPageBytes: CANONICAL_MAX_HISTORY_PAGE_BYTES,
      },
    });
  }

  private async bootstrapInitialDevices(): Promise<void> {
    if (this.bootstrapped) return;
    this.bootstrapped = true;
    await Promise.all(
      Array.from(this.options.initialDeviceIds?.() ?? [], (deviceId) => this.attachDevice(deviceId))
    );
  }

  private async ensureDevice(deviceId: string): Promise<AttachedDevice | null> {
    const existing = this.devices.get(deviceId);
    if (existing) return existing;
    return (await this.attachDevice(deviceId)) ? (this.devices.get(deviceId) ?? null) : null;
  }

  private async handleSetPaneSubscriptions(command: {
    generation: bigint;
    activePanes: wsBorsh.CanonicalPaneSubscription[];
    hotPanes: wsBorsh.CanonicalPaneSubscription[];
  }): Promise<void> {
    const requestedDeviceIds = new Set(
      [...command.activePanes, ...command.hotPanes].map(
        (subscription) => subscription.pane.deviceId
      )
    );
    await Promise.all(Array.from(requestedDeviceIds, (deviceId) => this.ensureDevice(deviceId)));

    const applied = this.subscriptions.apply(
      command.generation,
      command.activePanes,
      command.hotPanes,
      this.devices.values()
    );

    // raw 直通语义：订阅集合变化只取消「不再被订阅」pane 的首屏任务；
    // 仍在集合内的任务不受后续 pane 挂载影响。
    for (const [key, job] of Array.from(this.screenJobs)) {
      if (!applied.retainedKeys.has(key)) this.cancelScreenJob(job);
    }
    this.sender.send({
      SubscriptionApplied: {
        generation: applied.generation,
        activePanes: applied.activePanes,
        hotPanes: applied.hotPanes,
        rejected: applied.rejected,
      },
    });
  }

  private async handleTerminalInput(command: {
    requestId: Uint8Array;
    pane: CanonicalPaneTarget;
    paneEpoch: Uint8Array;
    inputId: Uint8Array;
    data: Uint8Array;
  }): Promise<void> {
    const target = await this.resolveTarget(command.pane, command.requestId);
    if (!target) return;
    if (!bytesEqual(command.paneEpoch, target.pane.paneEpoch)) {
      this.stream.sendTargetGap(command.pane, command.paneEpoch, 0n, target.pane.paneEpoch, 0n);
      return;
    }
    const inputId = bytesHex(command.inputId);
    if (this.inputIds.has(inputId)) return;
    this.inputIds.add(inputId);
    this.inputIdOrder.push(inputId);
    while (this.inputIdOrder.length > CANONICAL_MAX_INPUT_DEDUP_IDS) {
      const removed = this.inputIdOrder.shift();
      if (removed) this.inputIds.delete(removed);
    }
    target.device.runtime.sendInputBytes(target.pane.paneId, command.data);
  }

  private async handleResizePane(command: {
    requestId: Uint8Array;
    pane: CanonicalPaneTarget;
    rows: number;
    cols: number;
  }): Promise<void> {
    const target = await this.resolveTarget(command.pane, command.requestId);
    if (!target) return;
    if (command.rows < 2 || command.cols < 2) {
      this.sender.sendError(
        command.requestId,
        wsBorsh.ERROR_INVALID_FRAME,
        'invalid pane size',
        false
      );
      return;
    }
    target.device.runtime.resizePane(target.pane.paneId, command.cols, command.rows);
  }

  private async handleRequestScreen(command: {
    requestId: Uint8Array;
    pane: CanonicalPaneTarget;
    byteLimit: number;
  }): Promise<void> {
    const target = await this.resolveTarget(command.pane, command.requestId);
    if (!target) return;
    if (command.byteLimit < 64) {
      this.sender.sendError(
        command.requestId,
        wsBorsh.ERROR_INVALID_FRAME,
        'screen byte limit too small',
        false
      );
      return;
    }
    this.startScreenJob(
      target.device,
      target.pane,
      command.requestId,
      Math.min(command.byteLimit, CANONICAL_MAX_SCREEN_BYTES)
    );
  }

  private async handleRequestHistory(command: {
    requestId: Uint8Array;
    pane: CanonicalPaneTarget;
    beforeCursor: PaneHistoryCursor | null;
    byteLimit: number;
  }): Promise<void> {
    const target = await this.resolveTarget(command.pane, command.requestId);
    if (!target) return;
    const byteLimit = Math.min(command.byteLimit, CANONICAL_MAX_HISTORY_PAGE_BYTES);
    if (byteLimit === 0) {
      this.sender.sendError(
        command.requestId,
        wsBorsh.ERROR_INVALID_FRAME,
        'history byte limit is zero',
        false
      );
      return;
    }
    let page: PaneHistoryPage | null;
    try {
      page = await target.device.runtime.readPaneHistory(
        target.pane.paneId,
        command.beforeCursor,
        byteLimit
      );
    } catch (error) {
      if (error instanceof PaneHistoryCursorError) {
        this.sender.sendError(command.requestId, wsBorsh.ERROR_TMUX_NOT_READY, error.message, true);
        return;
      }
      throw error;
    }
    if (!page) {
      this.sender.sendError(
        command.requestId,
        wsBorsh.ERROR_TMUX_TARGET_NOT_FOUND,
        'pane not found',
        false
      );
      return;
    }
    this.sender.sendHistoryTransaction(target.target, command.requestId, page, (key) =>
      this.stream.flushPaneDataBatch(key)
    );
  }

  private async resolveTarget(
    target: CanonicalPaneTarget,
    requestId: Uint8Array | null
  ): Promise<ResolvedTarget | null> {
    const device = await this.ensureDevice(target.deviceId);
    const serverEpoch = device?.runtime.getServerEpoch();
    const pane = device?.runtime.getPaneIdentity(target.paneId);
    if (!device || !serverEpoch || !pane) {
      this.sender.sendError(
        requestId,
        wsBorsh.ERROR_TMUX_TARGET_NOT_FOUND,
        'pane not found',
        false
      );
      return null;
    }
    if (!bytesEqual(target.serverEpoch, serverEpoch)) {
      this.stream.sendOrQueueStreamGap(wsBorsh.SOURCE_GAP_REASON_EPOCH_CHANGED);
      return null;
    }
    return {
      device,
      pane,
      target: { deviceId: target.deviceId, serverEpoch, paneId: target.paneId },
    };
  }

  private startScreenJob(
    device: AttachedDevice,
    pane: PaneIdentity,
    requestId: Uint8Array,
    byteLimit: number
  ): void {
    const key = paneKey(device.deviceId, pane.paneId);
    const existing = this.screenJobs.get(key);
    if (existing) this.cancelScreenJob(existing);
    const job: ScreenJob = {
      key,
      requestId: copyBytes(requestId),
      cancelled: false,
    };
    this.screenJobs.set(key, job);
    this.screenTransactionsStarted += 1;
    void this.runScreenJob(job, device, pane, byteLimit);
  }

  // raw 直通语义：快照只是画面基线（capture-pane 当刻状态），不 gate live 流、
  // 不从 replay 缓存拼接续传。live 帧与快照的先后顺序由客户端处理：
  // 收到快照即 reset+write，其后 live 直写。
  private async runScreenJob(
    job: ScreenJob,
    device: AttachedDevice,
    pane: PaneIdentity,
    byteLimit: number
  ): Promise<void> {
    let completed = false;
    try {
      const checkpoint = await device.runtime.captureCanonicalScreen(pane.paneId, byteLimit);
      if (!this.isCurrentScreenJob(job)) return;
      if (!checkpoint) {
        this.sender.sendError(
          job.requestId,
          wsBorsh.ERROR_TMUX_NOT_READY,
          'screen unavailable',
          true
        );
        return;
      }
      if (
        !this.sender.sendScreenTransaction(device.deviceId, job.requestId, checkpoint, {
          splitAtBase: (key, paneEpoch, baseSeq) =>
            this.stream.splitPaneDataBatchAtBase(key, paneEpoch, baseSeq),
          sendLive: (deviceId, segment) => this.stream.sendPaneData(deviceId, segment),
        })
      ) {
        return;
      }
      completed = true;
    } catch (error) {
      if (this.isCurrentScreenJob(job)) {
        this.sender.sendError(
          job.requestId,
          wsBorsh.ERROR_INTERNAL_ERROR,
          error instanceof Error ? error.message : 'screen capture failed',
          true
        );
      }
    } finally {
      if (this.screenJobs.get(job.key) === job) {
        this.screenJobs.delete(job.key);
      }
      if (completed) this.screenTransactionsCompleted += 1;
      else if (!job.cancelled) this.screenTransactionsFailed += 1;
    }
  }

  private isCurrentScreenJob(job: ScreenJob): boolean {
    return !this.closed && !job.cancelled && this.screenJobs.get(job.key) === job;
  }

  private cancelScreenJob(job: ScreenJob): void {
    if (job.cancelled) return;
    job.cancelled = true;
    this.screenTransactionsCancelled += 1;
  }
}
