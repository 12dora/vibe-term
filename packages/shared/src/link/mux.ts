import { FrameDecoder, decodeWindowPayload, encodeFrame, encodeWindowPayload } from './codec';
import {
  type ByteTransport,
  CTL_STREAM_ID,
  FLAG_HEAD,
  type Frame,
  FrameOp,
  INITIAL_STREAM_WINDOW,
  type LinkCloseInfo,
  type LinkCtl,
  LinkError,
  type LinkRole,
  type LinkSession,
  type LinkStream,
  MAX_DATA_SEND_PAYLOAD,
  MAX_FRAME_PAYLOAD,
  MAX_LINK_UNACKED,
  type StreamChunk,
  type StreamCloseInfo,
  type WriteOptions,
} from './types';

export const MAX_PENDING_INCOMING = 64;
export const MAX_CTL_INBOX = 64;
export const MAX_MUX_STREAMS = 256;

export type LinkMuxOptions = {
  role: LinkRole;
  streamWindow?: number;
  maxFramePayload?: number;
  maxLinkUnacked?: number;
};

type Waiter = {
  resolve: () => void;
  reject: (err: Error) => void;
};

function copyBytes(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}

function rstReason(payload: Uint8Array): string | undefined {
  if (payload.byteLength === 0) return undefined;
  try {
    return new TextDecoder().decode(payload);
  } catch {
    return undefined;
  }
}

function encodeRstReason(reason?: string): Uint8Array {
  if (!reason) return new Uint8Array(0);
  return new TextEncoder().encode(reason);
}

function muxTrace(event: string, fields: Record<string, unknown>): void {
  const bits: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    bits.push(`${key}=${String(value)}`);
  }
  console.warn(`[mesh][mux] ${event} ${bits.join(' ')}`);
}

class MuxStream implements LinkStream {
  readonly id: number;
  readonly openPayload: Uint8Array;
  readonly readable: ReadableStream<StreamChunk>;
  readonly closed: Promise<StreamCloseInfo>;

  sendWindow: number;
  recvAdvertised: number;
  outstanding = 0;
  sendClosed = false;
  recvClosed = false;
  dead = false;

  private readonly mux: LinkMux;
  private readonly abortCbs: Array<() => void> = [];
  private aborted = false;
  private resolveClosed!: (info: StreamCloseInfo) => void;
  private closedSettled = false;
  private writeChain: Promise<void> = Promise.resolve();
  private endPromise: Promise<void> | null = null;
  private waiters: Waiter[] = [];
  private recvBuf: StreamChunk[] = [];
  private pullWaiter: (() => void) | null = null;
  private outController: ReadableStreamDefaultController<StreamChunk> | null = null;
  private abortError: LinkError | null = null;
  private readonly isCtl: boolean;

  constructor(mux: LinkMux, id: number, openPayload: Uint8Array) {
    this.mux = mux;
    this.id = id;
    this.openPayload = openPayload;
    this.isCtl = id === CTL_STREAM_ID;
    this.sendWindow = mux.streamWindow;
    this.recvAdvertised = mux.streamWindow;
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.readable = new ReadableStream<StreamChunk>(
      {
        start: (controller) => {
          this.outController = controller;
        },
        pull: () => {
          if (this.dead) {
            return Promise.reject(this.abortError ?? this.deadError());
          }
          if (this.recvBuf.length > 0 || this.recvClosed) {
            this.flushReadable();
            return;
          }
          return new Promise<void>((resolve, reject) => {
            this.pullWaiter = () => {
              if (this.dead) {
                reject(this.abortError ?? this.deadError());
                return;
              }
              this.flushReadable();
              resolve();
            };
          });
        },
        cancel: (reason) => {
          if (this.dead || this.isCtl) return;
          const message = reason instanceof Error ? reason.message : String(reason ?? 'cancelled');
          this.mux.resetStream(this, message);
        },
      },
      { highWaterMark: 0 }
    );
  }

