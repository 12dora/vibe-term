// 中继（relay）运营者管理 API：`/api/relay/*`（plan-00 §1.7）。
//
// 问的永远是**浏览器直连的那台机器**——中继只能在中继机本地管理（管理令牌或本机 node-session），
// 所以固定用默认 ApiClient，不加 `/n/<id>` 前缀。
//
// `relay` 角色缺席时整族路由都不存在，`GET /api/relay/status` 回 404：调用方据此隐藏入口
// （见 `isRelayNotEnabled`），绝不能把它当成加载失败。

import { type ApiClient, defaultApiClient } from '../client';
import { type JsonRequestOptions, readCodedError, requestJson, requestOk } from '../json-mutation';
import type { LocalRelayTurnStatus } from '../local/types';
import type { RelayMetricsResponse } from './metrics-types';

export type {
  RelayMetricsMember,
  RelayMetricsProcess,
  RelayMetricsResponse,
  RelayMetricsSample,
  RelayMetricsTenant,
  RelayMetricsTotals,
} from './metrics-types';

/** 按租户的配额；`bandwidthBytesPerSec` / `maxFileBytes` 为 `null` 表示不限。 */
export interface RelayQuota {
  maxNodes: number;
  maxStreams: number;
  bandwidthBytesPerSec: number | null;
  /** 单文件传输上限（字节）；由中继发布、租户节点执行。旧中继不下发。 */
  maxFileBytes?: number | null;
}

/**
 * 中继级限额（不随 `relay.quota` 下发给租户）。
 * `maxTenants` / `totalBandwidthBytesPerSec` 为 `null` 表示不限；`fairShare` 关掉即先到先得。
 */
export interface RelayLimits {
  maxTenants: number | null;
  totalBandwidthBytesPerSec: number | null;
  fairShare: boolean;
}

/**
 * 服务端对配额的硬上限（`apps/gateway/src/relay/relay-quota.ts`）：任一字段越界都回
 * `400 RELAY_BAD_QUOTA`，表单据此在提交前给字段级报错。
 */
export const RELAY_QUOTA_LIMITS = {
  /** 与服务端一致：`relay.list` 一帧最多带 256 个节点，配大了也连不通。 */
  maxNodes: 256,
  maxStreams: 65_536,
  bandwidthBytesPerSec: 10 * 1024 * 1024 * 1024,
  maxFileBytes: 1024 * 1024 * 1024 * 1024,
} as const;

/** 中继级限额的硬上限（`apps/gateway/src/relay/relay-limits.ts`）；越界回 `400 RELAY_BAD_LIMITS`。 */
export const RELAY_LIMITS_BOUNDS = {
  maxTenants: 65_536,
  totalBandwidthBytesPerSec: 10 * 1024 * 1024 * 1024,
} as const;

/** 中继全局配置。`hasPassword` 为 false 时任何人都能 enroll。 */
export interface RelayConfigSummary {
  hasPassword: boolean;
  passwordEpoch: number;
  minTokenEpoch: number;
  defaultQuota: RelayQuota;
  /** 中继级限额；旧中继不返回。 */
  limits?: RelayLimits;
}

/** 租户一行。`quota` 为 `null` 表示跟随默认配额。 */
export interface RelayTenantSummary {
  id: string;
  label: string | null;
  createdAt: number;
  lastSeenAt: number | null;
  /** 未吊销的节点数（与配额口径一致）。 */
  nodes: number;
  /** 已吊销的节点数；不计入 `nodes`，表里只作灰色后缀。 */
  nodesRevoked: number;
  nodesOnline: number;
  streams: number;
  bytesIn: number;
  bytesOut: number;
  quota: RelayQuota | null;
  tokenEpoch: number;
  kicked: boolean;
}

export interface RelayTotals {
  tenants: number;
  /** 所有租户 pending+admitted 节点数之和（与配额占用同口径）。 */
  nodes: number;
  nodesOnline: number;
  streams: number;
  bytesIn: number;
  bytesOut: number;
}

/** `GET /api/relay/status`。 */
export interface RelayStatusResponse {
  config: RelayConfigSummary;
  tenants: RelayTenantSummary[];
  totals: RelayTotals;
  /** 内置/外部 TURN 状态；旧中继无此字段。 */
  turn?: LocalRelayTurnStatus;
}

/** `GET /api/relay/health`（无鉴权）。 */
export interface RelayHealthResponse {
  ok: boolean;
  version: string;
  tenants: number;
  nodesOnline: number;
  uptimeMs: number;
}

/**
 * 改口令时对现有租户的处置：
 * `kick` 抬 `min_token_epoch` 作废旧令牌（所有租户需重新输入口令），`keep` 只对新接入生效。
 */
export type RelayPasswordMode = 'kick' | 'keep';

/** `POST /api/relay/password`；`password` 为 `null` 即清除口令。 */
export interface RelayPasswordRequest {
  password: string | null;
  mode: RelayPasswordMode;
  force?: boolean;
}

/** `PATCH /api/relay/tenants/:id`；`quota: null` 改回跟随默认，`label: null` 清空备注。 */
export interface RelayTenantPatch {
  quota?: RelayQuota | null;
  label?: string | null;
}

export type RelayApiErrorDetails = {
  lastError?: string | null;
  lastErrorCode?: string | null;
  online?: number;
  admitted?: number;
  count?: number;
};

