// 本机运行态：角色、hub 地址、直连插件状态、TLS 状态。
//
// 缺省走 entry 的 ApiClient（baseUrl 为空），问的就是浏览器直连的那台机器；传入
// `createNodeApiClient(id)` 则同一组端点经 `/n/<id>` 转发到那台远端节点。

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

/**
 * `/n/<id>` 转发层自己的失败（`NODE_UNREACHABLE` 503、`NODE_LOGIN_REQUIRED` 401）用顶层信封
 * `{ code, reason }`，不是本机路由的 `{ error: { code } }`。不认这一形状就只能退到 fallback，
 * 「节点打不通」会显示成一句「直连插件操作失败」。
 */
function pickForwardedError(body: unknown, status: number): LocalApiError | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const { code, reason, message } = body as {
    code?: unknown;
    reason?: unknown;
    message?: unknown;
  };
  if (typeof code !== 'string' || code === '') return undefined;
  const detail = [reason, message].find((value) => typeof value === 'string' && value !== '');
  return new LocalApiError(code, typeof detail === 'string' ? detail : code, status);
}

function readError(res: Response, fallback: string): Promise<LocalApiError> {
  return readCodedError(
    res,
    fallback,
    (code, message, status) => new LocalApiError(code, message, status),
    pickForwardedError
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

  /** `POST /api/local/leave`：退出 mesh。默认 standalone；`targetRole:'relay'` 仅 `relay,node`。 */
  async leave(body: LocalLeaveRequest): Promise<LocalLeaveResponse> {
    return this.json<LocalLeaveResponse>('/api/local/leave', 'leave_failed', {
      method: 'POST',
      body,
    });
  }
}

export const defaultLocalApi = new LocalApi(defaultApiClient);
