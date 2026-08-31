import type { ServerWebSocket } from 'bun';

export type CarrierSendResult = 'sent' | 'backpressure' | 'closed';

export interface Carrier {
  send(bytes: Uint8Array): CarrierSendResult;
  bufferedAmount(): number;
  onDrain(cb: () => void): void;
  close(code: number, reason: string): void;
  terminate(): void;
  hasPendingWrites?(): boolean;
}

export class BunSocketCarrier implements Carrier {
  private readonly drainCallbacks: Array<() => void> = [];

  constructor(private readonly socket: ServerWebSocket<unknown>) {}

  send(bytes: Uint8Array): CarrierSendResult {
    try {
      const status = this.socket.send(bytes);
      if (status > 0) return 'sent';
      if (status === -1) return 'backpressure';
      return 'closed';
    } catch {
      return 'closed';
    }
  }

  bufferedAmount(): number {
    try {
      return Math.max(0, this.socket.getBufferedAmount());
    } catch {
      return 0;
    }
  }

  onDrain(cb: () => void): void {
    this.drainCallbacks.push(cb);
  }

  emitDrain(): void {
    for (const cb of this.drainCallbacks) {
      cb();
    }
  }

  close(code: number, reason: string): void {
    try {
      this.socket.close(code, reason);
    } catch {
      // The socket may already be closing.
    }
  }

  terminate(): void {
    try {
      this.socket.terminate();
    } catch {
      // The socket may already be closing.
    }
  }
}
