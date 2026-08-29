// 内置 HTTPS 配置客户端。
//
// 与 `LocalApi` 一样问的永远是**浏览器直连的那台机器**：TLS 是安装态，只能在本机配置，
// 因此路径经 `resolveNodeUrl(SELF_NODE_ID, ...)` 走 entry 自身，不加 `/n/<id>` 前缀。

import { type ApiClient, defaultApiClient } from '../client';
import { SELF_NODE_ID, resolveNodeUrl } from '../node-url';
import type { TlsStatusResponse, TlsUpdateRequest } from './tls-types';

/** 契约错误体 `{ error: { code, message } }` 解出来的类型化错误。 */
export class TlsApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'TlsApiError';
  }
}

async function readError(res: Response, fallback: string): Promise<TlsApiError> {
  try {
    const body = (await res.json()) as { error?: unknown };
    const error = body.error;
    if (error && typeof error === 'object') {
      const { code, message } = error as { code?: unknown; message?: unknown };
      if (typeof code === 'string') {
        return new TlsApiError(code, typeof message === 'string' ? message : code, res.status);
      }
    }
    // 反代 / 网关层可能给出 `{error: "..."}` 的老形态。
    if (typeof error === 'string') return new TlsApiError(error, error, res.status);
  } catch {
    // 落到 fallback
  }
  return new TlsApiError(fallback, fallback, res.status);
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

export const TLS_PATH = resolveNodeUrl(SELF_NODE_ID, '/api/tls');
export const TLS_RENEW_PATH = resolveNodeUrl(SELF_NODE_ID, '/api/tls/renew');
export const TLS_CA_PATH = resolveNodeUrl(SELF_NODE_ID, '/api/tls/ca.crt');

export class TlsApi {
  constructor(private readonly client: ApiClient = defaultApiClient) {}

  /** `GET /api/tls`：mesh 下需要 self 会话，未登录返回 401。 */
  async status(): Promise<TlsStatusResponse> {
    const res = await this.client.fetch(TLS_PATH);
    if (!res.ok) throw await readError(res, 'tls_status_failed');
    return (await res.json()) as TlsStatusResponse;
  }

  /**
   * `PUT /api/tls`：自签是同步签发，ACME 只落库并把 `acme.status` 置为 `pending`，
   * 两者的响应体都是 `GET /api/tls` 的形状。
   */
  async update(req: TlsUpdateRequest): Promise<TlsStatusResponse> {
    const res = await this.client.fetch(TLS_PATH, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify(req),
    });
    if (!res.ok) throw await readError(res, 'tls_failed');
    return (await res.json()) as TlsStatusResponse;
  }

  /** `POST /api/tls/renew`：none / external 下返回 409 `not_applicable`。 */
  async renew(): Promise<TlsStatusResponse> {
    const res = await this.client.fetch(TLS_RENEW_PATH, { method: 'POST' });
    if (!res.ok) throw await readError(res, 'tls_failed');
    return (await res.json()) as TlsStatusResponse;
  }

  /** CA 证书下载地址：交给 `<a href download>`，不经 fetch（浏览器要直接存盘）。 */
  caDownloadUrl(): string {
    return this.client.url(TLS_CA_PATH);
  }
}

export const defaultTlsApi = new TlsApi(defaultApiClient);
