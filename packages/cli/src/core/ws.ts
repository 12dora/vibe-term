// Gateway WebSocket：把 npm `ws` 适配成 `@vibeterm/ws-client` 的 `WebSocketLike`。
//
// 浏览器建 WS 时设不了请求头，所以会话只能靠 cookie 自动带上；CLI 反过来——`ws` 允许显式
// 设 `Cookie`，于是这里按 node 取对应的会话 cookie 塞进握手头，其余握手规则（每条连接一个
// 新的 `?cid=` nonce）与浏览器完全一致。

import { generateClientNonce, resolveNodeUrl } from '@vibeterm/api-client/node-url';
import {
  type GatewayConnection,
  type SocketFactory,
  type WebSocketLike,
  createGatewayConnection,
} from '@vibeterm/ws-client';
import WebSocket from 'ws';
import { cliVersion } from '../version';
import { AuthError, NetworkError } from './errors';
import type { HttpClient } from './http';

/** entry 的 http(s) 基址 → 该 node 的 ws(s) 端点（带一次性 cid）。 */
export function nodeGatewayWsUrl(entry: string, nodeId: string, cid: string): string {
  const url = new URL(`${entry}${resolveNodeUrl(nodeId, '/ws')}`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('cid', cid);
  return url.toString();
}

export interface WsSocketOptions {
  headers: Record<string, string>;
  handshakeTimeoutMs: number;
}

function toMessageData(data: unknown, isBinary: boolean): ArrayBuffer | string {
  if (!isBinary) return typeof data === 'string' ? data : String(data);
  if (data instanceof ArrayBuffer) return data;
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).buffer as ArrayBuffer;
  const view = data as ArrayBufferView;
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

/** 一个 `ws` 连接的 WebSocketLike 外壳；`binaryType` 固定 arraybuffer，与浏览器一致。 */
export function createWsSocket(url: string, options: WsSocketOptions): WebSocketLike {
  const socket = new WebSocket(url, {
    headers: options.headers,
    handshakeTimeout: options.handshakeTimeoutMs,
  });
  socket.binaryType = 'arraybuffer';

  const adapter: WebSocketLike = {
    get readyState() {
      return socket.readyState;
    },
    binaryType: 'arraybuffer',
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data) {
      socket.send(data as ArrayBufferView | ArrayBufferLike | string);
    },
    close(code, reason) {
      socket.close(code, reason);
    },
  };

  socket.on('open', () => adapter.onopen?.());
  socket.on('message', (data, isBinary) => {
    adapter.onmessage?.({ data: toMessageData(data, isBinary) });
  });
  socket.on('close', (code, reason) => {
    adapter.onclose?.({ code, reason: reason.toString('utf8') });
  });
  socket.on('error', (error) => adapter.onerror?.(error));
  return adapter;
}

export function createWsSocketFactory(options: WsSocketOptions): SocketFactory {
  return (url) => createWsSocket(url, options);
}

export interface GatewaySocket {
  connection: GatewayConnection;
  nodeId: string;
  /** 当前 socket 携带的 client nonce；`GET /api/mesh/connection?cid=` 用它换服务端连接 id。 */
  cid(): string | null;
  close(): void;
}

export interface OpenGatewaySocketOptions {
  /** HELLO 协商的等待上限；缺省跟随 `--timeout`。 */
  timeoutMs?: number;
  clientVersion?: string;
}

/** 网关在会话失效时用 4401 关闭 WS（见 ws-client 契约）。 */
export const WS_SESSION_INVALID_CODE = 4401;

/**
 * 建一条到目标 node 的 Gateway WS，等 HELLO 协商完成后返回。
 * 这里只负责连上；pane 订阅之类由各命令组自己做。
 */
export async function openGatewaySocket(
  http: HttpClient,
  nodeId: string,
  options: OpenGatewaySocketOptions = {}
): Promise<GatewaySocket> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  let currentCid: string | null = null;
  const socketFactory = createWsSocketFactory({
    headers: buildHandshakeHeaders(http, nodeId),
    handshakeTimeoutMs: timeoutMs,
  });

  let closeCode: number | null = null;
  const connection = createGatewayConnection({
    socketFactory,
    wsUrlFactory: () => {
      currentCid = generateClientNonce();
      return nodeGatewayWsUrl(http.entry, nodeId, currentCid);
    },
    onClose: (code) => {
      closeCode = code;
    },
    clientOptions: {
      clientImpl: 'vibeterm-cli',
      // 网关的 canonical v1.1 版本门是 fail-closed 的：版本必须报真的，否则直接 1002。
      clientVersion: options.clientVersion ?? cliVersion(),
      // 首连失败必须立刻交回调用方；重连由各命令自己决定要不要开。
      maxReconnectAttempts: 0,
    },
  });

  const socket: GatewaySocket = {
    connection,
    nodeId,
    cid: () => currentCid,
    close: () => connection.dispose(),
  };

  await new Promise<void>((resolve, reject) => {
    const cleanups: Array<() => void> = [];
    let done = false;
    const settle = (error?: Error) => {
      if (done) return;
      done = true;
      for (const cleanup of cleanups.splice(0)) cleanup();
      if (error) {
        connection.dispose();
        reject(error);
        return;
      }
      resolve();
    };
    const timer = setTimeout(
      () => settle(new NetworkError(`gateway websocket to node ${nodeId} timed out`)),
      timeoutMs
    );
    cleanups.push(() => clearTimeout(timer));
    cleanups.push(
      connection.client.onStateChange((state) => {
        if (state === 'READY') settle();
        else if (state === 'CLOSED') settle(closeError(nodeId, closeCode));
      })
    );
    cleanups.push(
      connection.client.onError((error) => {
        if (connection.client.getState() !== 'READY') settle(closeError(nodeId, closeCode, error));
      })
    );
    connection.client.connect();
  });

  return socket;
}

function buildHandshakeHeaders(http: HttpClient, nodeId: string): Record<string, string> {
  const headers: Record<string, string> = { origin: http.origin };
  const cookie = http.cookieHeader(nodeId);
  if (cookie) headers.cookie = cookie;
  return headers;
}

function closeError(nodeId: string, code: number | null, cause?: Error): Error {
  if (code === WS_SESSION_INVALID_CODE) {
    return new AuthError(
      `gateway websocket to node ${nodeId} was rejected (session invalid)`,
      `run: vibeterm login${nodeId === 'self' ? '' : ` --node ${nodeId}`}`
    );
  }
  const detail = cause ? `: ${cause.message}` : code === null ? '' : ` (close ${code})`;
  return new NetworkError(`gateway websocket to node ${nodeId} closed${detail}`);
}
