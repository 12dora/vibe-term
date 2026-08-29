// 本机（entry 自身）运行态：角色、hub 地址、直连插件状态、TLS 状态。
//
// 与 hub 管理 API 不同，这里问的永远是**浏览器直连的那台机器**，所以走 entry 的 ApiClient
// （baseUrl 为空），不加 `/n/<id>` 前缀。

import { type ApiClient, defaultApiClient } from '../client';
import type { LocalDirectResponse, LocalStatusResponse } from './types';

/** 契约错误体 `{ error: { code, message } }` 解出来的类型化错误。 */
export class LocalApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'LocalApiError';
  }
}

async function readError(res: Response, fallback: string): Promise<LocalApiError> {
  try {
    const body = (await res.json()) as { error?: unknown };
    const error = body.error;
    if (error && typeof error === 'object') {
      const { code, message } = error as { code?: unknown; message?: unknown };
      if (typeof code === 'string') {
        return new LocalApiError(code, typeof message === 'string' ? message : code, res.status);
      }
    }
    // 反代 / 网关层可能给出 `{error: "..."}` 的老形态。
    if (typeof error === 'string') return new LocalApiError(error, error, res.status);
  } catch {
    // 落到 fallback
  }
  return new LocalApiError(fallback, fallback, res.status);
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

export class LocalApi {
  constructor(private readonly client: ApiClient = defaultApiClient) {}

  /** `GET /api/local/status`：mesh 下需要 self 会话，未登录返回 401。 */
  async status(): Promise<LocalStatusResponse> {
    const res = await this.client.fetch('/api/local/status');
    if (!res.ok) throw await readError(res, 'local_status_failed');
    return (await res.json()) as LocalStatusResponse;
  }

  /** `POST /api/local/direct`：下载 / 删除原生直连插件。 */
  async setDirect(enable: boolean): Promise<LocalDirectResponse> {
    const res = await this.client.fetch('/api/local/direct', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ enable }),
    });
    if (!res.ok) throw await readError(res, 'direct_failed');
    return (await res.json()) as LocalDirectResponse;
  }
}

export const defaultLocalApi = new LocalApi(defaultApiClient);
