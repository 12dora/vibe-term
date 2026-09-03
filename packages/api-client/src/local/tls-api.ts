// 内置 HTTPS 配置客户端。
//
// 与 `LocalApi` 一样问的永远是**浏览器直连的那台机器**：TLS 是安装态，只能在本机配置，
// 因此路径经 `resolveNodeUrl(SELF_NODE_ID, ...)` 走 entry 自身，不加 `/n/<id>` 前缀。

import { type ApiClient, defaultApiClient } from '../client';
import { type JsonRequestOptions, readCodedError, requestJson } from '../json-mutation';
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

function readError(res: Response, fallback: string): Promise<TlsApiError> {
  return readCodedError(
    res,
    fallback,
    (code, message, status) => new TlsApiError(code, message, status)
  );
}

export const TLS_PATH = resolveNodeUrl(SELF_NODE_ID, '/api/tls');
export const TLS_RENEW_PATH = resolveNodeUrl(SELF_NODE_ID, '/api/tls/renew');
export const TLS_CA_PATH = resolveNodeUrl(SELF_NODE_ID, '/api/tls/ca.crt');

export class TlsApi {
  constructor(private readonly client: ApiClient = defaultApiClient) {}

  private json<T>(path: string, fallback: string, options: JsonRequestOptions = {}): Promise<T> {
    return requestJson<T>(this.client, path, {
      ...options,
      toError: (res) => readError(res, fallback),
    });
  }

  /** `GET /api/tls`：mesh 下需要 self 会话，未登录返回 401。 */
  async status(): Promise<TlsStatusResponse> {
    return this.json<TlsStatusResponse>(TLS_PATH, 'tls_status_failed');
  }

  /**
   * `PUT /api/tls`：自签是同步签发，ACME 只落库并把 `acme.status` 置为 `pending`，
   * 两者的响应体都是 `GET /api/tls` 的形状。
   */
  async update(req: TlsUpdateRequest): Promise<TlsStatusResponse> {
    return this.json<TlsStatusResponse>(TLS_PATH, 'tls_failed', { method: 'PUT', body: req });
  }

  /** `POST /api/tls/renew`：none / external 下返回 409 `not_applicable`。 */
  async renew(): Promise<TlsStatusResponse> {
    return this.json<TlsStatusResponse>(TLS_RENEW_PATH, 'tls_failed', { method: 'POST' });
  }

  /** CA 证书下载地址：交给 `<a href download>`，不经 fetch（浏览器要直接存盘）。 */
  caDownloadUrl(): string {
    return this.client.url(TLS_CA_PATH);
  }
}

export const defaultTlsApi = new TlsApi(defaultApiClient);
