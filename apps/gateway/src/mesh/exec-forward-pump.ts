import { LinkError, type LinkStream } from '@vibeterm/shared/link';

export const EXEC_FORWARD_QUEUE_MAX_BYTES = 16 * 1024 * 1024;
export const EXEC_FORWARD_WS_HIGH_WATER = 1024 * 1024;
const DRAIN_POLL_MS = 100;
const PASSTHROUGH_EXEC_CLOSE_CODES = new Set([4400, 4403, 4408, 4409]);

export type ExecForwardSocket = {
  send(data: Uint8Array): number | undefined;
  close(code?: number, reason?: string): void;
  getBufferedAmount?(): number;
};

export type ExecForwardOpener = (signal: AbortSignal) => Promise<LinkStream>;

type StreamEnd = { reason?: string; message?: string };
type WsClose = { code: number; reason: string };
type Finish = { close: WsClose | null; stream: 'reset' | 'end'; streamReason?: string };

export function execForwardCloseFor(info: StreamEnd): WsClose {
  if (info.reason === 'end') return { code: 1000, reason: 'exec_end' };
  const message = info.message ?? '';
  if (info.reason === 'rst') {
    if (message === 'unknown-stream-type') return { code: 4404, reason: 'exec_unsupported' };
    if (message.startsWith('auth:')) return { code: 4401, reason: 'NODE_LOGIN_REQUIRED' };
    const passthrough = /^exec:(\d{4})$/.exec(message);
    const code = passthrough ? Number(passthrough[1]) : 0;
    if (PASSTHROUGH_EXEC_CLOSE_CODES.has(code)) return { code, reason: 'exec_closed' };
  }
  return { code: 4502, reason: 'NODE_UNREACHABLE' };
}

function streamEndOf(err: unknown): StreamEnd {
  if (err instanceof LinkError) return { reason: err.code, message: err.message };
  return { reason: 'link-closed' };
}

function toBytes(message: unknown): Uint8Array | null {
  if (message instanceof Uint8Array) return message.slice();
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  if (ArrayBuffer.isView(message)) {
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength).slice();
  }
  return null;
}

/**
 * 入口侧的 exec 字节泵：WebSocket 二进制消息与 mux 流之间不解析、只搬运。
 * 上行经有界队列顺序 `write`（流窗口即背压）；下行在 WS 发送缓冲过高时停止拉取，等 drain 再继续。
 */
export class ExecForwardPump {
  private readonly abort = new AbortController();
  private readonly queue: Uint8Array[] = [];
  private queuedBytes = 0;
  private ws: ExecForwardSocket | null = null;
  private stream: LinkStream | null = null;
  private writing = false;
  private done = false;
  private sendBlocked = false;
  private drainWake: (() => void) | null = null;

  constructor(private readonly openStream: ExecForwardOpener) {}

  open(ws: ExecForwardSocket): void {
    this.ws = ws;
    this.openStream(this.abort.signal).then(
      (stream) => this.bind(stream),
      () => this.finish({ close: { code: 4502, reason: 'NODE_UNREACHABLE' }, stream: 'reset' })
    );
  }

  onMessage(message: unknown): void {
    if (this.done) return;
    if (typeof message === 'string') {
      this.finish({
        close: { code: 4400, reason: 'binary_required' },
        stream: 'reset',
        streamReason: 'client-protocol',
      });
      return;
    }
    const bytes = toBytes(message);
    if (!bytes || bytes.byteLength === 0) return;
    if (this.queuedBytes + bytes.byteLength > EXEC_FORWARD_QUEUE_MAX_BYTES) {
      this.finish({
        close: { code: 1009, reason: 'exec_queue_overflow' },
        stream: 'reset',
        streamReason: 'client-overflow',
      });
      return;
    }
    this.queue.push(bytes);
    this.queuedBytes += bytes.byteLength;
    void this.writeLoop();
  }

  onDrain(): void {
    this.sendBlocked = false;
    this.drainWake?.();
  }

  onClose(): void {
    this.finish({ close: null, stream: 'reset', streamReason: 'client-closed' });
  }

  private bind(stream: LinkStream): void {
    if (this.done) {
      stream.reset('client-closed');
      return;
    }
    this.stream = stream;
    stream.onAbort(() => void stream.closed.then((info) => this.onStreamClosed(info)));
    void this.writeLoop();
    void this.readLoop(stream);
  }

  private onStreamClosed(info: StreamEnd): void {
    this.finish({ close: execForwardCloseFor(info), stream: 'reset' });
  }

  private async writeLoop(): Promise<void> {
    const stream = this.stream;
    if (!stream || this.writing) return;
    this.writing = true;
    try {
      for (let next = this.queue[0]; next && !this.done; next = this.queue[0]) {
        await stream.write(next);
        if (this.done) break;
        this.queue.shift();
        this.queuedBytes -= next.byteLength;
      }
    } catch (err) {
      this.writing = false;
      this.onStreamClosed(streamEndOf(err));
      return;
    }
    this.writing = false;
  }

  private async readLoop(stream: LinkStream): Promise<void> {
    const reader = stream.readable.getReader();
    try {
      for (;;) {
        await this.waitWritable();
        if (this.done) return;
        const chunk = await reader.read();
        if (this.done) return;
        if (chunk.done) {
          this.finish({ close: { code: 1000, reason: 'exec_end' }, stream: 'end' });
          return;
        }
        if (chunk.value.bytes.byteLength > 0) this.sendToClient(chunk.value.bytes);
      }
    } catch (err) {
      if (!this.done) this.onStreamClosed(streamEndOf(err));
    }
  }

  private sendToClient(bytes: Uint8Array): void {
    let result: number | undefined;
    try {
      result = this.ws?.send(bytes);
    } catch {
      result = 0;
    }
    if (result === 0) {
      this.finish({ close: null, stream: 'reset', streamReason: 'client-closed' });
    } else if (result === -1) {
      this.sendBlocked = true;
    }
  }

  private congested(): boolean {
    const buffered = this.ws?.getBufferedAmount;
    if (buffered) return buffered.call(this.ws) > EXEC_FORWARD_WS_HIGH_WATER;
    return this.sendBlocked;
  }

  private async waitWritable(): Promise<void> {
    while (!this.done && this.congested()) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(wake, DRAIN_POLL_MS);
        function wake(): void {
          clearTimeout(timer);
          resolve();
        }
        this.drainWake = wake;
      });
      this.drainWake = null;
    }
  }

  private finish(spec: Finish): void {
    if (this.done) return;
    this.done = true;
    this.abort.abort();
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.drainWake?.();
    if (spec.close) {
      try {
        this.ws?.close(spec.close.code, spec.close.reason);
      } catch {
        // socket already gone
      }
    }
    const stream = this.stream;
    if (!stream) return;
    try {
      if (spec.stream === 'end') void stream.end().catch(() => undefined);
      else stream.reset(spec.streamReason ?? 'exec-forward-closed');
    } catch {
      // stream already dead
    }
  }
}
