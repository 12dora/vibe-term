import { LinkMux, type LinkMuxOptions } from './mux';
import {
  type ByteTransport,
  type LinkCloseInfo,
  type LinkCtl,
  LinkError,
  type LinkSession,
  type LinkStream,
} from './types';

export interface ServerSocketAdapter {
  send(bytes: Uint8Array): number;
  close(code?: number, reason?: string): void;
  onMessage(cb: (bytes: Uint8Array) => void): void;
  onClose(cb: (reason?: string) => void): void;
  onDrain(cb: () => void): void;
  /** 底层 socket 当前已缓冲未发出的字节数（Bun `getBufferedAmount()`）；缺省时只能靠 drain 事件恢复。 */
  bufferedAmount?(): number;
}

export type WebSocketTransportInput = WebSocket | ServerSocketAdapter;

const WS_OPEN = 1;
const CLIENT_HIGH_WATER = 4 * 1024 * 1024;
const CLIENT_LOW_WATER = 1 * 1024 * 1024;
const CLIENT_POLL_MS = 16;
/** Matches gateway `Bun.serve` `websocket.backpressureLimit` (`closeOnBackpressureLimit: true`). */
export const SERVER_WS_BACKPRESSURE_LIMIT = 1024 * 1024;

function isServerSocketAdapter(value: WebSocketTransportInput): value is ServerSocketAdapter {
  return (
    typeof (value as ServerSocketAdapter).onDrain === 'function' &&
    typeof (value as ServerSocketAdapter).onMessage === 'function'
  );
}

function toUint8Array(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

type QueueItem = {
  bytes: Uint8Array;
  resolve: () => void;
  reject: (err: Error) => void;
};

type QueuedTransportHooks = {
  kind: 'client' | 'server';
  send: (bytes: Uint8Array) => number | undefined;
  bufferedAmount?: () => number;
  onDrain?: (cb: () => void) => void;
  close: (code?: number, reason?: string) => void;
  onMessage: (cb: (bytes: Uint8Array) => void) => void;
  onClose: (cb: (reason?: string) => void) => void;
  isOpen: () => boolean;
  onOpen?: (cb: () => void) => void;
};

function createQueuedTransport(hooks: QueuedTransportHooks): ByteTransport {
  const queue: QueueItem[] = [];
  const dataCbs: Array<(bytes: Uint8Array) => void> = [];
  const closeCbs: Array<(reason?: string) => void> = [];
  let pumping = false;
  let paused = false;
  let closed = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let opened = hooks.isOpen();
  let serverQueued = 0;

  const rejectQueue = (err: Error) => {
    for (const item of queue) item.reject(err);
    queue.length = 0;
  };

  const finishClose = (reason: string) => {
    if (closed) return;
    closed = true;
    paused = false;
    serverQueued = 0;
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    rejectQueue(new LinkError('closed', reason));
    for (const cb of closeCbs) {
      try {
        cb(reason);
      } catch {
        // listener errors must not break the transport
      }
    }
  };

  const fail = (reason: string) => {
    if (closed) return;
    finishClose(reason);
    try {
      hooks.close(1000, reason);
    } catch {
      // already closed
    }
  };

  const scheduleClientPoll = () => {
    if (pollTimer !== null || closed) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      if (closed) return;
      const buffered = hooks.bufferedAmount?.() ?? 0;
      if (buffered < CLIENT_LOW_WATER) {
        paused = false;
        void pump();
      } else {
        scheduleClientPoll();
      }
    }, CLIENT_POLL_MS);
  };

  // 服务端主动暂停（还没让 Bun 见到背压）时不会有 drain 事件，必须自己轮询恢复：
  // 有 bufferedAmount 就看真实缓冲，没有就按上一轮已排队量清零后重试（send 返回值仍是兜底）。
  const scheduleServerPoll = () => {
    if (pollTimer !== null || closed) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      if (closed || !paused) return;
      const buffered = hooks.bufferedAmount?.();
      if (buffered === undefined) {
        serverQueued = 0;
        paused = false;
        pump();
        return;
      }
      if (buffered < SERVER_WS_BACKPRESSURE_LIMIT / 2) {
        serverQueued = buffered;
        paused = false;
        pump();
      } else {
        scheduleServerPoll();
      }
    }, CLIENT_POLL_MS);
  };

  const serverBuffered = () => hooks.bufferedAmount?.() ?? serverQueued;

  const pump = () => {
    if (pumping || closed) return;
    pumping = true;
    try {
      while (queue.length > 0 && !closed && opened && !paused) {
        const item = queue[0];
        if (!item) break;
        if (hooks.kind === 'server') {
          const buffered = serverBuffered();
          if (buffered > 0 && buffered + item.bytes.byteLength > SERVER_WS_BACKPRESSURE_LIMIT) {
            paused = true;
            scheduleServerPoll();
            break;
          }
        }
        let result: number | undefined;
        try {
          result = hooks.send(item.bytes);
        } catch (err) {
          queue.shift();
          const message = err instanceof Error ? err.message : 'ws send failed';
          item.reject(err instanceof Error ? err : new LinkError('closed', message));
          fail(message);
          return;
        }
        if (hooks.kind === 'server') {
          if (result === 0) {
            queue.shift();
            item.reject(new LinkError('closed', 'websocket send discarded'));
            fail('websocket send discarded');
            return;
          }
          serverQueued += item.bytes.byteLength;
          if (result === -1) {
            // Bun 已见到背压，drain 必然到来，不需要轮询抢先恢复。
            paused = true;
          } else if (serverBuffered() >= SERVER_WS_BACKPRESSURE_LIMIT) {
            paused = true;
            scheduleServerPoll();
          }
        } else if ((hooks.bufferedAmount?.() ?? 0) > CLIENT_HIGH_WATER) {
          paused = true;
          scheduleClientPoll();
        }
        queue.shift();
        item.resolve();
      }
    } finally {
      pumping = false;
    }
  };

  hooks.onMessage((bytes) => {
    if (closed) return;
    for (const cb of dataCbs) cb(bytes);
  });
  hooks.onClose((reason) => {
    finishClose(reason ?? 'ws-closed');
  });
  hooks.onDrain?.(() => {
    if (closed) return;
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    serverQueued = 0;
    paused = false;
    pump();
  });
  hooks.onOpen?.(() => {
    opened = true;
    pump();
  });

  return {
    send(bytes: Uint8Array): Promise<void> {
      if (closed) return Promise.reject(new LinkError('closed', 'websocket is closed'));
      return new Promise<void>((resolve, reject) => {
        queue.push({ bytes: bytes.slice(), resolve, reject });
        pump();
      });
    },
    onData(cb) {
      dataCbs.push(cb);
    },
    onClose(cb) {
      closeCbs.push(cb);
    },
    close(reason?: string) {
      fail(reason ?? 'closed');
    },
  };
}

