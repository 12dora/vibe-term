// exec 通道的 WebSocket 传输：把 npm `ws` 收敛成最小的二进制消息接口，便于测试注入假服务端。
// 握手阶段的 HTTP 失败（401/403/404）合成为同名的 4xxx 关闭码，上层只处理「关闭码」一种形态。

import type { IncomingMessage } from 'node:http';
import { resolveNodeUrl } from '@vibeterm/api-client/node-url';
import WebSocket from 'ws';
import type { CliContext } from './context';
import { type TlsConnectOptions, wsTlsOptions } from './tls';

export const EXEC_CLOSE_UNAUTHORIZED = 4401;
export const EXEC_CLOSE_FORBIDDEN = 4403;
export const EXEC_CLOSE_UNSUPPORTED = 4404;
export const EXEC_CLOSE_TAKEN_OVER = 4409;
export const EXEC_CLOSE_PROTOCOL = 4400;
type RawData = WebSocket.RawData;
const ABNORMAL_CLOSE = 1006;
const BODY_LIMIT_CHARS = 4096;

export interface ExecSocketLike {
  onopen: (() => void) | null;
  onmessage: ((data: Uint8Array) => void) | null;
  onclose: ((code: number, reason: string) => void) | null;
  /** socket 未打开或已断开时可能抛出，调用方按链路丢失处理。 */
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export interface ExecSocketTarget {
  url: string;
  headers: Record<string, string>;
  tls: TlsConnectOptions;
  handshakeTimeoutMs: number;
}

export type ExecSocketConnect = (target: ExecSocketTarget) => ExecSocketLike;

/** entry 的 http(s) 基址 → 该 node 的 exec 通道 ws(s) 端点。 */
export function execWsUrl(entry: string, nodeId: string): string {
  const url = new URL(`${entry}${resolveNodeUrl(nodeId, '/api/exec/ws')}`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/** 握手头每次建连重算：会话 / token cookie 可能在重连之间被续期。 */
export function execSocketTarget(ctx: CliContext, nodeId: string): ExecSocketTarget {
  const headers: Record<string, string> = { origin: ctx.http.origin };
  const cookie = ctx.http.cookieHeader(nodeId);
  if (cookie) headers.cookie = cookie;
  return {
    url: execWsUrl(ctx.http.entry, nodeId),
    headers,
    tls: wsTlsOptions(ctx.http.tls),
    handshakeTimeoutMs: ctx.globals.timeoutMs,
  };
}

function statusToCloseCode(status: number): number {
  if (status === 401) return EXEC_CLOSE_UNAUTHORIZED;
  if (status === 403) return EXEC_CLOSE_FORBIDDEN;
  if (status === 404) return EXEC_CLOSE_UNSUPPORTED;
  return ABNORMAL_CLOSE;
}

function readBody(res: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (piece: string) => {
      if (body.length < BODY_LIMIT_CHARS) body += piece;
    });
    res.once('end', () => resolve(body));
    res.once('error', () => resolve(body));
    res.once('close', () => resolve(body));
  });
}

function toBytes(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) return toBytes(Buffer.concat(data));
  return new Uint8Array(data);
}

export const connectWsExecSocket: ExecSocketConnect = (target) => {
  const ws = new WebSocket(target.url, {
    headers: target.headers,
    handshakeTimeout: target.handshakeTimeoutMs,
    ...target.tls,
  });
  ws.binaryType = 'nodebuffer';
  let closed = false;
  const adapter: ExecSocketLike = {
    onopen: null,
    onmessage: null,
    onclose: null,
    send(data) {
      ws.send(data, { binary: true }, (error) => {
        if (error) ws.terminate();
      });
    },
    close: (code, reason) => ws.close(code, reason),
    terminate: () => ws.terminate(),
  };
  const fireClose = (code: number, reason: string): void => {
    if (closed) return;
    closed = true;
    adapter.onclose?.(code, reason);
  };

  ws.on('open', () => adapter.onopen?.());
  ws.on('message', (data, isBinary) => {
    if (isBinary) adapter.onmessage?.(toBytes(data));
  });
  ws.on('unexpected-response', (req, res) => {
    const status = res.statusCode ?? 0;
    void readBody(res).then((body) => {
      req.destroy();
      fireClose(statusToCloseCode(status), body || `HTTP ${status}`);
    });
  });
  ws.on('error', () => {
    // 细节在随后的 close 里体现；这里只防未处理的 error 事件。
  });
  ws.on('close', (code, reason) => fireClose(code, reason.toString('utf8')));
  return adapter;
};
