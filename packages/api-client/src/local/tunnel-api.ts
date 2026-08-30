// 远程访问（Cloudflare Tunnel）客户端。与 TLS/LocalApi 一样只问浏览器直连的那台机器，
// 路径经 `resolveNodeUrl(SELF_NODE_ID, ...)` 走 entry 自身，不加 `/n/<id>` 前缀。

import type {
  TunnelActionRequest,
  TunnelActionResponse,
  TunnelErrorCode,
  TunnelStatusResponse,
} from '@tmex/shared';
import { type ApiClient, defaultApiClient } from '../client';
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

async function readError(res: Response, fallback: string): Promise<TunnelApiError> {
  try {
    const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } };
    const code = body.error?.code;
    if (typeof code === 'string') {
      const message = body.error?.message;
      return new TunnelApiError(
        code as TunnelErrorCode,
        typeof message === 'string' ? message : code,
        res.status
      );
    }
  } catch {}
  return new TunnelApiError('unknown', fallback, res.status);
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