export function createClientWebSocketTransport(ws: WebSocket): ByteTransport {
  if (ws.binaryType !== undefined) {
    ws.binaryType = 'arraybuffer';
  }
  return createQueuedTransport({
    kind: 'client',
    send: (bytes) => {
      ws.send(bytes);
      return undefined;
    },
    bufferedAmount: () => ws.bufferedAmount,
    close: (code, reason) => {
      ws.close(code, reason);
    },
    onMessage: (cb) => {
      ws.addEventListener('message', (ev) => {
        const bytes = toUint8Array((ev as MessageEvent).data);
        if (bytes) cb(bytes);
      });
    },
    onClose: (cb) => {
      ws.addEventListener('close', (ev) => {
        cb((ev as CloseEvent).reason || 'ws-closed');
      });
    },
    isOpen: () => ws.readyState === WS_OPEN,
    onOpen: (cb) => {
      if (ws.readyState === WS_OPEN) return;
      ws.addEventListener('open', () => cb());
    },
  });
}

export function createServerSocketTransport(adapter: ServerSocketAdapter): ByteTransport {
  return createQueuedTransport({
    kind: 'server',
    send: (bytes) => adapter.send(bytes),
    close: (code, reason) => adapter.close(code, reason),
    onMessage: (cb) => adapter.onMessage(cb),
    onClose: (cb) => adapter.onClose(cb),
    onDrain: (cb) => adapter.onDrain(cb),
    ...(adapter.bufferedAmount ? { bufferedAmount: () => adapter.bufferedAmount?.() ?? 0 } : {}),
    isOpen: () => true,
  });
}

export function websocketTransport(socket: WebSocketTransportInput): ByteTransport {
  return isServerSocketAdapter(socket)
    ? createServerSocketTransport(socket)
    : createClientWebSocketTransport(socket);
}

export type WebSocketLinkOptions = {
  role: LinkMuxOptions['role'];
  streamWindow?: number;
  maxFramePayload?: number;
  maxLinkUnacked?: number;
  logContext?: LinkMuxOptions['logContext'];
};

export class WebSocketLink implements LinkSession {
  private readonly mux: LinkMux;

  constructor(socket: WebSocketTransportInput, opts: WebSocketLinkOptions) {
    this.mux = new LinkMux(websocketTransport(socket), opts);
  }

  get ctl(): LinkCtl {
    return this.mux.ctl;
  }

  get closed(): Promise<LinkCloseInfo> {
    return this.mux.closed;
  }

  openStream(openPayload: Uint8Array): Promise<LinkStream> {
    return this.mux.openStream(openPayload);
  }

  onStream(cb: (stream: LinkStream) => void): void {
    this.mux.onStream(cb);
  }

  close(reason?: string): void {
    this.mux.close(reason);
  }
}
