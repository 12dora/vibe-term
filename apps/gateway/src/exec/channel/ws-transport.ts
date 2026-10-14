import type { ExecChannelInbound, ExecTransport } from './transport-types';

export const EXEC_WS_DRAIN_BYTES = 256 * 1024;
export const EXEC_WS_CLOSE_PROTOCOL = 4400;
const MAX_CLOSE_REASON_BYTES = 123;

export type ExecWsSocket = {
  sendBinary(data: Uint8Array): number;
  getBufferedAmount(): number;
  close(code?: number, reason?: string): void;
};

export type ExecWsMessage = string | ArrayBuffer | Uint8Array;

export function truncateCloseReason(reason: string): string {
  const bytes = new TextEncoder().encode(reason);
  if (bytes.byteLength <= MAX_CLOSE_REASON_BYTES) return reason;
  let end = MAX_CLOSE_REASON_BYTES;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

export class ExecWsConnection implements ExecTransport {
  private inbound: ExecChannelInbound | null = null;
  private readonly drainCallbacks: Array<() => void> = [];
  private closeRequested = false;
  private closeNotified = false;

  constructor(private readonly ws: ExecWsSocket) {}

  attach(inbound: ExecChannelInbound): void {
    this.inbound = inbound;
  }

  get bufferedBytes(): number {
    try {
      return this.ws.getBufferedAmount();
    } catch {
      return 0;
    }
  }

  send(frame: Uint8Array): void {
    if (this.closeRequested || this.closeNotified) return;
    try {
      this.ws.sendBinary(frame);
    } catch {
      // 连接已断，随后的 close 事件会通知会话
    }
  }

  onDrain(cb: () => void): void {
    this.drainCallbacks.push(cb);
  }

  close(code: number, reason: string): void {
    if (this.closeRequested) return;
    this.closeRequested = true;
    try {
      this.ws.close(code, truncateCloseReason(reason));
    } catch {
      this.handleClose();
    }
  }

  handleMessage(message: ExecWsMessage): void {
    if (this.closeRequested || this.closeNotified) return;
    if (typeof message === 'string') {
      this.close(EXEC_WS_CLOSE_PROTOCOL, 'binary frames only');
      return;
    }
    const bytes =
      message instanceof Uint8Array
        ? new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
        : new Uint8Array(message);
    this.inbound?.onBytes(bytes);
  }

  handleDrain(): void {
    if (this.closeNotified || this.bufferedBytes >= EXEC_WS_DRAIN_BYTES) return;
    for (const cb of [...this.drainCallbacks]) {
      try {
        cb();
      } catch {
        // 会话回调自行兜底，传输层不因它断连
      }
    }
  }

  handleClose(): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.inbound?.onClose();
  }
}