  write(bytes: Uint8Array, opts?: WriteOptions): Promise<void> {
    if (this.dead) return Promise.reject(this.deadError());
    if (this.sendClosed) {
      return Promise.reject(new LinkError('closed', 'stream send direction is closed'));
    }
    const run = this.writeChain.then(() => this.writeInternal(bytes, opts));
    this.writeChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  end(): Promise<void> {
    if (this.isCtl) {
      throw new LinkError('protocol', 'ctl stream cannot END');
    }
    if (this.dead) return Promise.resolve();
    if (this.sendClosed) {
      return this.endPromise ?? Promise.resolve();
    }
    this.sendClosed = true;
    const run = this.writeChain.then(() => this.sendEnd());
    this.writeChain = run.then(
      () => undefined,
      () => undefined
    );
    this.endPromise = run;
    return run;
  }

  reset(reason?: string): void {
    if (this.isCtl) {
      throw new LinkError('protocol', 'ctl stream cannot RST');
    }
    if (this.dead) return;
    this.mux.resetStream(this, reason);
  }

  onAbort(cb: () => void): void {
    if (this.aborted) {
      cb();
      return;
    }
    this.abortCbs.push(cb);
  }

  creditSendWindow(delta: number): void {
    this.sendWindow += delta;
    this.flushWaiters();
  }

  async waitForSendCredit(): Promise<void> {
    if (this.dead) {
      throw this.deadError();
    }
    if (this.sendWindow > 0) return;
    await new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
    if (this.dead) {
      throw this.deadError();
    }
  }

  onIncomingData(bytes: Uint8Array, head: boolean): void {
    if (this.dead || this.recvClosed) {
      if (!this.isCtl && !this.dead) {
        this.mux.resetUnknown(this.id);
      }
      return;
    }
    if (bytes.byteLength > this.recvAdvertised) {
      this.mux.resetStream(this, `stream ${this.id} exceeded receive window`);
      return;
    }
    this.recvAdvertised -= bytes.byteLength;
    if (this.isCtl) {
      const pending = this.mux.deliverCtl(bytes);
      const credit = () => this.mux.sendWindowCredit(this, bytes.byteLength);
      if (pending) void pending.then(credit, credit);
      else credit();
      return;
    }
    this.recvBuf.push({ bytes, head });
    this.wakePull();
  }

  onPeerEnd(): void {
    if (this.isCtl) {
      this.mux.protocolError('END on ctl stream');
      return;
    }
    if (this.dead || this.recvClosed) return;
    this.recvClosed = true;
    this.wakePull();
    this.maybeFinishEnd();
  }

  abort(info: StreamCloseInfo): void {
    if (this.dead && this.closedSettled) return;
    this.dead = true;
    this.sendClosed = true;
    this.recvClosed = true;
    const err = new LinkError(info.reason, info.message ?? info.reason);
    this.abortError = err;
    for (const waiter of this.waiters) waiter.reject(err);
    this.waiters = [];
    this.recvBuf = [];
    this.wakePull();
    if (info.reason !== 'end') {
      this.fireAbort();
    }
    this.settleClosed(info);
  }

  fireAbort(): void {
    if (this.aborted) return;
    this.aborted = true;
    for (const cb of this.abortCbs) {
      try {
        cb();
      } catch {
        // listener errors must not break the mux
      }
    }
    this.abortCbs.length = 0;
  }

  consumeFromReadable(byteLength: number): void {
    this.mux.sendWindowCredit(this, byteLength);
  }

  private async writeInternal(bytes: Uint8Array, opts?: WriteOptions): Promise<void> {
    if (this.dead) throw this.deadError();
    if (bytes.byteLength === 0 && !opts?.head) return;

    let offset = 0;
    let first = true;
    if (bytes.byteLength === 0 && opts?.head) {
      await this.waitForSendCredit();
      if (this.dead) throw this.deadError();
      this.takeSendCredit(0);
      await this.mux.sendFrame({
        streamId: this.id,
        op: FrameOp.DATA,
        flags: FLAG_HEAD,
        payload: new Uint8Array(0),
      });
      return;
    }

    while (offset < bytes.byteLength) {
      if (this.dead) throw this.deadError();
      await this.waitForSendCredit();
      if (this.dead) throw this.deadError();
      const n = Math.min(
        bytes.byteLength - offset,
        this.sendWindow,
        this.mux.maxFramePayload,
        MAX_DATA_SEND_PAYLOAD
      );
      if (n <= 0) continue;
      const slice = bytes.subarray(offset, offset + n);
      this.takeSendCredit(n);
      const flags = first && opts?.head ? FLAG_HEAD : 0;
      first = false;
      await this.mux.sendFrame({
        streamId: this.id,
        op: FrameOp.DATA,
        flags,
        payload: slice,
      });
      offset += n;
    }
  }

  private async sendEnd(): Promise<void> {
    if (this.dead) return;
    await this.mux.sendFrame({ streamId: this.id, op: FrameOp.END });
    this.maybeFinishEnd();
  }

  private takeSendCredit(n: number): void {
    this.sendWindow -= n;
    this.outstanding += n;
    this.mux.addUnacked(n);
  }

  private flushWaiters(): void {
    while (this.waiters.length > 0 && this.sendWindow > 0 && !this.dead) {
      const waiter = this.waiters.shift();
      waiter?.resolve();
    }
  }

  private flushReadable(): void {
    const controller = this.outController;
    if (!controller) return;
    if (this.dead) {
      return;
    }
    if (this.recvBuf.length === 0) {
      if (this.recvClosed) {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
      return;
    }
    const chunk = this.recvBuf.shift();
    if (!chunk) return;
    try {
      controller.enqueue(chunk);
    } catch {
      this.recvBuf.unshift(chunk);
      return;
    }
    this.consumeFromReadable(chunk.bytes.byteLength);
  }

  private wakePull(): void {
    const waiter = this.pullWaiter;
    if (!waiter) return;
    this.pullWaiter = null;
    waiter();
  }

  private maybeFinishEnd(): void {
    if (this.dead) return;
    if (this.sendClosed && this.recvClosed) {
      this.settleClosed({ reason: 'end' });
      this.mux.forgetStream(this.id);
    }
  }

  private settleClosed(info: StreamCloseInfo): void {
    if (this.closedSettled) return;
    this.closedSettled = true;
    this.resolveClosed(info);
  }

  private deadError(): LinkError {
    return new LinkError('closed', 'stream is closed');
  }
}

export class LinkMux implements LinkSession {
  readonly role: LinkRole;
  readonly streamWindow: number;
  readonly maxFramePayload: number;
  readonly maxLinkUnacked: number;
  readonly ctl: LinkCtl;
  readonly closed: Promise<LinkCloseInfo>;

  private readonly transport: ByteTransport;
  private readonly decoder: FrameDecoder;
  private readonly streams = new Map<number, MuxStream>();
  private readonly streamListeners: Array<(stream: LinkStream) => void> = [];
  private readonly pendingIncoming: LinkStream[] = [];
  private readonly ctlListeners: Array<(bytes: Uint8Array) => unknown> = [];
  private readonly ctlInbox: Uint8Array[] = [];
  private readonly ctlOutbox: Uint8Array[] = [];
  private nextStreamId: number;
  private remoteMaxStreamId = 0;
  private unacked = 0;
  private closedFlag = false;
  private resolveClosed!: (info: LinkCloseInfo) => void;
  private handling = false;
  private readonly pendingChunks: Uint8Array[] = [];
  private ctlFlushing = false;
  private closeReason = 'closed';

  constructor(transport: ByteTransport, opts: LinkMuxOptions) {
    this.transport = transport;
    this.role = opts.role;
    this.streamWindow = opts.streamWindow ?? INITIAL_STREAM_WINDOW;
    this.maxFramePayload = opts.maxFramePayload ?? MAX_FRAME_PAYLOAD;
    this.maxLinkUnacked = opts.maxLinkUnacked ?? MAX_LINK_UNACKED;
    this.nextStreamId = opts.role === 'initiator' ? 1 : 2;
    this.decoder = new FrameDecoder({ maxPayload: this.maxFramePayload });
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });

    const ctl = new MuxStream(this, CTL_STREAM_ID, new Uint8Array(0));
    this.streams.set(CTL_STREAM_ID, ctl);

    this.ctl = {
      send: (bytes) => {
        this.ctlOutbox.push(copyBytes(bytes));
        void this.flushCtlOutbox();
      },
      onMessage: (cb) => {
        this.ctlListeners.push(cb);
        if (this.ctlInbox.length === 0) return;
        const queued = this.ctlInbox.splice(0);
        for (const msg of queued) cb(msg);
      },
    };

    transport.onData((bytes) => {
      if (this.closedFlag) return;
      this.pendingChunks.push(bytes);
      this.drainIncoming();
    });
    transport.onClose((reason) => {
      this.finishClose(reason ?? 'transport-closed');
    });
  }

