// 远程访问（Cloudflare Tunnel）客户端。与 TLS/LocalApi 一样只问浏览器直连的那台机器，
// 路径经 `resolveNodeUrl(SELF_NODE_ID, ...)` 走 entry 自身，不加 `/n/<id>` 前缀。

import type {
  TunnelActionRequest,
  TunnelActionResponse,
  TunnelErrorCode,
  TunnelStatusResponse,
} from '@tmex/shared';
import { type ApiClient, defaultApiClient } from '../client';
import { readCodedError } from '../json-mutation';
import { SELF_NODE_ID, resolveNodeUrl } from '../node-url';

export class TunnelApiError extends Error {
  constructor(
    readonly code: TunnelErrorCode,
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'TunnelApiError';
  }
}

/** 与默认契约的区别：不认顶层 `{ error: "..." }` 老形态，兜底 code 固定为 `unknown`。 */
function readError(res: Response, fallback: string): Promise<TunnelApiError> {
  return readCodedError(
    res,
    fallback,
    (code, message, status) => new TunnelApiError(code as TunnelErrorCode, message, status),
    (body) => {
      const error = (body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
      const code = error?.code;
      if (typeof code === 'string') {
        const message = error?.message;
        return new TunnelApiError(
          code as TunnelErrorCode,
          typeof message === 'string' ? message : code,
          res.status
        );
      }
      return new TunnelApiError('unknown', fallback, res.status);
    }
  );
}

export async function fetchTunnelStatus(
  client: ApiClient = defaultApiClient
): Promise<TunnelStatusResponse> {
  const res = await client.fetch(resolveNodeUrl(SELF_NODE_ID, '/api/tunnel/status'));
  if (!res.ok) throw await readError(res, 'Failed to load tunnel status');
  return (await res.json()) as TunnelStatusResponse;
}

export async function runTunnelAction(
  body: TunnelActionRequest,
  client: ApiClient = defaultApiClient
): Promise<TunnelActionResponse> {
  const res = await client.fetch(resolveNodeUrl(SELF_NODE_ID, '/api/tunnel/actions'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res, 'Tunnel action failed');
  return (await res.json()) as TunnelActionResponse;
}
