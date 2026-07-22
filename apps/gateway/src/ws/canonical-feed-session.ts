import { wsBorsh } from '@tmex/shared';

import type {
  DeviceSessionRuntime,
  DeviceSessionRuntimeListener,
} from '../tmux-client/device-session-runtime';
import {
  type PaneHistoryCursor,
  PaneHistoryCursorError,
  type PaneHistoryPage,
} from '../tmux-client/pane-history-reader';
import {
  DEFAULT_MAX_ACTIVE_PANES,
  DEFAULT_MAX_HOT_PANES,
  type PaneDataSegment,
  type PaneIdentity,
  type PaneReplayGap,
  type PaneReplayPlan,
  type PaneRetentionConsumerLease,
  type PaneScreenCheckpoint,
  type PaneSubscriptionApplyResult,
  type PaneSubscriptionRequest,
  type PaneTerminalCursor,
} from '../tmux-client/pane-retention';

export const CANONICAL_MAX_SCREEN_BYTES = 512 * 1024;
export const CANONICAL_MAX_HISTORY_PAGE_BYTES = 256 * 1024;
export const CANONICAL_MAX_PENDING_PANE_GAPS = 256;
export const CANONICAL_MAX_INPUT_DEDUP_IDS = 1_024;
const ENVELOPE_BYTES = 16;

type CanonicalEvent = wsBorsh.CanonicalEvent;
type CanonicalCommand = wsBorsh.CanonicalCommand;
type CanonicalPaneTarget = wsBorsh.CanonicalPaneTarget;
type CanonicalPaneSubscription = wsBorsh.CanonicalPaneSubscription;

export interface CanonicalFeedRuntime
  extends Pick<
    DeviceSessionRuntime,
    | 'getServerEpoch'
    | 'getMetadataSnapshot'
    | 'getPaneIdentity'
    | 'attachPaneConsumer'
    | 'subscribe'
    | 'getPaneScreenCheckpoint'
    | 'readPaneReplay'
    | 'readPaneHistory'
    | 'captureCanonicalScreen'
    | 'sendInputBytes'
    | 'resizePane'
  > {}

export interface CanonicalFeedSessionOptions {
  maxFrameBytes: number;
  sendEvent: (event: CanonicalEvent) => boolean;
  resolveRuntime: (deviceId: string) => Promise<CanonicalFeedRuntime | null>;
  initialDeviceIds?: () => Iterable<string>;
  onDeviceAttached?: (deviceId: string, runtime: CanonicalFeedRuntime) => void;
  onDeviceDetached?: (deviceId: string, runtime: CanonicalFeedRuntime) => void;
  createEpoch?: () => Uint8Array;
  maxPendingPaneGaps?: number;
}

export interface CanonicalFeedSessionStats {
  attachedRuntimes: number;
  screenJobs: number;
  gatedPanes: number;
  pendingPaneGaps: number;
  pendingPaneGapLimit: number;
  streamGapPending: boolean;
  inputDedupIds: number;
  inputDedupLimit: number;
  paneDataDeliveries: number;
  paneDataBytes: number;
  paneDataDrops: number;
  paneDataDropBytes: number;
  pendingPaneGapOverflows: number;
  paneGapsSent: number;
  paneGapsByReason: Record<PaneReplayGap['reason'], number>;
  streamGapsSent: number;
  screenTransactionsStarted: number;
  screenTransactionsCompleted: number;
  screenTransactionsFailed: number;
  screenTransactionsCancelled: number;
}

interface AttachedDevice {
  deviceId: string;
  runtime: CanonicalFeedRuntime;
  lease: PaneRetentionConsumerLease;
  detachListener: () => void;
  metadataNeedsRebase: boolean;
}

interface ScreenJob {
  key: string;
  requestId: Uint8Array;
  cancelled: boolean;
  subscriptionGeneration: bigint | null;
}

interface ResolvedTarget {
  device: AttachedDevice;
  pane: PaneIdentity;
  target: CanonicalPaneTarget;
}