  async openStream(openPayload: Uint8Array): Promise<LinkStream> {
    this.assertOpen();
    const id = this.allocStreamId();
    const payload = copyBytes(openPayload);
    const stream = new MuxStream(this, id, payload);
    this.streams.set(id, stream);
    await this.sendFrame({
      streamId: id,
      op: FrameOp.OPEN,
      payload,
    });
    return stream;
  }

  onStream(cb: (stream: LinkStream) => void): void {
    this.streamListeners.push(cb);
    if (this.pendingIncoming.length === 0) return;
    const queued = this.pendingIncoming.splice(0);
    for (const stream of queued) cb(stream);
  }

  close(reason?: string): void {
    if (this.closedFlag) return;
    this.closeReason = reason ?? 'closed';
    try {
      this.transport.close(reason);
    } catch {
      // transport may already be gone
    }
    this.finishClose(this.closeReason);
  }

  sendFrame(frame: {
    streamId: number;
    op: number;
    flags?: number;
    payload?: Uint8Array;
  }): Promise<void> {
    if (this.closedFlag) {
      return Promise.reject(new LinkError('closed', this.closeReason));
    }
    let encoded: Uint8Array;
    try {
      encoded = encodeFrame(frame);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'encode error';
      this.protocolError(message);
      return Promise.reject(err instanceof Error ? err : new LinkError('protocol', message));
    }
    try {
      return Promise.resolve(this.transport.send(encoded)).then(
        () => undefined,
        (err) => {
          const message = err instanceof Error ? err.message : 'send error';
          this.close(message);
          throw err instanceof Error ? err : new LinkError('closed', message);
        }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'send error';
      this.close(message);
      return Promise.reject(err instanceof Error ? err : new LinkError('closed', message));
    }
  }

  addUnacked(n: number): void {
    this.unacked += n;
    if (this.unacked > this.maxLinkUnacked) {
      this.protocolError(`link unacked outbound ${this.unacked} exceeds ${this.maxLinkUnacked}`);
    }
  }

  sendWindowCredit(stream: MuxStream, delta: number): void {
    if (delta <= 0 || this.closedFlag || stream.dead) return;
    stream.recvAdvertised += delta;
    void this.sendFrame({
      streamId: stream.id,
      op: FrameOp.WINDOW,
      payload: encodeWindowPayload(delta),
    }).catch(() => undefined);
  }

  resetStream(stream: MuxStream, reason?: string): void {
    if (stream.dead) return;
    muxTrace('rst send', { stream: stream.id, reason: reason ?? '' });
    const payload = encodeRstReason(reason);
    this.releaseOutstanding(stream);
    void this.sendFrame({
      streamId: stream.id,
      op: FrameOp.RST,
      payload,
    }).catch(() => undefined);
    stream.abort({ reason: 'rst', message: reason });
    this.streams.delete(stream.id);
  }

  resetUnknown(streamId: number): void {
    if (this.closedFlag || streamId === CTL_STREAM_ID) return;
    void this.sendFrame({
      streamId,
      op: FrameOp.RST,
      payload: encodeRstReason('unknown stream'),
    }).catch(() => undefined);
  }

  forgetStream(id: number): void {
    const stream = this.streams.get(id);
    if (stream) this.releaseOutstanding(stream);
    this.streams.delete(id);
  }

  releaseOutstanding(stream: MuxStream): void {
    if (stream.outstanding <= 0) return;
    this.unacked = Math.max(0, this.unacked - stream.outstanding);
    stream.outstanding = 0;
  }

  protocolError(message: string): void {
    muxTrace('protocolError', { reason: message });
    this.close(message);
  }

  deliverCtl(bytes: Uint8Array): Promise<void> | void {
    const copy = copyBytes(bytes);
    if (this.ctlListeners.length === 0) {
      if (this.ctlInbox.length >= MAX_CTL_INBOX) {
        this.protocolError(`ctl inbox ${this.ctlInbox.length + 1} exceeds ${MAX_CTL_INBOX}`);
        return;
      }
      this.ctlInbox.push(copy);
      return;
    }
    const pending: Promise<void>[] = [];
    for (const cb of this.ctlListeners) {
      try {
        const result = cb(copy) as unknown;
        if (
          result &&
          typeof result === 'object' &&
          typeof (result as Promise<void>).then === 'function'
        ) {
          pending.push(result as Promise<void>);
        }
      } catch {
        // listener errors must not break the mux
      }
    }
    if (pending.length === 0) return;
    return Promise.all(pending).then(
      () => undefined,
      () => undefined
    );
  }

  private allocStreamId(): number {
    const id = this.nextStreamId;
    if (id === 0 || id > 0xfffffff0) {
      throw new LinkError('protocol', 'stream id exhausted');
    }
    if (this.streams.has(id)) {
      this.protocolError(`local stream id ${id} already exists`);
      throw new LinkError('protocol', `local stream id ${id} already exists`);
    }
    this.nextStreamId += 2;
    return id;
  }

  private assertOpen(): void {
    if (this.closedFlag) {
      throw new LinkError('closed', this.closeReason);
    }
  }

  private drainIncoming(): void {
    if (this.handling) return;
    this.handling = true;
    try {
      while (this.pendingChunks.length > 0 && !this.closedFlag) {
        const chunk = this.pendingChunks.shift();
        if (!chunk) break;
        try {
          const frames = this.decoder.push(chunk);
          for (const frame of frames) {
            if (this.closedFlag) break;
            this.handleFrame(frame);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'decode error';
          this.protocolError(message);
          break;
        }
      }
    } finally {
      this.handling = false;
    }
  }

  private handleFrame(frame: Frame): void {
    const { streamId, op } = frame;
    if (op === FrameOp.OPEN) {
      this.handleOpen(frame);
      return;
    }
    if (streamId === CTL_STREAM_ID && (op === FrameOp.END || op === FrameOp.RST)) {
      this.protocolError('ctl stream cannot END or RST');
      return;
    }
    const stream = this.streams.get(streamId);
    if (!stream) {
      if (op === FrameOp.DATA || op === FrameOp.END) {
        this.resetUnknown(streamId);
      }
      return;
    }
    switch (op) {
      case FrameOp.DATA:
        stream.onIncomingData(frame.payload, (frame.flags & FLAG_HEAD) !== 0);
        break;
      case FrameOp.END:
        stream.onPeerEnd();
        break;
      case FrameOp.RST:
        this.handleRst(stream, frame.payload);
        break;
      case FrameOp.WINDOW:
        this.handleWindow(stream, frame.payload);
        break;
      default:
        this.protocolError(`invalid frame op ${op}`);
    }
  }

  private handleOpen(frame: Frame): void {
    if (frame.streamId === CTL_STREAM_ID) {
      this.protocolError('OPEN on ctl stream');
      return;
    }
    const remoteOdd = this.role === 'acceptor';
    const isOdd = (frame.streamId & 1) === 1;
    if (isOdd !== remoteOdd) {
      this.protocolError(`OPEN stream ${frame.streamId} has wrong parity for ${this.role}`);
      return;
    }
    if (frame.streamId <= this.remoteMaxStreamId) {
      this.protocolError(`OPEN stream ${frame.streamId} is not strictly increasing`);
      return;
    }
    if (this.streams.has(frame.streamId)) {
      this.protocolError(`OPEN for existing stream ${frame.streamId}`);
      return;
    }
    if (this.streams.size >= MAX_MUX_STREAMS) {
      this.protocolError(`stream count ${this.streams.size} exceeds ${MAX_MUX_STREAMS}`);
      return;
    }
    if (this.streamListeners.length === 0 && this.pendingIncoming.length >= MAX_PENDING_INCOMING) {
      this.protocolError(
        `pending incoming ${this.pendingIncoming.length + 1} exceeds ${MAX_PENDING_INCOMING}`
      );
      return;
    }
    this.remoteMaxStreamId = frame.streamId;
    const stream = new MuxStream(this, frame.streamId, copyBytes(frame.payload));
    this.streams.set(frame.streamId, stream);
    if (this.streamListeners.length === 0) {
      this.pendingIncoming.push(stream);
      return;
    }
    for (const cb of this.streamListeners) {
      try {
        cb(stream);
      } catch {
        // listener errors must not break the mux
      }
    }
  }

  private handleRst(stream: MuxStream, payload: Uint8Array): void {
    if (stream.id === CTL_STREAM_ID) {
      this.protocolError('RST on ctl stream');
      return;
    }
    const message = rstReason(payload);
    muxTrace('rst recv', { stream: stream.id, reason: message ?? '' });
    this.releaseOutstanding(stream);
    stream.abort({ reason: 'rst', message });
    this.streams.delete(stream.id);
  }

  private handleWindow(stream: MuxStream, payload: Uint8Array): void {
    let delta: number;
    try {
      delta = decodeWindowPayload(payload);
    } catch (err) {
      this.protocolError(err instanceof Error ? err.message : 'invalid WINDOW');
      return;
    }
    if (delta <= 0) return;
    if (delta > stream.outstanding) delta = stream.outstanding;
    const room = this.streamWindow - stream.sendWindow;
    if (delta > room) delta = room;
    if (delta <= 0) return;
    stream.outstanding -= delta;
    this.unacked -= delta;
    stream.creditSendWindow(delta);
  }

  private async flushCtlOutbox(): Promise<void> {
    if (this.ctlFlushing) return;
    this.ctlFlushing = true;
    const ctl = this.streams.get(CTL_STREAM_ID);
    try {
      while (this.ctlOutbox.length > 0 && ctl && !this.closedFlag) {
        const msg = this.ctlOutbox.shift();
        if (!msg) break;
        await ctl.write(msg);
      }
    } catch {
      // write rejects on close/RST; ctl cannot RST, so this is link close
    } finally {
      this.ctlFlushing = false;
    }
  }

  private finishClose(reason: string): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.closeReason = reason;
    for (const stream of this.streams.values()) {
      this.releaseOutstanding(stream);
      stream.abort({ reason: 'link-closed', message: reason });
    }
    this.streams.clear();
    this.pendingIncoming.length = 0;
    this.ctlInbox.length = 0;
    this.ctlOutbox.length = 0;
    this.pendingChunks.length = 0;
    this.resolveClosed({ reason });
  }
}
