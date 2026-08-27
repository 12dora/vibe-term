import { LinkMux, type LinkMuxOptions } from './mux';
import type { ByteTransport, LinkCloseInfo, LinkCtl, LinkSession, LinkStream } from './types';

/**
 * Minimal WebSocket surface used by WebSocketLink.
 * Browser/Bun `WebSocket` matches this. Gateway wraps Bun `ServerWebSocket` as:
 * `{ send(bytes); close(); onmessage; onclose }` without this package importing Bun types.
 */
export interface WebSocketLike {
  send(data: Uint8Array): number | undefined;
  close(code?: number, reason?: string): void;
  binaryType?: string;
  readyState?: number;
  onopen?: ((ev?: unknown) => void) | null;
  onmessage?: ((ev: { data: unknown }) => void) | null;
  onclose?: ((ev?: { code?: number; reason?: string }) => void) | null;
  addEventListener?: (type: string, listener: (ev: unknown) => void) => void;
}

const WS_OPEN = 1;

function toUint8Array(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

export function websocketTransport(ws: WebSocketLike): ByteTransport {
  if (ws.binaryType !== undefined) {
    ws.binaryType = 'arraybuffer';
  }

  const dataCbs: Array<(bytes: Uint8Array) => void> = [];
  const closeCbs: Array<(reason?: string) => void> = [];
  const pending: Uint8Array[] = [];
  let opened = ws.readyState === undefined || ws.readyState === WS_OPEN;
  let closed = ws.readyState === 2 || ws.readyState === 3;

  const flushPending = () => {
    if (!opened || closed) return;
    for (const chunk of pending) {
      ws.send(chunk);
    }
    pending.length = 0;
  };

  const handleMessage = (data: unknown) => {
    const bytes = toUint8Array(data);
    if (!bytes) return;
    for (const cb of dataCbs) cb(bytes);
  };

  const handleClose = (reason?: string) => {
    if (closed) return;
    closed = true;
    pending.length = 0;
    for (const cb of closeCbs) cb(reason);
  };

  if (typeof ws.addEventListener === 'function') {
    ws.addEventListener('open', () => {
      opened = true;
      flushPending();
    });
    ws.addEventListener('message', (ev) => {
      handleMessage((ev as { data?: unknown }).data);
    });
    ws.addEventListener('close', (ev) => {
      const closeEv = ev as { reason?: string };
      handleClose(closeEv.reason || 'ws-closed');
    });
  } else {
    const prevOpen = ws.onopen;
    const prevMessage = ws.onmessage;
    const prevClose = ws.onclose;
    ws.onopen = (ev) => {
      opened = true;
      flushPending();
      prevOpen?.(ev);
    };
    ws.onmessage = (ev) => {
      prevMessage?.(ev);
      handleMessage(ev.data);
    };
    ws.onclose = (ev) => {
      prevClose?.(ev);
      handleClose(ev?.reason || 'ws-closed');
    };
  }

  return {
    send(bytes: Uint8Array): void | Promise<void> {
      if (closed) return;
      if (!opened) {
        pending.push(bytes.slice());
        return;
      }
      const result = ws.send(bytes);
      if (typeof result === 'number' && result === 0) {
        return;
      }
    },
    onData(cb) {
      dataCbs.push(cb);
    },
    onClose(cb) {
      closeCbs.push(cb);
    },
    close(reason?: string) {
      if (closed) return;
      closed = true;
      pending.length = 0;
      try {
        ws.close(1000, reason);
      } catch {
        try {
          ws.close();
        } catch {
          // already closed
        }
      }
    },
  };
}

export type WebSocketLinkOptions = {
  role: LinkMuxOptions['role'];
  streamWindow?: number;
  maxFramePayload?: number;
  maxLinkUnacked?: number;
};

export class WebSocketLink implements LinkSession {
  private readonly mux: LinkMux;

  constructor(ws: WebSocketLike, opts: WebSocketLinkOptions) {
    this.mux = new LinkMux(websocketTransport(ws), opts);
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
