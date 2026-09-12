import { wsBorsh } from '@vibeterm/shared';
import { type ForwardPump as FailoverPump, runStreamFailover } from './forwarder-failover';
import {
  FORWARD_WS_LINK_FAILURE_CODE,
  PendingForwardOpen,
  discardPendingStream,
  pendingMeta,
} from './forwarder-ws-upgrade';
import {
  type MeshServerWebSocket,
  type OpenedWsStream,
  type PeerLinkProvider,
  type PeerTransportKind,
  STREAM_QUEUE_MAX_BYTES,
  STREAM_QUEUE_MAX_FRAMES,
  STREAM_QUEUE_OVERFLOW_REASON,
  type StreamOpener,
} from './mesh-deps';
import { isTerminalStreamClose } from './stream-close-code';
import { StreamReplayState, rejectStaleNodeStream } from './stream-replay-state';

type ForwardPump = FailoverPump & {
  ws: MeshServerWebSocket;
  generation: number;
  browserPaused: boolean;
  inboundHold: Uint8Array[];
  inboundHoldBytes: number;
};

export class ForwardWsPumps {
  private readonly pumps = new Map<MeshServerWebSocket, ForwardPump>();
  constructor(
    private readonly deps: {
      peers: PeerLinkProvider;
      streams: StreamOpener;
      sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
      log: (line: string) => void;
    }
  ) {}
  get log(): (line: string) => void {
    return this.deps.log;
  }
  private get sleep() {
    return this.deps.sleep;
  }

  handleForwardSocketMessage(ws: MeshServerWebSocket, message: unknown): void {
    const pump = this.pumps.get(ws);
    if (!pump || pump.browserClosed) return;
    const bytes = toBytes(message);
    if (!bytes) return;
    pump.replay.noteOutbound(bytes);
    if (pump.failingOver || !pump.stream) {
      if (!enqueueFrame(pump, bytes)) this.failPump(pump, STREAM_QUEUE_OVERFLOW_REASON);
      return;
    }
    this.sendToStream(pump, pump.stream, bytes);
  }

  handleForwardSocketDrain(ws: MeshServerWebSocket): void {
    const pump = this.pumps.get(ws);
    if (!pump || pump.browserClosed) return;
    pump.browserPaused = false;
    this.flushInbound(pump);
  }

  handleForwardSocketClose(ws: MeshServerWebSocket, code?: number, reason?: string): void {
    const pump = this.pumps.get(ws);
    this.pumps.delete(ws);
    if (!pump) {
      discardPendingStream(ws.data?.token);
      return;
    }
    pump.browserClosed = true;
    this.closePump(pump, { code, reason });
  }

  attachForwardPump(ws: MeshServerWebSocket, stream: OpenedWsStream | PendingForwardOpen): void {
    const meta = pendingMeta.get(stream);
    const pump: ForwardPump = {
      id: crypto.randomUUID().slice(0, 8),
      ws,
      nodeId: meta?.nodeId ?? ws.data.nodeId ?? '',
      auth: meta?.auth ?? ws.data.auth ?? '',
      cid: meta?.cid ?? ws.data.cid,
      ...(meta?.share ? { share: meta.share } : {}),
      stream: null,
      boundTransport: meta?.transport ?? null,
      replay: new StreamReplayState(),
      generation: 0,
      browserClosed: false,
      failingOver: false,
      failoverAbort: null,
      queue: [],
      queuedAt: [],
      helloWait: null,
      resumeWait: null,
      streamAlive: true,
      inflight: null,
      queueBytes: 0,
      browserPaused: false,
      inboundHold: [],
      inboundHoldBytes: 0,
    };
    this.pumps.set(ws, pump);
    if (stream instanceof PendingForwardOpen) {
      pump.failoverAbort = stream.abort;
      stream.attach(
        (opened) => {
          if (pump.browserClosed) return opened.close();
          pump.failoverAbort = null;
          this.bindStream(pump, opened, meta?.transport ?? null);
          const queued = pump.queue.splice(0);
          pump.queuedAt.length = 0;
          pump.queueBytes = 0;
          for (const bytes of queued) this.sendToStream(pump, opened, bytes);
        },
        (reason) => this.closePump(pump, { code: FORWARD_WS_LINK_FAILURE_CODE, reason })
      );
    } else {
      this.bindStream(pump, stream, meta?.transport ?? null);
    }
  }