function defaultCreateEpoch(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

function copyBytes(value: Uint8Array): Uint8Array {
  return Uint8Array.from(value);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function bytesHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function paneKey(deviceId: string, paneId: string): string {
  return `${deviceId}\0${paneId}`;
}

function sourceGapReason(reason: PaneReplayGap['reason']): number {
  if (reason === 'epoch_changed') return wsBorsh.SOURCE_GAP_REASON_EPOCH_CHANGED;
  if (reason === 'cache_evicted') return wsBorsh.SOURCE_GAP_REASON_CACHE_EVICTED;
  return wsBorsh.SOURCE_GAP_REASON_PANE_GAP;
}

function rejectionReason(reason: string): number {
  if (reason === 'resource_exhausted') return wsBorsh.SUBSCRIPTION_REJECTED_RESOURCE_EXHAUSTED;
  if (reason === 'epoch_changed') return wsBorsh.SUBSCRIPTION_REJECTED_EPOCH_CHANGED;
  return wsBorsh.SUBSCRIPTION_REJECTED_NOT_FOUND;
}

export class CanonicalFeedSession {
  private readonly devices = new Map<string, AttachedDevice>();
  private readonly screenJobs = new Map<string, ScreenJob>();
  private readonly paneSendGates = new Set<string>();
  private readonly paneSendGaps = new Map<string, PaneReplayGap>();
  private readonly inputIds = new Set<string>();
  private readonly inputIdOrder: string[] = [];
  private readonly gatewayEpoch: Uint8Array;
  private readonly maxFrameBytes: number;
  private readonly maxPendingPaneGaps: number;
  private readySent = false;
  private bootstrapped = false;
  private closed = false;
  private latestSubscriptionGeneration: bigint | null = null;
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
  private screenTransactionsStarted = 0;
  private screenTransactionsCompleted = 0;
  private screenTransactionsFailed = 0;
  private screenTransactionsCancelled = 0;

  constructor(private readonly options: CanonicalFeedSessionOptions) {
    this.maxFrameBytes = Math.min(
      Math.max(ENVELOPE_BYTES + 64, options.maxFrameBytes),
      wsBorsh.CANONICAL_STATE_MAX_FRAME_BYTES
    );
    this.maxPendingPaneGaps = options.maxPendingPaneGaps ?? CANONICAL_MAX_PENDING_PANE_GAPS;
    if (!Number.isSafeInteger(this.maxPendingPaneGaps) || this.maxPendingPaneGaps <= 0) {
      throw new Error('pending pane gap limit must be a positive safe integer');
    }
    this.gatewayEpoch = copyBytes((options.createEpoch ?? defaultCreateEpoch)());
    if (this.gatewayEpoch.byteLength !== 16) throw new Error('gateway epoch must be 16 bytes');
  }

  snapshotStats(): CanonicalFeedSessionStats {
    return {
      attachedRuntimes: this.devices.size,
      screenJobs: this.screenJobs.size,
      gatedPanes: this.paneSendGates.size,
      pendingPaneGaps: this.paneSendGaps.size,
      pendingPaneGapLimit: this.maxPendingPaneGaps,
      streamGapPending: this.streamGapPendingReason !== null,
      inputDedupIds: this.inputIds.size,
      inputDedupLimit: CANONICAL_MAX_INPUT_DEDUP_IDS,
      paneDataDeliveries: this.paneDataDeliveries,
      paneDataBytes: this.paneDataBytes,
      paneDataDrops: this.paneDataDrops,
      paneDataDropBytes: this.paneDataDropBytes,
      pendingPaneGapOverflows: this.pendingPaneGapOverflows,
      paneGapsSent: this.paneGapsSent,
      paneGapsByReason: { ...this.paneGapsByReason },
      streamGapsSent: this.streamGapsSent,
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
      this.sendError(
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
      onData: (segment) => this.handlePaneData(deviceId, segment),
      onGap: (gap) => this.handlePaneGap(deviceId, gap),
    });
    const listener: DeviceSessionRuntimeListener = {
      onMetadataPatch: (patch) => {
        if (!attached) return;
        if (!this.eventFits({ SourceMetadataPatch: patch })) {
          attached.metadataNeedsRebase = true;
          this.sendMetadataSnapshot(attached);
          return;
        }
        if (!this.send({ SourceMetadataPatch: patch })) attached.metadataNeedsRebase = true;
      },
      onMetadataRebaseRequired: () => {
        if (!attached) return;
        attached.metadataNeedsRebase = true;
        this.sendMetadataSnapshot(attached);
      },
      onClose: () => {
        if (!attached) return;
        attached.metadataNeedsRebase = true;
        this.sendOrQueueStreamGap(wsBorsh.SOURCE_GAP_REASON_EPOCH_CHANGED);
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
    this.sendMetadataSnapshot(attached);
    return true;
  }

  detachDevice(deviceId: string): void {
    const attached = this.devices.get(deviceId);
    if (!attached) return;
    this.devices.delete(deviceId);
    attached.lease.close();
    attached.detachListener();
    for (const [key, job] of this.screenJobs) {
      if (key.startsWith(`${deviceId}\0`)) {
        this.cancelScreenJob(job);
        this.screenJobs.delete(key);
        this.paneSendGates.delete(key);
      }
    }
    this.options.onDeviceDetached?.(deviceId, attached.runtime);
  }

  onDrain(): void {
    if (this.closed) return;
    if (this.streamGapPendingReason !== null) {
      if (!this.sendStreamGap(this.streamGapPendingReason)) return;
      this.streamGapPendingReason = null;
      this.paneSendGaps.clear();
    }
    for (const device of this.devices.values()) {
      if (device.metadataNeedsRebase) this.sendMetadataSnapshot(device);
    }
    for (const [key, gap] of Array.from(this.paneSendGaps)) {
      if (!this.sendPaneGap(key.split('\0')[0] ?? '', gap)) continue;
      this.paneSendGaps.delete(key);
      const [deviceId, paneId] = key.split('\0');
      const device = deviceId ? this.devices.get(deviceId) : null;
      const pane = device && paneId ? device.runtime.getPaneIdentity(paneId) : null;
      if (device && pane) {
        this.startScreenJob(
          device,
          pane,
          defaultCreateEpoch(),
          CANONICAL_MAX_SCREEN_BYTES,
          false,
          null
        );
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const job of this.screenJobs.values()) this.cancelScreenJob(job);
    this.screenJobs.clear();
    this.paneSendGates.clear();
    this.paneSendGaps.clear();
    this.streamGapPendingReason = null;
    for (const deviceId of Array.from(this.devices.keys())) this.detachDevice(deviceId);
  }

  private ensureReady(): void {
    if (this.readySent) return;
    this.readySent = true;
    this.send({
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
    activePanes: CanonicalPaneSubscription[];
    hotPanes: CanonicalPaneSubscription[];
  }): Promise<void> {
    const requestedDeviceIds = new Set(
      [...command.activePanes, ...command.hotPanes].map(
        (subscription) => subscription.pane.deviceId
      )
    );
    await Promise.all(Array.from(requestedDeviceIds, (deviceId) => this.ensureDevice(deviceId)));

    const activeByDevice = new Map<string, PaneSubscriptionRequest[]>();
    const hotByDevice = new Map<string, PaneSubscriptionRequest[]>();
    const rejected: Array<{
      pane: CanonicalPaneTarget;
      reason: number;
    }> = [];

    const collect = (
      subscriptions: CanonicalPaneSubscription[],
      destination: Map<string, PaneSubscriptionRequest[]>
    ) => {
      for (const subscription of subscriptions) {
        const target = subscription.pane;
        const device = this.devices.get(target.deviceId);
        const serverEpoch = device?.runtime.getServerEpoch();
        const pane = device?.runtime.getPaneIdentity(target.paneId);
        if (!device || !serverEpoch || !pane) {
          rejected.push({ pane: target, reason: wsBorsh.SUBSCRIPTION_REJECTED_NOT_FOUND });
          continue;
        }
        if (
          !bytesEqual(serverEpoch, target.serverEpoch) ||
          !bytesEqual(pane.paneEpoch, subscription.cursor?.paneEpoch ?? pane.paneEpoch)
        ) {
          rejected.push({ pane: target, reason: wsBorsh.SUBSCRIPTION_REJECTED_EPOCH_CHANGED });
          continue;
        }
        const requests = destination.get(target.deviceId) ?? [];
        requests.push({
          paneId: target.paneId,
          paneEpoch: pane.paneEpoch,
          cursor: subscription.cursor
            ? {
                paneEpoch: copyBytes(subscription.cursor.paneEpoch),
                terminalSeq: subscription.cursor.terminalSeq,
              }
            : null,
        });
        destination.set(target.deviceId, requests);
      }
    };
    collect(command.activePanes, activeByDevice);
    collect(command.hotPanes, hotByDevice);

    const applyResults: Array<{ device: AttachedDevice; result: PaneSubscriptionApplyResult }> = [];
    for (const device of this.devices.values()) {
      const result = device.lease.applySubscriptions(
        command.generation,
        activeByDevice.get(device.deviceId) ?? [],
        hotByDevice.get(device.deviceId) ?? []
      );
      applyResults.push({ device, result });
      const serverEpoch = device.runtime.getServerEpoch();
      if (!serverEpoch) continue;
      for (const item of result.rejected) {
        rejected.push({
          pane: { deviceId: device.deviceId, serverEpoch, paneId: item.paneId },
          reason: rejectionReason(item.reason),
        });
      }
    }

    const appliedGeneration = applyResults.reduce(
      (latest, item) => (item.result.generation > latest ? item.result.generation : latest),
      command.generation
    );
    if (
      this.latestSubscriptionGeneration === null ||
      appliedGeneration > this.latestSubscriptionGeneration
    ) {
      this.latestSubscriptionGeneration = appliedGeneration;
    }
    for (const job of this.screenJobs.values()) {
      if (
        job.subscriptionGeneration !== null &&
        job.subscriptionGeneration !== command.generation
      ) {
        this.cancelScreenJob(job);
      }
    }

    const activePanes: CanonicalPaneTarget[] = [];
    const hotPanes: CanonicalPaneTarget[] = [];
    for (const { device, result } of applyResults) {
      const serverEpoch = device.runtime.getServerEpoch();
      if (!serverEpoch) continue;
      activePanes.push(
        ...result.activePanes.map((pane) => ({
          deviceId: device.deviceId,
          serverEpoch,
          paneId: pane.paneId,
        }))
      );
      hotPanes.push(
        ...result.hotPanes.map((pane) => ({
          deviceId: device.deviceId,
          serverEpoch,
          paneId: pane.paneId,
        }))
      );
    }
    this.send({
      SubscriptionApplied: {
        generation: appliedGeneration,
        activePanes,
        hotPanes,
        rejected,
      },
    });

    for (const { device, result } of applyResults) {
      for (const plan of result.replay) {
        if (plan.gap) this.sendPaneGap(device.deviceId, plan.gap);
        if (plan.needsScreen) {
          this.startScreenJob(
            device,
            plan,
            defaultCreateEpoch(),
            CANONICAL_MAX_SCREEN_BYTES,
            false,
            appliedGeneration
          );
        } else {
          for (const segment of plan.segments) this.sendPaneData(device.deviceId, segment);
        }
      }
    }
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
      this.sendTargetGap(command.pane, command.paneEpoch, 0n, target.pane.paneEpoch, 0n);
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
      this.sendError(command.requestId, wsBorsh.ERROR_INVALID_FRAME, 'invalid pane size', false);
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
      this.sendError(
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
      Math.min(command.byteLimit, CANONICAL_MAX_SCREEN_BYTES),
      true,
      null
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
      this.sendError(
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
        this.sendError(command.requestId, wsBorsh.ERROR_TMUX_NOT_READY, error.message, true);
        return;
      }
      throw error;
    }
    if (!page) {
      this.sendError(
        command.requestId,
        wsBorsh.ERROR_TMUX_TARGET_NOT_FOUND,
        'pane not found',
        false
      );
      return;
    }
    this.sendHistoryTransaction(target.target, command.requestId, page);
  }

  private async resolveTarget(
    target: CanonicalPaneTarget,
    requestId: Uint8Array | null
  ): Promise<ResolvedTarget | null> {
    const device = await this.ensureDevice(target.deviceId);
    const serverEpoch = device?.runtime.getServerEpoch();
    const pane = device?.runtime.getPaneIdentity(target.paneId);
    if (!device || !serverEpoch || !pane) {
      this.sendError(requestId, wsBorsh.ERROR_TMUX_TARGET_NOT_FOUND, 'pane not found', false);
      return null;
    }
    if (!bytesEqual(target.serverEpoch, serverEpoch)) {
      this.sendOrQueueStreamGap(wsBorsh.SOURCE_GAP_REASON_EPOCH_CHANGED);
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
    byteLimit: number,
    forceFresh: boolean,
    subscriptionGeneration: bigint | null
  ): void {
    const key = paneKey(device.deviceId, pane.paneId);
    const existing = this.screenJobs.get(key);
    if (existing) this.cancelScreenJob(existing);
    const job: ScreenJob = {
      key,
      requestId: copyBytes(requestId),
      cancelled: false,
      subscriptionGeneration,
    };
    this.screenJobs.set(key, job);
    this.paneSendGates.add(key);
    this.screenTransactionsStarted += 1;
    void this.runScreenJob(job, device, pane, byteLimit, forceFresh);
  }

  private async runScreenJob(
    job: ScreenJob,
    device: AttachedDevice,
    pane: PaneIdentity,
    byteLimit: number,
    forceFresh: boolean
  ): Promise<void> {
    let completed = false;
    try {
      let checkpoint = forceFresh ? null : device.runtime.getPaneScreenCheckpoint(pane.paneId);
      if (checkpoint) {
        const replay = device.runtime.readPaneReplay(pane.paneId, {
          paneEpoch: checkpoint.paneEpoch,
          terminalSeq: checkpoint.baseSeq,
        });
        if (!replay || replay.gap) checkpoint = null;
      }
      checkpoint ??= await device.runtime.captureCanonicalScreen(pane.paneId, byteLimit);
      if (!this.isCurrentScreenJob(job)) return;
      if (!checkpoint) {
        this.sendError(job.requestId, wsBorsh.ERROR_TMUX_NOT_READY, 'screen unavailable', true);
        return;
      }
      if (!this.sendScreenTransaction(device.deviceId, job.requestId, checkpoint)) return;
      const replay = device.runtime.readPaneReplay(pane.paneId, {
        paneEpoch: checkpoint.paneEpoch,
        terminalSeq: checkpoint.baseSeq,
      });
      if (!this.isCurrentScreenJob(job)) return;
      if (!replay || replay.gap) {
        if (replay?.gap) this.sendPaneGap(device.deviceId, replay.gap);
        return;
      }
      for (const segment of replay.segments) {
        if (!this.isCurrentScreenJob(job)) return;
        if (!this.sendPaneData(device.deviceId, segment, true)) return;
      }
      completed = true;
    } catch (error) {
      if (this.isCurrentScreenJob(job)) {
        this.sendError(
          job.requestId,
          wsBorsh.ERROR_INTERNAL_ERROR,
          error instanceof Error ? error.message : 'screen capture failed',
          true
        );
      }
    } finally {
      if (this.screenJobs.get(job.key) === job) {
        this.screenJobs.delete(job.key);
        this.paneSendGates.delete(job.key);
      }
      if (completed) this.screenTransactionsCompleted += 1;
      else if (!job.cancelled) this.screenTransactionsFailed += 1;
    }
  }

  private isCurrentScreenJob(job: ScreenJob): boolean {
    return (
      !this.closed &&
      !job.cancelled &&
      this.screenJobs.get(job.key) === job &&
      (job.subscriptionGeneration === null ||
        job.subscriptionGeneration === this.latestSubscriptionGeneration)
    );
  }

  private handlePaneData(deviceId: string, segment: PaneDataSegment): void {
    const key = paneKey(deviceId, segment.paneId);
    if (this.paneSendGates.has(key)) return;
    this.sendPaneData(deviceId, segment);
  }

  private handlePaneGap(deviceId: string, gap: PaneReplayGap): void {
    this.sendPaneGap(deviceId, gap);
  }

  private sendPaneData(deviceId: string, segment: PaneDataSegment, bypassGate = false): boolean {
    const device = this.devices.get(deviceId);
    const serverEpoch = device?.runtime.getServerEpoch();
    if (!device || !serverEpoch) {
      this.recordPaneDataDrop(segment.data.byteLength);
      return false;
    }
    const key = paneKey(deviceId, segment.paneId);
    if (!bypassGate && this.paneSendGates.has(key)) return true;
    const target = { deviceId, serverEpoch, paneId: segment.paneId };
    const maxDataBytes = this.maxPaneDataBytes(target, segment.paneEpoch);
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
      if (!this.send(event)) {
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

  private sendPaneGap(deviceId: string, gap: PaneReplayGap): boolean {
    const device = this.devices.get(deviceId);
    const serverEpoch = device?.runtime.getServerEpoch();
    if (!serverEpoch) return false;
    const sent = this.send({
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

  private sendTargetGap(
    target: CanonicalPaneTarget,
    expectedPaneEpoch: Uint8Array,
    expectedSeq: bigint,
    availablePaneEpoch: Uint8Array,
    availableSeq: bigint
  ): void {
    const sent = this.send({
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

  private sendStreamGap(reason: number): boolean {
    const sent = this.send({
      SourceGap: {
        reason,
        scope: { Stream: {} },
      },
    });
    if (sent) this.streamGapsSent += 1;
    return sent;
  }

  private sendOrQueueStreamGap(reason: number): void {
    if (!this.sendStreamGap(reason)) this.streamGapPendingReason = reason;
  }

  private queuePaneGap(key: string, gap: PaneReplayGap): void {
    if (this.streamGapPendingReason !== null || this.paneSendGaps.has(key)) {
      if (this.streamGapPendingReason === null) this.paneSendGaps.set(key, gap);
      return;
    }
    if (this.paneSendGaps.size < this.maxPendingPaneGaps) {
      this.paneSendGaps.set(key, gap);
      return;
    }
    this.pendingPaneGapOverflows += 1;
    this.paneSendGaps.clear();
    this.streamGapPendingReason = wsBorsh.SOURCE_GAP_REASON_PANE_GAP;
  }

  private recordPaneDataDrop(bytes: number): void {
    this.paneDataDrops += 1;
    this.paneDataDropBytes += Math.max(0, bytes);
  }

  private cancelScreenJob(job: ScreenJob): void {
    if (job.cancelled) return;
    job.cancelled = true;
    this.screenTransactionsCancelled += 1;
  }

  private sendScreenTransaction(
    deviceId: string,
    requestId: Uint8Array,
    checkpoint: PaneScreenCheckpoint
  ): boolean {
    const serverEpoch = this.devices.get(deviceId)?.runtime.getServerEpoch();
    if (!serverEpoch) return false;
    const begin: CanonicalEvent = {
      ScreenBegin: {
        requestId,
        pane: { deviceId, serverEpoch, paneId: checkpoint.paneId },
        paneEpoch: copyBytes(checkpoint.paneEpoch),
        baseSeq: checkpoint.baseSeq,
        rows: checkpoint.rows,
        cols: checkpoint.cols,
        modes: checkpoint.modes,
        totalBytes: checkpoint.data.byteLength,
      },
    };
    if (!this.send(begin)) return false;
    if (!this.sendContentChunks('screen', requestId, checkpoint.data)) return false;
    return this.send({
      ScreenCommit: {
        requestId,
        totalBytes: checkpoint.data.byteLength,
        historyCursor: checkpoint.historyCursor,
      },
    });
  }

  private sendHistoryTransaction(
    target: CanonicalPaneTarget,
    requestId: Uint8Array,
    page: PaneHistoryPage
  ): boolean {
    if (
      !this.send({
        HistoryBegin: {
          requestId,
          pane: target,
          paneEpoch: page.paneEpoch,
          historyEpoch: page.historyEpoch,
          lineStart: page.lineStart,
          lineEnd: page.lineEnd,
          truncated: page.truncated,
          totalBytes: page.data.byteLength,
        },
      })
    ) {
      return false;
    }
    if (!this.sendContentChunks('history', requestId, page.data)) return false;
    return this.send({
      HistoryCommit: {
        requestId,
        totalBytes: page.data.byteLength,
        nextCursor: page.nextCursor,
      },
    });
  }

  private sendContentChunks(
    kind: 'screen' | 'history',
    requestId: Uint8Array,
    data: Uint8Array
  ): boolean {
    const maxDataBytes = this.maxContentChunkBytes(kind, requestId);
    if (maxDataBytes <= 0) return false;
    for (let offset = 0; offset < data.byteLength; offset += maxDataBytes) {
      const event =
        kind === 'screen'
          ? ({
              ScreenChunk: { requestId, offset, data: data.slice(offset, offset + maxDataBytes) },
            } satisfies CanonicalEvent)
          : ({
              HistoryChunk: { requestId, offset, data: data.slice(offset, offset + maxDataBytes) },
            } satisfies CanonicalEvent);
      if (!this.send(event)) return false;
    }
    return true;
  }

  private sendMetadataSnapshot(device: AttachedDevice): boolean {
    const snapshot = device.runtime.getMetadataSnapshot();
    const snapshotId = defaultCreateEpoch();
    const chunks = this.partitionMetadataRecords(snapshot, snapshotId);
    if (!chunks) return false;
    let sent = true;
    for (let index = 0; index < chunks.length; index += 1) {
      sent =
        this.send({
          SourceMetadataSnapshot: {
            metadataEpoch: snapshot.metadataEpoch,
            revision: snapshot.revision,
            snapshotId,
            chunkIndex: index,
            totalChunks: chunks.length,
            records: chunks[index] ?? [],
          },
        }) && sent;
      if (!sent) break;
    }
    device.metadataNeedsRebase = !sent;
    return sent;
  }

  private partitionMetadataRecords(
    snapshot: ReturnType<CanonicalFeedRuntime['getMetadataSnapshot']>,
    snapshotId: Uint8Array
  ): wsBorsh.SourceMetadataRecord[][] | null {
    if (snapshot.records.length === 0) return [[]];
    const chunks: wsBorsh.SourceMetadataRecord[][] = [];
    let current: wsBorsh.SourceMetadataRecord[] = [];
    for (const record of snapshot.records) {
      const candidate = [...current, record];
      const event: CanonicalEvent = {
        SourceMetadataSnapshot: {
          metadataEpoch: snapshot.metadataEpoch,
          revision: snapshot.revision,
          snapshotId,
          chunkIndex: 0xffff,
          totalChunks: 0xffff,
          records: candidate,
        },
      };
      if (this.eventFits(event)) {
        current = candidate;
        continue;
      }
      if (current.length === 0) {
        this.sendError(
          null,
          wsBorsh.ERROR_FRAME_TOO_LARGE,
          'metadata record exceeds frame limit',
          false
        );
        return null;
      }
      chunks.push(current);
      current = [record];
      const single = {
        SourceMetadataSnapshot: {
          metadataEpoch: snapshot.metadataEpoch,
          revision: snapshot.revision,
          snapshotId,
          chunkIndex: 0xffff,
          totalChunks: 0xffff,
          records: current,
        },
      } satisfies CanonicalEvent;
      if (!this.eventFits(single)) {
        this.sendError(
          null,
          wsBorsh.ERROR_FRAME_TOO_LARGE,
          'metadata record exceeds frame limit',
          false
        );
        return null;
      }
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
  }

  private maxPaneDataBytes(target: CanonicalPaneTarget, paneEpoch: Uint8Array): number {
    return this.maxVariableDataBytes((data) => ({
      PaneData: {
        pane: target,
        paneEpoch,
        seqStart: 0n,
        seqEnd: BigInt(data.byteLength),
        data,
      },
    }));
  }

  private maxContentChunkBytes(kind: 'screen' | 'history', requestId: Uint8Array): number {
    return this.maxVariableDataBytes((data) =>
      kind === 'screen'
        ? { ScreenChunk: { requestId, offset: 0, data } }
        : { HistoryChunk: { requestId, offset: 0, data } }
    );
  }

  private maxVariableDataBytes(build: (data: Uint8Array) => CanonicalEvent): number {
    let low = 0;
    let high = this.maxFrameBytes;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.eventFits(build(new Uint8Array(middle)))) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  private eventFits(event: CanonicalEvent): boolean {
    try {
      return (
        wsBorsh.encodeCanonicalEventPayload(event).byteLength + ENVELOPE_BYTES <= this.maxFrameBytes
      );
    } catch {
      return false;
    }
  }

  private send(event: CanonicalEvent): boolean {
    if (this.closed || !this.eventFits(event)) return false;
    return this.options.sendEvent(event);
  }

  private sendError(
    requestId: Uint8Array | null,
    code: number,
    message: string,
    retryable: boolean
  ): void {
    this.send({
      Error: {
        requestId: requestId ? copyBytes(requestId) : null,
        code,
        message: message.slice(0, 512),
        retryable,
      },
    });
  }
}
