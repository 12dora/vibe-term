// 中继 enrollment 通道的浏览器客户端。
//
// 路径打本机 `/api/mesh/relay/*`（enrollment 由本机 uplink 转发到中继）。
// 鉴权是本机 node-session，一律走 entry 的 ApiClient（baseUrl 为空）。

import { type ApiClient, defaultApiClient } from '@vibeterm/api-client';
import type { EnrollmentCreated, EnrollmentStatus } from '@vibeterm/api-client/auth/index';
import { JSON_HEADERS, readCodedError } from '@vibeterm/api-client/json-mutation';

/**
 * `POST /api/mesh/relay/enrollments` 的逐台中继结果：enrollment 会 fan-out 到全部已授权中继，
 * 只有 `accepted` 的那几台真的能 redeem。旧节点不下发这一段（或只给 `string[]` 地址表）。
 */
export interface EnrollmentRelayResult {
  url: string;
  /** 32 位小写 hex；这一台自己签发的租户编号。 */
  tenantId: string;
  /** base64url，32 字节；只有 `accepted` 的那几台带。 */
  token?: string;
  accepted: boolean;
  /** 未接受的原因（超时 / 配额 / 拒绝）。 */
  error?: string;
}

export type { EnrollmentCreated, EnrollmentStatus };

export class EnrollmentApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code);
    this.name = 'EnrollmentApiError';
  }
}

/** 错误体除了标准契约还可能只带一个顶层 `code`，那一档走 `pick`。 */
function readError(res: Response, fallback: string): Promise<EnrollmentApiError> {
  return readCodedError(
    res,
    fallback,
    (code, _message, status) => new EnrollmentApiError(code, status),
    (body, status) => {
      if (!body || typeof body !== 'object') return undefined;
      const { error, code } = body as { error?: unknown; code?: unknown };
      if (error !== undefined) return undefined;
      return typeof code === 'string' ? new EnrollmentApiError(code, status) : undefined;
    }
  );
}

/** enrollment 创建 / 回读的共用形状。子类只换 `path()`。 */
export abstract class EnrollmentApi {
  constructor(protected readonly client: ApiClient = defaultApiClient) {}

  abstract path(suffix: string): string;

  /**
   * `GET …/enrollments/:id`：redeem 后带 `{certificate, cert_sig, node_id}`。
   * `/mesh/ws` 的 `ENROLL_REDEEMED` 推送丢失时（页面刚打开、WS 断线）由它兜底。
   */
  async getEnrollment(id: string): Promise<EnrollmentStatus> {
    const res = await this.client.fetch(this.path(`/enrollments/${encodeURIComponent(id)}`));
    if (!res.ok) throw await readError(res, 'enrollment_status_failed');
    return (await res.json()) as EnrollmentStatus;
  }

  async createEnrollment(body: {
    enroll_pk: string;
    authorization: string;
    authorization_sig: string;
    exp: number;
  }): Promise<EnrollmentCreated> {
    const res = await this.client.fetch(this.path('/enrollments'), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await readError(res, 'enrollment_failed');
    const created = (await res.json()) as EnrollmentCreated;
    return {
      ...created,
      expires_at: created.expires_at ?? created.expiresAt,
    };
  }
}

/**
 * 中继模式下的 enrollment 通道：路径是本机的 `/api/mesh/relay/*`。
 */
export class RelayEnrollmentApi extends EnrollmentApi {
  constructor(client: ApiClient = defaultApiClient) {
    super(client);
  }

  override path(suffix: string): string {
    return `/api/mesh/relay${suffix}`;
  }
}

/** 中继模式下唯一需要的那个 enrollment 通道实例（打的永远是本机）。 */
export const defaultRelayEnrollmentApi = new RelayEnrollmentApi();