  private bindStream(
    pump: ForwardPump,
    stream: OpenedWsStream,
    transport: PeerTransportKind | null
  ): void {
    pump.generation += 1;
    const generation = pump.generation;
    pump.stream = stream;
    pump.boundTransport = transport;
    pump.streamAlive = true;
    stream.onMessage((bytes) => {
      if (generation !== pump.generation || pump.browserClosed) return;
      this.handleRemoteBytes(pump, bytes);
    });
    stream.onClose((info) => {
      if (generation !== pump.generation || pump.browserClosed) return;
      pump.streamAlive = false;
      pump.helloWait?.();
      pump.helloWait = null;
      // 节点端主动终止（会话失效 / 分享结束）：重连也不会成功，直接把关闭码透到浏览器。
      if (isTerminalStreamClose(info)) {
        this.closePump(pump, info);
        return;
      }
      if (pump.failingOver) return;
      void this.failover(pump, info ?? {});
    });
  }

  private handleRemoteBytes(pump: ForwardPump, bytes: Uint8Array): void {
    const noted = pump.replay.noteInbound(bytes);
    if (pump.resumeWait && pump.replay.isResumeReady()) {
      pump.resumeWait();
      pump.resumeWait = null;
    }
    if (noted.kind === wsBorsh.KIND_HELLO_S2C) {
      pump.helloWait?.();
      pump.helloWait = null;
      if (rejectStaleNodeStream(noted.peerUnsupported, pump, this)) return;
      if (pump.replay.helloForwarded) return;
      pump.replay.helloForwarded = true;
    }
    if (noted.kind === wsBorsh.KIND_DEVICE_CONNECTED && noted.deviceId) {
      if (pump.replay.connectedForwarded.has(noted.deviceId)) return;
      pump.replay.connectedForwarded.add(noted.deviceId);
    }
    this.sendToBrowser(pump, bytes);
  }

  sendToBrowser(pump: ForwardPump, bytes: Uint8Array): void {
    if (pump.browserClosed) return;
    if (pump.browserPaused) {
      if (!holdInbound(pump, bytes)) this.failPump(pump, STREAM_QUEUE_OVERFLOW_REASON);
      return;
    }
    let result: number | undefined;
    try {
      result = pump.ws.send(bytes);
    } catch {
      pump.stream?.close();
      return;
    }
    if (result === 0) {
      this.closeBrowser(pump, { code: 1011, reason: 'forward-ws-closed' });
      return;
    }
    if (result === -1) {
      pump.browserPaused = true;
    }
  }

  private flushInbound(pump: ForwardPump): void {
    while (!pump.browserPaused && !pump.browserClosed && pump.inboundHold.length > 0) {
      const next = pump.inboundHold.shift();
      if (!next) break;
      pump.inboundHoldBytes = Math.max(0, pump.inboundHoldBytes - next.byteLength);
      this.sendToBrowser(pump, next);
    }
  }

  private async failover(
    pump: ForwardPump,
    info: { code?: number; reason?: string }
  ): Promise<void> {
    await runStreamFailover(
      {
        sleep: this.sleep,
        log: this.log,
        peers: this.deps.peers,
        streams: this.deps.streams,
        bindStream: (p, stream, transport) => this.bindStream(p as ForwardPump, stream, transport),
        discardStream: (p, stream) => this.discardStream(p as ForwardPump, stream),
        closePump: (p, closeInfo) => this.closePump(p as ForwardPump, closeInfo),
        sendToStream: (p, stream, bytes) => this.sendToStream(p as ForwardPump, stream, bytes),
        sendToBrowser: (p, bytes) => this.sendToBrowser(p as ForwardPump, bytes),
        flushQueue: (p) => this.flushQueue(p as ForwardPump),
      },
      pump,
      info
    );
  }