/** 契约错误体 `{ error: { code, message } }` 解出来的类型化错误。 */
export class RelayApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: RelayApiErrorDetails
  ) {
    super(message);
    this.name = 'RelayApiError';
  }
}

/** 本机没有 `relay` 角色：整族路由不存在。 */
export function isRelayNotEnabled(error: unknown): boolean {
  return error instanceof RelayApiError && error.status === 404;
}

/** 管理 API 不认这次身份（未登录 / 会话过期）。 */
export function isRelayUnauthorized(error: unknown): boolean {
  return error instanceof RelayApiError && error.status === 401;
}

function readError(res: Response, fallback: string): Promise<RelayApiError> {
  return readCodedError(
    res,
    fallback,
    (code, message, status) => new RelayApiError(code, message, status),
    (body, status) => {
      const error = (body as { error?: unknown } | null)?.error;
      if (!error || typeof error !== 'object') return undefined;
      const value = error as {
        code?: unknown;
        message?: unknown;
        online?: unknown;
        admitted?: unknown;
      };
      if (
        value.code !== 'relay_members_offline' ||
        typeof value.online !== 'number' ||
        !Number.isFinite(value.online) ||
        typeof value.admitted !== 'number' ||
        !Number.isFinite(value.admitted)
      )
        return undefined;
      return new RelayApiError(
        value.code,
        typeof value.message === 'string' ? value.message : value.code,
        status,
        { online: value.online, admitted: value.admitted }
      );
    }
  );
}

function tenantPath(tenantId: string, suffix = ''): string {
  return `/api/relay/tenants/${encodeURIComponent(tenantId)}${suffix}`;
}

export class RelayAdminApi {
  constructor(private readonly client: ApiClient = defaultApiClient) {}

  private json<T>(path: string, fallback: string, options: JsonRequestOptions = {}): Promise<T> {
    return requestJson<T>(this.client, path, {
      ...options,
      toError: (res) => readError(res, fallback),
    });
  }

  /** 非 2xx 抛 `RelayApiError`；成功的响应体一律丢弃，调用方重新拉 status 取权威值。 */
  private async mutate(path: string, fallback: string, options: JsonRequestOptions): Promise<void> {
    await requestOk(this.client, path, { ...options, toError: (res) => readError(res, fallback) });
  }

  /** `GET /api/relay/status`：配置 + 租户表 + 总量。角色缺席回 404。 */
  status(): Promise<RelayStatusResponse> {
    return this.json<RelayStatusResponse>('/api/relay/status', 'relay_status_failed');
  }

  /** `GET /api/relay/health`：无鉴权的健康探针。 */
  health(): Promise<RelayHealthResponse> {
    return this.json<RelayHealthResponse>('/api/relay/health', 'relay_health_failed');
  }

  /**
   * `GET /api/relay/metrics`：进程/吞吐/成员运营指标。
   * `members: false` 时请求 `?members=0`，响应省略 `members` 数组。
   */
  metrics(opts: { members: false }): Promise<Omit<RelayMetricsResponse, 'members'>>;
  metrics(opts?: { members?: boolean }): Promise<RelayMetricsResponse>;
  metrics(opts?: { members?: boolean }): Promise<RelayMetricsResponse> {
    const query = opts?.members === false ? '?members=0' : '';
    return this.json<RelayMetricsResponse>(`/api/relay/metrics${query}`, 'relay_metrics_failed');
  }

  /** `POST /api/relay/password`：设置或清除接入口令。 */
  setPassword(body: RelayPasswordRequest): Promise<void> {
    return this.mutate('/api/relay/password', 'relay_password_failed', {
      method: 'POST',
      body,
    });
  }

  /** `PATCH /api/relay/config`：全局默认配额。 */
  updateDefaultQuota(defaultQuota: RelayQuota): Promise<void> {
    return this.mutate('/api/relay/config', 'relay_config_failed', {
      method: 'PATCH',
      body: { defaultQuota },
    });
  }

  /** `PATCH /api/relay/config`：中继级限额（租户数 / 总带宽 / 公平分配）。 */
  updateLimits(limits: RelayLimits): Promise<void> {
    return this.mutate('/api/relay/config', 'relay_limits_failed', {
      method: 'PATCH',
      body: { limits },
    });
  }

  /** `PATCH /api/relay/tenants/:id`：单租户配额与备注。 */
  updateTenant(tenantId: string, patch: RelayTenantPatch): Promise<void> {
    return this.mutate(tenantPath(tenantId), 'relay_tenant_failed', {
      method: 'PATCH',
      body: patch,
    });
  }

  /** `POST /api/relay/tenants/:id/kick`：作废该租户令牌并断开。 */
  kickTenant(tenantId: string, body?: { force?: boolean }): Promise<void> {
    return this.mutate(tenantPath(tenantId, '/kick'), 'relay_kick_failed', {
      method: 'POST',
      body,
    });
  }

  /** `DELETE /api/relay/tenants/:id`：删注册表与密钥日志。 */
  deleteTenant(tenantId: string): Promise<void> {
    return this.mutate(tenantPath(tenantId), 'relay_delete_failed', { method: 'DELETE' });
  }
}

export const defaultRelayAdminApi = new RelayAdminApi(defaultApiClient);
