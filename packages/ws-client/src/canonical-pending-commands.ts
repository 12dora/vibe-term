import { wsBorsh } from '@tmex/shared';
import {
  type PendingTargetCommand,
  clonePendingCommand,
  commandDeviceId,
  estimateCommandBytes,
  isOrderedInput,
} from './canonical-state-helpers';
import type { ClientSendResult } from './client';
import type { GatewayTransportCommand, GatewayTransportEventHandler } from './transport-types';

export class CanonicalPendingCommands {
  private items: PendingTargetCommand[] = [];
  private bytes = 0;
  private overflowOpen = false;
  private inputAborted = false;

  constructor(
    private readonly emit: GatewayTransportEventHandler,
    private readonly maxBytes: number,
    private readonly maxFrames: number
  ) {}

  enqueue(command: GatewayTransportCommand, allowQueue: boolean): ClientSendResult {
    if (!allowQueue) return 'queued';
    if (isOrderedInput(command) && this.inputAborted) return 'overflow';
    const bytes = estimateCommandBytes(command);
    if (this.items.length < this.maxFrames && this.bytes + bytes <= this.maxBytes) {
      this.items.push({ command: clonePendingCommand(command), bytes });
      this.bytes += bytes;
      return 'queued';
    }
    let droppedFrames = 0;
    if (isOrderedInput(command)) droppedFrames = this.abortOrderedInput();
    if (!this.overflowOpen) {
      this.overflowOpen = true;
      this.emit({
        type: 'pending-overflow',
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
    const pending = this.items;
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