  private flushQueue(pump: ForwardPump): void {
    const queued = pump.queue.splice(0);
    pump.queuedAt.length = 0;
    pump.queueBytes = 0;
    const stream = pump.stream;
    if (!stream) return;
    for (const bytes of queued) {
      const out = pump.replay.rewriteQueuedFrame(bytes);
      if (out) this.sendToStream(pump, stream, out);
    }
  }

  private sendToStream(pump: ForwardPump, stream: OpenedWsStream, bytes: Uint8Array): void {
    let pending: Promise<void>;
    try {
      pending = Promise.resolve(stream.send(bytes));
    } catch {
      this.onSendFailed(pump, stream);
      return;
    }
    void pending.then(undefined, () => this.onSendFailed(pump, stream));
  }

  private onSendFailed(pump: ForwardPump, stream: OpenedWsStream): void {
    if (pump.browserClosed || pump.stream !== stream) return;
    pump.streamAlive = false;
    try {
      stream.close(1011, 'send-failed');
    } catch {}
    if (pump.failingOver) return;
    void this.failover(pump, { code: 1011, reason: 'send-failed' });
  }

  private failPump(pump: ForwardPump, reason: string): void {
    this.closePump(pump, { code: 1011, reason });
  }

  /** 整条转发流拆解：先断上游（当前流 + 在途流），再断浏览器，避免留下无主的 mesh 流。 */
  closePump(pump: ForwardPump, info: { code?: number; reason?: string }): void {
    pump.failoverAbort?.abort();
    pump.helloWait?.();
    pump.helloWait = null;
    pump.resumeWait?.();
    pump.resumeWait = null;
    const inflight = pump.inflight;
    pump.inflight = null;
    inflight?.close(info.code, info.reason);
    pump.stream?.close(info.code, info.reason);
    pump.stream = null;
    pump.streamAlive = false;
    this.closeBrowser(pump, info);
  }

  private discardStream(pump: ForwardPump, stream: OpenedWsStream): void {
    if (pump.inflight === stream) pump.inflight = null;
    if (pump.stream === stream) {
      pump.stream = null;
      pump.streamAlive = false;
    }
    try {
      stream.close();
    } catch {}
  }

  closeBrowser(pump: ForwardPump, info: { code?: number; reason?: string }): void {
    if (pump.browserClosed) return;
    pump.browserClosed = true;
    this.pumps.delete(pump.ws);
    try {
      pump.ws.close(info.code, info.reason);
    } catch {}
  }
}

function holdInbound(pump: ForwardPump, bytes: Uint8Array): boolean {
  if (
    pump.inboundHold.length >= STREAM_QUEUE_MAX_FRAMES ||
    pump.inboundHoldBytes + bytes.byteLength > STREAM_QUEUE_MAX_BYTES
  ) {
    return false;
  }
  pump.inboundHold.push(bytes.slice());
  pump.inboundHoldBytes += bytes.byteLength;
  return true;
}

function enqueueFrame(pump: ForwardPump, bytes: Uint8Array): boolean {
  if (
    pump.queue.length >= STREAM_QUEUE_MAX_FRAMES ||
    pump.queueBytes + bytes.byteLength > STREAM_QUEUE_MAX_BYTES
  ) {
    return false;
  }
  pump.queue.push(bytes.slice());
  pump.queuedAt.push(Date.now());
  pump.queueBytes += bytes.byteLength;
  return true;
}

function toBytes(message: unknown): Uint8Array | null {
  if (message instanceof Uint8Array) return message;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  if (ArrayBuffer.isView(message)) {
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  }
  return null;
}
