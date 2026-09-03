// 本机（entry 自身）运行态：角色、hub 地址、直连插件状态、TLS 状态。
//
// 与 hub 管理 API 不同，这里问的永远是**浏览器直连的那台机器**，所以走 entry 的 ApiClient
// （baseUrl 为空），不加 `/n/<id>` 前缀。

import { type ApiClient, defaultApiClient } from '../client';
import { type JsonRequestOptions, readCodedError, requestJson } from '../json-mutation';
import type {
  LocalDirectAction,
  LocalDirectResponse,
  LocalLeaveRequest,
  LocalLeaveResponse,
  LocalStatusResponse,
} from './types';

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

function readError(res: Response, fallback: string): Promise<LocalApiError> {
  return readCodedError(
    res,
    fallback,
    (code, message, status) => new LocalApiError(code, message, status)
  );
}

export class LocalApi {
  constructor(private readonly client: ApiClient = defaultApiClient) {}

  private json<T>(path: string, fallback: string, options: JsonRequestOptions = {}): Promise<T> {
    return requestJson<T>(this.client, path, {
      ...options,
      toError: (res) => readError(res, fallback),
    });
  }

  /** `GET /api/local/status`：mesh 下需要 self 会话，未登录返回 401。 */
  async status(): Promise<LocalStatusResponse> {
    return this.json<LocalStatusResponse>('/api/local/status', 'local_status_failed');
  }

  /** `POST /api/local/direct`：安装 / 移除 / 启用 / 停用原生直连插件。 */
  async setDirect(action: LocalDirectAction): Promise<LocalDirectResponse> {
    return this.json<LocalDirectResponse>('/api/local/direct', 'direct_failed', {
      method: 'POST',
      body: { action },
    });
  }

  /** `POST /api/local/leave`：退出 mesh，清空本机 membership 并重启为 standalone。 */
  async leave(body: LocalLeaveRequest): Promise<LocalLeaveResponse> {
    return this.json<LocalLeaveResponse>('/api/local/leave', 'leave_failed', {
      method: 'POST',
      body,
    });
  }
}

export const defaultLocalApi = new LocalApi(defaultApiClient);
