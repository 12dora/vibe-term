import type { LinkStream } from '@vibeterm/shared/link';
import { attachExecChannel } from './attach';
import type { ExecChannelAuth, ExecChannelInbound, ExecTransport } from './transport-types';

export const LINK_TRANSPORT_DRAIN_BYTES = 256 * 1024;
export const LINK_TRANSPORT_CLOSE_FLUSH_MS = 2000;

export class LinkStreamTransport implements ExecTransport {
  private readonly queue: Uint8Array[] = [];
  private readonly drainCbs: Array<() => void> = [];
  private buffered = 0;
  private writing = false;
  private needDrain = false;
  private closing: { code: number; reason: string } | null = null;
  private finalized = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private inbound: ExecChannelInbound | null = null;
  private inboundClosed = false;

  constructor(
    private readonly stream: LinkStream,
    private readonly closeFlushMs: number = LINK_TRANSPORT_CLOSE_FLUSH_MS
  ) {}

  get bufferedBytes(): number {
    return this.buffered;
  }

  bind(inbound: ExecChannelInbound): void {
    this.inbound = inbound;
  }

  send(frame: Uint8Array): void {
    if (this.closing || this.finalized || frame.byteLength === 0) return;
    this.queue.push(frame);
    this.buffered += frame.byteLength;
    if (this.buffered >= LINK_TRANSPORT_DRAIN_BYTES) this.needDrain = true;
    void this.pumpQueue();
  }

  onDrain(cb: () => void): void {
    this.drainCbs.push(cb);
  }

  close(code: number, reason: string): void {
    if (this.closing || this.finalized) return;
    this.closing = { code, reason };
    if (!this.writing) {
      this.finalize();
      return;
    }
    this.flushTimer = setTimeout(() => this.finalize(), this.closeFlushMs);
    this.flushTimer.unref?.();
  }

  /** 对端 END、RST 或链路断开：只通知 inbound 一次，并丢弃未发出的帧。 */
  notifyInboundClosed(): void {
    this.finalized = true;
    this.clearQueue();
    this.clearFlushTimer();
    if (this.inboundClosed) return;
    this.inboundClosed = true;
    this.inbound?.onClose();
  }

  private async pumpQueue(): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    try {
      for (let frame = this.queue[0]; frame && !this.finalized; frame = this.queue[0]) {
        await this.stream.write(frame);
        if (this.finalized) return;
        this.queue.shift();
        this.buffered -= frame.byteLength;
        this.fireDrain();
      }
    } catch {
      this.writing = false;
      this.abortStream('exec:write-failed');
      return;
    }
    this.writing = false;
    if (this.closing && !this.finalized) this.finalize();
  }

  private fireDrain(): void {
    if (!this.needDrain || this.buffered >= LINK_TRANSPORT_DRAIN_BYTES) return;
    this.needDrain = false;
    for (const cb of this.drainCbs) cb();
  }

  private finalize(): void {
    if (this.finalized) return;
    this.finalized = true;
    this.clearFlushTimer();
    const closing = this.closing;
    this.clearQueue();
    try {
      if (closing?.code === 1000) void this.stream.end().catch(() => undefined);
      else this.stream.reset(`exec:${closing?.code ?? 1011}`);
    } catch {
      // stream already dead
    }
  }

  private abortStream(reason: string): void {
    try {
      this.stream.reset(reason);
    } catch {
      // stream already dead
    }
    this.notifyInboundClosed();
  }

  private clearQueue(): void {
    this.queue.length = 0;
    this.buffered = 0;
  }

  private clearFlushTimer(): void {
    if (this.flushTimer === null) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }
}

async function readInbound(
  stream: LinkStream,
  transport: LinkStreamTransport,
  inbound: ExecChannelInbound
): Promise<void> {
  const reader = stream.readable.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.bytes.byteLength > 0) inbound.onBytes(chunk.value.bytes);
    }
  } catch {
    // RST or link loss: same outcome as a clean END for the exec session (detach).
  }
  transport.notifyInboundClosed();
  try {
    await stream.end();
  } catch {
    // stream already dead
  }
}

/** 把一条 mux 流接成 exec 通道：入站字节喂给 inbound，出站帧经顺序 write 排空。 */
export function attachExecChannelToLinkStream(
  stream: LinkStream,
  auth: ExecChannelAuth,
  attach: typeof attachExecChannel = attachExecChannel
): void {
  const transport = new LinkStreamTransport(stream);
  const inbound = attach(transport, auth);
  transport.bind(inbound);
  stream.onAbort(() => transport.notifyInboundClosed());
  void readInbound(stream, transport, inbound);
}
