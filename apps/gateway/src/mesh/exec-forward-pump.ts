import { LinkError, type LinkStream } from '@vibeterm/shared/link';

export const EXEC_FORWARD_QUEUE_MAX_BYTES = 16 * 1024 * 1024;
export const EXEC_FORWARD_PREOPEN_MAX_BYTES = 1024 * 1024;
export const EXEC_FORWARD_WS_HIGH_WATER = 1024 * 1024;
export const EXEC_FORWARD_CLOSE_FLUSH_MS = 3000;
export const EXEC_FORWARD_HALF_CLOSE_MS = 30_000;
const DRAIN_POLL_MS = 100;
const SEGMENT_MAX_BYTES = 64 * 1024;
const SEGMENT_OWN_MIN_BYTES = 16 * 1024;
const SEGMENT_INITIAL_BYTES = 1024;
const PASSTHROUGH_EXEC_CLOSE_CODES = new Set([4400, 4401, 4403, 4408, 4409]);

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
    if (code === 4401) return { code, reason: 'NODE_LOGIN_REQUIRED' };
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

type Segment = { buf: Uint8Array; len: number };

/** 上行队列：小消息合并进可增长的段，段数与字节数同阶，避免海量小消息放大成逐条 Uint8Array 开销。 */
class UploadQueue {
  bytes = 0;
  private readonly segments: Segment[] = [];
  private tail: Segment | null = null;

  get pending(): boolean {
    return this.segments.length > 0;
  }

  push(chunk: Uint8Array): void {
    this.bytes += chunk.byteLength;
    if (chunk.byteLength >= SEGMENT_OWN_MIN_BYTES) {
      this.tail = null;
      this.segments.push({ buf: chunk, len: chunk.byteLength });
      return;
    }
    const tail = this.tail;
    if (tail && tail.len + chunk.byteLength <= SEGMENT_MAX_BYTES) {
      this.append(tail, chunk);
      return;
    }
    const segment = {
      buf: new Uint8Array(Math.max(chunk.byteLength, SEGMENT_INITIAL_BYTES)),
      len: 0,
    };
    this.append(segment, chunk);
    this.segments.push(segment);
    this.tail = segment;
  }

  /** 取出队首段交给写入方；该段此后不再被追加。字节数在 `settle` 时才扣除。 */
  take(): Uint8Array | null {
    const segment = this.segments.shift();
    if (!segment) return null;
    if (segment === this.tail) this.tail = null;
    return segment.buf.subarray(0, segment.len);
  }

  settle(bytes: number): void {
    this.bytes -= bytes;
  }

  clear(): void {
    this.segments.length = 0;
    this.tail = null;
    this.bytes = 0;
  }

  private append(segment: Segment, chunk: Uint8Array): void {
    const need = segment.len + chunk.byteLength;
    if (need > segment.buf.length) {
      const capacity = Math.min(SEGMENT_MAX_BYTES, Math.max(segment.buf.length * 2, need));
      const grown = new Uint8Array(capacity);
      grown.set(segment.buf.subarray(0, segment.len));
      segment.buf = grown;
    }
    segment.buf.set(chunk, segment.len);
    segment.len = need;
  }
}

/**
 * 入口侧的 exec 字节泵：WebSocket 二进制消息与 mux 流之间不解析、只搬运。
 * 上行经有界队列顺序 `write`（流窗口即背压）；下行在 WS 发送缓冲过高时停止拉取，等 drain 再继续。
 * 客户端关闭 WS 时先把已排队的字节写完再半关闭（END），目标侧才能收到末尾的 CLOSE / ACK；
 * 排空超时才退回 RST。
 */
export class ExecForwardPump {
  private readonly abort = new AbortController();
  private readonly queue = new UploadQueue();
  private ws: ExecForwardSocket | null = null;
  private stream: LinkStream | null = null;
  private writing = false;
  private done = false;
  private closing = false;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private sendBlocked = false;
  private drainWake: (() => void) | null = null;

  constructor(
    private readonly openStream: ExecForwardOpener,
    private readonly closeFlushMs: number = EXEC_FORWARD_CLOSE_FLUSH_MS
  ) {}

  open(ws: ExecForwardSocket): void {
    this.ws = ws;
    this.openStream(this.abort.signal).then(
      (stream) => this.bind(stream),
      () => this.finish({ close: { code: 4502, reason: 'NODE_UNREACHABLE' }, stream: 'reset' })
    );
  }

  onMessage(message: unknown): void {
    if (this.done || this.closing) return;
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
    const limit = this.stream ? EXEC_FORWARD_QUEUE_MAX_BYTES : EXEC_FORWARD_PREOPEN_MAX_BYTES;
    if (this.queue.bytes + bytes.byteLength > limit) {
      this.finish({
        close: { code: 1009, reason: 'exec_queue_overflow' },
        stream: 'reset',
        streamReason: 'client-overflow',
      });
      return;
    }
    this.queue.push(bytes);
    void this.writeLoop();
  }

  onDrain(): void {
    this.sendBlocked = false;
    this.drainWake?.();
  }

  onClose(): void {
    if (this.done || this.closing) return;
    if (!this.stream) {
      this.finish({ close: null, stream: 'reset', streamReason: 'client-closed' });
      return;
    }
    this.closing = true;
    this.armCloseTimer(this.closeFlushMs);
    this.drainWake?.();
    void this.writeLoop();
  }

  private armCloseTimer(ms: number): void {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(
      () => this.finish({ close: null, stream: 'reset', streamReason: 'client-closed' }),
      ms
    );
    this.closeTimer.unref?.();
  }

  /** 队列已写空：半关闭上行，之后只丢弃下行直到目标侧也结束。 */
  private halfClose(stream: LinkStream): void {
    stream.end().then(
      () => {
        if (!this.done) this.armCloseTimer(EXEC_FORWARD_HALF_CLOSE_MS);
      },
      () => this.finish({ close: null, stream: 'reset', streamReason: 'client-closed' })
    );
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
      for (let next = this.queue.take(); next && !this.done; next = this.queue.take()) {
        await stream.write(next);
        if (!this.done) this.queue.settle(next.byteLength);
      }
    } catch (err) {
      this.writing = false;
      this.onStreamClosed(streamEndOf(err));
      return;
    }
    this.writing = false;
    if (this.closing && !this.done && !this.queue.pending) this.halfClose(stream);
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
          const close = this.closing ? null : { code: 1000, reason: 'exec_end' };
          this.finish({ close, stream: 'end' });
          return;
        }
        if (!this.closing && chunk.value.bytes.byteLength > 0) this.sendToClient(chunk.value.bytes);
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
      this.onClose();
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
    while (!this.done && !this.closing && this.congested()) {
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
    this.queue.clear();
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
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
