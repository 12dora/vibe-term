import { wsBorsh } from '@tmex/shared';

import type { PaneDataSegment, PaneScreenCheckpoint } from '../../tmux-client/pane-retention';
import { copyBytes, paneKey } from './bytes';
import type { CanonicalPaneStream } from './pane-stream';
import type { CanonicalTransactionSender } from './transaction-sender';
import type { AttachedDevice, PaneIdentity, ScreenJob } from './types';

export interface CanonicalScreenJobStats {
  screenJobs: number;
  screenTransactionsStarted: number;
  screenTransactionsCompleted: number;
  screenTransactionsFailed: number;
  screenTransactionsCancelled: number;
}

export interface CanonicalScreenJobsOptions {
  sender: CanonicalTransactionSender;
  stream: CanonicalPaneStream;
  isClosed(): boolean;
  /** 分享连接：pane 在异步抓屏期间被移出 scope window 时整笔事务必须丢弃。 */
  allowsPane(deviceId: string, paneId: string): boolean;
}

/** 首屏抓取事务：一个 pane 同时只有一笔，抓屏期间该 pane 的实时数据被 hold 住。 */
export class CanonicalScreenJobs {
  private readonly jobs = new Map<string, ScreenJob>();
  private started = 0;
  private completed = 0;
  private failed = 0;
  private cancelled = 0;

  constructor(private readonly options: CanonicalScreenJobsOptions) {}

  stats(): CanonicalScreenJobStats {
    return {
      screenJobs: this.jobs.size,
      screenTransactionsStarted: this.started,
      screenTransactionsCompleted: this.completed,
      screenTransactionsFailed: this.failed,
      screenTransactionsCancelled: this.cancelled,
    };
  }

  start(
    device: AttachedDevice,
    pane: PaneIdentity,
    requestId: Uint8Array,
    byteLimit: number
  ): void {
    const key = paneKey(device.deviceId, pane.paneId);
    const existing = this.jobs.get(key);
    if (existing) this.cancel(existing);
    this.options.stream.holdPaneDataBatch(key);
    const job: ScreenJob = { key, requestId: copyBytes(requestId), cancelled: false };
    this.jobs.set(key, job);
    this.started += 1;
    void this.run(job, device, pane, byteLimit);
  }

  cancelDevice(deviceId: string): void {
    for (const [key, job] of this.jobs) {
      if (!key.startsWith(`${deviceId}\0`)) continue;
      this.cancel(job);
      this.jobs.delete(key);
    }
  }

  cancelKey(key: string): void {
    const job = this.jobs.get(key);
    if (!job) return;
    this.cancel(job);
    this.jobs.delete(key);
  }

  cancelUnretained(retainedKeys: ReadonlySet<string>): void {
    for (const [key, job] of Array.from(this.jobs)) {
      if (!retainedKeys.has(key)) this.cancel(job);
    }
  }

  clear(): void {
    for (const job of this.jobs.values()) this.cancel(job);
    this.jobs.clear();
  }

  private cancel(job: ScreenJob): void {
    if (job.cancelled) return;
    job.cancelled = true;
    this.options.stream.releasePaneDataBatch(job.key);
    this.cancelled += 1;
  }

  private isCurrent(job: ScreenJob): boolean {
    return !this.options.isClosed() && !job.cancelled && this.jobs.get(job.key) === job;
  }

  // Live data is held across the asynchronous capture and split at its base sequence.
  private async run(
    job: ScreenJob,
    device: AttachedDevice,
    pane: PaneIdentity,
    byteLimit: number
  ): Promise<void> {
    let completed = false;
    try {
      const checkpoint = await device.runtime.captureCanonicalScreen(pane.paneId, byteLimit);
      if (!this.isCurrent(job)) return;
      if (!this.options.allowsPane(device.deviceId, pane.paneId)) {
        this.options.sender.sendError(
          job.requestId,
          wsBorsh.ERROR_TMUX_TARGET_NOT_FOUND,
          'pane not found',
          false
        );
        return;
      }
      if (!checkpoint) {
        this.options.sender.sendError(
          job.requestId,
          wsBorsh.ERROR_TMUX_NOT_READY,
          'screen unavailable',
          true
        );
        return;
      }
      if (this.options.stream.hasPaneDataHoldOverflow(job.key)) return;
      if (!this.sendTransaction(device.deviceId, job.requestId, checkpoint)) {
        this.options.stream.sendOrQueueStreamGap(wsBorsh.SOURCE_GAP_REASON_CACHE_EVICTED);
        return;
      }
      completed = true;
    } catch (error) {
      if (this.isCurrent(job)) {
        this.options.sender.sendError(
          job.requestId,
          wsBorsh.ERROR_INTERNAL_ERROR,
          error instanceof Error ? error.message : 'screen capture failed',
          true
        );
      }
    } finally {
      if (this.jobs.get(job.key) === job) {
        this.jobs.delete(job.key);
        this.options.stream.releasePaneDataBatch(job.key);
      }
      if (completed) this.completed += 1;
      else if (!job.cancelled) this.failed += 1;
    }
  }

  private sendTransaction(
    deviceId: string,
    requestId: Uint8Array,
    checkpoint: PaneScreenCheckpoint
  ): boolean {
    let heldLivePending = false;
    const sent = this.options.sender.sendScreenTransaction(deviceId, requestId, checkpoint, {
      splitAtBase: (key, paneEpoch, baseSeq): PaneDataSegment | null => {
        const segment = this.options.stream.splitPaneDataBatchAtBase(key, paneEpoch, baseSeq);
        heldLivePending = segment !== null;
        return segment;
      },
      sendLive: (targetDeviceId, segment) => {
        const accepted = this.options.stream.sendPaneData(targetDeviceId, segment);
        if (accepted) heldLivePending = false;
        return accepted;
      },
    });
    return sent && !heldLivePending;
  }
}
