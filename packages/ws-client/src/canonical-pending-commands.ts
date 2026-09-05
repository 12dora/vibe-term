import { wsBorsh } from '@tmex/shared';
import {
  type PendingTargetCommand,
  clonePendingCommand,
  commandDeviceId,
  estimateCommandBytes,
  isOrderedInput,
} from './canonical-state-helpers';
import type { ClientSendResult } from './client';
import { STALE_INPUT_TTL_MS } from './pending-send-queue';
import type { GatewayTransportCommand, GatewayTransportEventHandler } from './transport-types';

type PendingItem = PendingTargetCommand & { enqueuedAt: number };

export class CanonicalPendingCommands {
  private items: PendingItem[] = [];
  private bytes = 0;
  private overflowOpen = false;
  private inputAborted = false;

  constructor(
    private readonly emit: GatewayTransportEventHandler,
    private readonly maxBytes: number,
    private readonly maxFrames: number,
    private readonly now: () => number = Date.now
  ) {}

  enqueue(command: GatewayTransportCommand, allowQueue: boolean): ClientSendResult {
    if (!allowQueue) return 'queued';
    if (isOrderedInput(command) && this.inputAborted) return 'overflow';
    const bytes = estimateCommandBytes(command);
    if (this.items.length < this.maxFrames && this.bytes + bytes <= this.maxBytes) {
      this.items.push({ command: clonePendingCommand(command), bytes, enqueuedAt: this.now() });
      this.bytes += bytes;
      return 'queued';
    }
    let droppedFrames = 0;
    if (isOrderedInput(command)) droppedFrames = this.abortOrderedInput();
    if (!this.overflowOpen) {
      this.overflowOpen = true;
      this.emit({
        type: 'pending-overflow',
        reason: 'overflow',
        kind: wsBorsh.KIND_CANONICAL_COMMAND,
        pendingFrames: this.items.length,
        pendingBytes: this.bytes,
        droppedFrames,
      });
    }
    return 'overflow';
  }

  flush(send: (command: GatewayTransportCommand) => ClientSendResult | null): void {
    if (this.items.length === 0) return;
    const pending = this.dropStaleOrderedInput(this.items);
    this.items = [];
    this.bytes = 0;
    for (const item of pending) {
      if (send(item.command) !== 'queued') continue;
      this.items.push(item);
      this.bytes += item.bytes;
    }
    if (this.items.length === 0) this.resetEpisode();
  }

  takeAll(): GatewayTransportCommand[] {
    const commands = this.items.map((item) => item.command);
    this.clear();
    return commands;
  }

  dropDevice(deviceId: string): void {
    this.drop((command) => commandDeviceId(command) === deviceId);
  }

  dropPane(deviceId: string, paneId: string): void {
    this.drop(
      (command) =>
        commandDeviceId(command) === deviceId && 'paneId' in command && command.paneId === paneId
    );
  }

  clear(): void {
    this.items = [];
    this.bytes = 0;
    this.resetEpisode();
  }

  /** 断线期间缓冲的有序输入过期后不再重放，只丢输入，结构性命令照旧。 */
  private dropStaleOrderedInput(pending: PendingItem[]): PendingItem[] {
    const now = this.now();
    const fresh: PendingItem[] = [];
    let droppedFrames = 0;
    for (const item of pending) {
      if (isOrderedInput(item.command) && now - item.enqueuedAt > STALE_INPUT_TTL_MS) {
        droppedFrames += 1;
        continue;
      }
      fresh.push(item);
    }
    if (droppedFrames > 0) {
      this.emit({
        type: 'pending-overflow',
        reason: 'stale',
        kind: wsBorsh.KIND_CANONICAL_COMMAND,
        pendingFrames: fresh.length,
        pendingBytes: fresh.reduce((sum, item) => sum + item.bytes, 0),
        droppedFrames,
      });
    }
    return fresh;
  }

  private abortOrderedInput(): number {
    let dropped = 0;
    this.drop((command) => {
      if (!isOrderedInput(command)) return false;
      dropped += 1;
      return true;
    });
    this.inputAborted = true;
    return dropped;
  }

  private drop(matches: (command: GatewayTransportCommand) => boolean): void {
    this.items = this.items.filter((item) => {
      if (!matches(item.command)) return true;
      this.bytes -= item.bytes;
      return false;
    });
  }

  private resetEpisode(): void {
    this.overflowOpen = false;
    this.inputAborted = false;
  }
}
