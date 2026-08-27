import type { ByteTransport } from '@tmex/shared/link';
import { FRAGMENT_PAYLOAD_SIZE, FrameReassembler, fragmentFrame } from './fragmenter';
import type { DataChannelLike } from './native';
import { copyBytes, sendBinary, toUint8Array } from './native';

export class DataChannelLink implements ByteTransport {
  readonly channel: DataChannelLike;
  private readonly reassembler: FrameReassembler;
  private readonly dataCbs: Array<(bytes: Uint8Array) => void> = [];
  private readonly closeCbs: Array<(reason?: string) => void> = [];
  private readonly queue: Uint8Array[] = [];
  private nextFrameId = 1;
  private closed = false;
  private opened: boolean;

  constructor(channel: DataChannelLike, opts?: { reassembler?: FrameReassembler }) {
    this.channel = channel;
    this.reassembler = opts?.reassembler ?? new FrameReassembler();
    this.opened = channel.isOpen();
    channel.onOpen(() => {
      this.opened = true;
      this.flush();
    });
    channel.onMessage((msg) => {
      if (this.closed) return;
      const frame = this.reassembler.push(copyBytes(toUint8Array(msg)));
      if (!frame) return;
      for (const cb of this.dataCbs) cb(frame);
    });
    channel.onClosed(() => {
      this.finishClose('channel-closed');
    });
  }

  send(bytes: Uint8Array): void {
    if (this.closed) return;
    this.queue.push(copyBytes(bytes));
    this.flush();
  }

  onData(cb: (bytes: Uint8Array) => void): void {
    this.dataCbs.push(cb);
  }

  onClose(cb: (reason?: string) => void): void {
    this.closeCbs.push(cb);
  }

  close(reason?: string): void {
    this.finishClose(reason ?? 'closed');
    try {
      this.channel.close();
    } catch {
      // already closed
    }
  }

  private flush(): void {
    if (!this.opened || this.closed) return;
    while (this.queue.length > 0) {
      const frame = this.queue.shift();
      if (!frame) break;
      const frameId = this.nextFrameId++ >>> 0;
      const parts = fragmentFrame(frameId, frame, FRAGMENT_PAYLOAD_SIZE);
      for (const part of parts) {
        if (!sendBinary(this.channel, part)) {
          this.queue.unshift(frame);
          return;
        }
      }
    }
  }

  private finishClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    for (const cb of this.closeCbs) {
      try {
        cb(reason);
      } catch {
        // close listener
      }
    }
  }
}
