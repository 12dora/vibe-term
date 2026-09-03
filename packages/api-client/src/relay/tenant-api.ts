// 中继（relay）租户侧 API：本机节点的 `/api/mesh/relay/*`（plan-00 §1.9）。
//
// 与运营者侧（`admin-api.ts`，打中继机自己的 `/api/relay/*`）完全是两族路由：这里问的是
// **本机 gateway**，由它代为访问上级中继，鉴权是本机 node-session。因此固定用默认 ApiClient，
// 不加 `/n/<id>` 前缀——中继接入是本机的事，不能从别的 node 代发。
//
// 待签记录的 payload 一律由节点侧算好（它才有 X25519 公钥表与当前 K_log/K_meta），
// 浏览器只负责把 payload 包成密钥日志记录、签名、再走 `POST /api/auth/keylog?hub=sync` 提交。

import type { HubEnrollmentStatus } from '../auth/types';
import { type ApiClient, defaultApiClient } from '../client';
import { type JsonRequestOptions, readCodedError, requestJson } from '../json-mutation';
import { RelayApiError } from './admin-api';

/** 本机 uplink 的形态：接中继 / 接 hub / 都没有。 */
export type RelayUplinkMode = 'relay' | 'hub' | 'none';

/** 中继列表里的一条链路（按 `priority` 升序即 failover 顺序）。 */
export interface RelayLinkStatus {
  url: string;
  priority: number;
  online: boolean;
  /** 本机 uplink 当前挂在这一条上。 */
  attached: boolean;
  rttMs?: number | null;
  lastError?: string | null;
  /** 中继侧作废了本租户令牌（改密踢人 / 运营者手动踢）。 */
  kicked?: boolean;
}

/** 中继下发的配额；未接入或旧中继时为 `null`。 */
export interface RelayQuotaView {
  maxNodes: number;
  maxStreams: number;
  bandwidthBytesPerSec: number | null;
}

/** `GET /api/mesh/relay/status`。 */
export interface RelayTenantStatus {
  mode: RelayUplinkMode;
  /** 32 位小写 hex；非中继模式为 `null`。 */
  tenantId: string | null;
  relays: RelayLinkStatus[];
  /** 已应用的 `K_meta` 世代；0 = 尚无。 */
  metaEpoch: number;
  /** 经中继可见的对端节点数。 */
  nodesViaRelay: number;
  /** 令牌已失效，必须重新输入中继口令。 */
  reauthRequired: boolean;
  /** 中继按租户下发的配额。 */
  quota: RelayQuotaView | null;
}

/** `POST /api/mesh/relay/enroll/proof-material`：签 enroll proof 所需的材料。 */
export interface RelayProofMaterial {
  /** 归一化后的中继地址。 */
  url: string;
  /** `hubHostFromUrl(url)` 的结果，签名绑定到它。 */
  relayHost: string;
  /** 服务端给出的时间戳（毫秒）；中继按 ±`maxSkewMs` 判窗口。 */
  ts: number;
  maxSkewMs: number;
  /** 本机认的根公钥（base64url，32 字节）。 */
  rootPublicKey: string;
  rootEpoch: number;
}

/**
 * `POST /api/mesh/relay/enroll`：本机转调中继 `/api/relay/enroll`。
 * `proof` 是根钥对 Borsh 结构的 Ed25519 签名与被签字节——**只有根密码能签**。
 */
export interface RelayEnrollRequest {
  url: string;
  password?: string | null;
  proof: { bytes: string; sig: string };
}

/**
 * 待签的密钥日志 payload。`payloadHash` 是节点侧暂存待用密钥的键：记录应用时靠它把
 * 刚生成的 `K_log` / `K_meta` 认回来，浏览器只负责原样不动地签 `payload`。
 */
export interface RelayPreparedPayload {
  payload: string;
  payloadHash: string;
  /** `meta-key` 的世代（`meta-key/prepare` 下发）。 */
  epoch?: number;
  /** `set-relays` 里那一份 `meta_key` 的世代。 */
  metaEpoch?: number;
}

/** `POST /api/mesh/relay/enroll` 的 200：租户身份 + 待签的 `set-relays` payload。 */
export interface RelayEnrollResponse extends RelayPreparedPayload {
  tenantId: string;
  /** 租户令牌（base64url，32 字节）；浏览器不用它签任何东西，材料已在 payload 里。 */
  token: string;
  passwordEpoch: number;
}

/** `POST /api/mesh/relay/meta-key/prepare` 的请求体。 */
export type RelayMetaKeyOp =
  | { op: 'admit'; node_id: string }
  | { op: 'rotate'; exclude?: string[] };

/** `GET /api/mesh/relay/join-material`：拼 join 串 v3 的材料（`logKey` 即 `K_log`）。 */
export interface RelayJoinMaterial {
  /** 32 位小写 hex。 */
  tenantId: string;
  /** base64url，32 字节。 */
  token: string;
  /** base64url，32 字节。 */
  logKey: string;
  /** 按 priority 排好的中继地址，顺序即 join 串里的 failover 顺序。 */
  relays: string[];
}

/** `POST /api/mesh/relay/enrollments` 的 201（字段与 hub 的 `/api/hub/enrollments` 对齐）。 */
export interface RelayEnrollmentCreated {
  id: string;
  expires_at: number;
  /** 建码时刻的中继地址表；join 串里的地址以 `join-material` 为准。 */
  relays?: string[];
}

/** 中继口令不对（中继 `/api/relay/enroll` 的 401 原样透传）。 */
export const RELAY_PASSWORD_INVALID = 'RELAY_PASSWORD_INVALID';
/** 本机还没接入任何中继。 */
export const RELAY_NOT_CONFIGURED = 'RELAY_NOT_CONFIGURED';
/** 中继拒绝：该租户节点数已达配额。 */
export const RELAY_QUOTA_NODES = 'RELAY_QUOTA_NODES';

/**
 * 节点没有这族路由（版本太老 / 未启用）：`/api/mesh/relay/*` 一律 404。
 * 与运营者侧的 `isRelayNotEnabled` 是两回事（那条判的是本机没有 `relay` 角色）。
 */
export function isRelayRoutesMissing(error: unknown): boolean {
  return error instanceof RelayApiError && error.status === 404;
}

/** 类型化错误的 code；不是本族错误时为 `null`。 */
export function relayErrorCode(error: unknown): string | null {
  return error instanceof RelayApiError ? error.code : null;
}

export function isRelayPasswordInvalid(error: unknown): boolean {
  return relayErrorCode(error) === RELAY_PASSWORD_INVALID;
}

export function isRelayNotConfigured(error: unknown): boolean {
  return relayErrorCode(error) === RELAY_NOT_CONFIGURED;
}

export function isRelayQuotaExceeded(error: unknown): boolean {
  const code = relayErrorCode(error);
  return code === RELAY_QUOTA_NODES || code === 'RELAY_QUOTA_EXCEEDED';
}

const EMPTY_STATUS: RelayTenantStatus = {
  quota: null,
  mode: 'none',
  tenantId: null,
  relays: [],
  metaEpoch: 0,
  nodesViaRelay: 0,
  reauthRequired: false,
};

/** 缺字段一律补默认值：旧节点没有这条路由，`mode` 之外的字段也可能是后加的。 */
export function normalizeRelayStatus(
  payload: Partial<RelayTenantStatus> | null
): RelayTenantStatus {
  if (!payload) return EMPTY_STATUS;
  return {
    quota: payload.quota ?? null,
    mode: payload.mode ?? 'none',
    tenantId: payload.tenantId ?? null,
    relays: (payload.relays ?? []).map((row) => ({
      url: row.url,
      priority: row.priority ?? 0,
      online: row.online === true,
      attached: row.attached === true,
      rttMs: row.rttMs ?? null,
      lastError: row.lastError ?? null,
      kicked: row.kicked === true,
    })),
    metaEpoch: payload.metaEpoch ?? 0,
    nodesViaRelay: payload.nodesViaRelay ?? 0,
    reauthRequired: payload.reauthRequired === true,
  };
}

/** 材料不全就报错，绝不静默拼一个解不开的 join 串出去。 */
export function normalizeJoinMaterial(wire: Partial<RelayJoinMaterial>): RelayJoinMaterial {
  if (!wire.logKey || !wire.tenantId || !wire.token || !wire.relays?.length) {
    throw new RelayApiError('RELAY_JOIN_MATERIAL_INVALID', 'incomplete join material', 200);
  }
  return {
    tenantId: wire.tenantId,
    token: wire.token,
    logKey: wire.logKey,
    relays: wire.relays,
  };
}

/**
 * `/api/mesh/relay/*` 的错误体是 `{ code, ... }`（`session-middleware.ts` 的 `jsonError`），
 * 与运营者侧的 `{ error: { code, message } }` 不同一形，这里两种都认。
 */
async function readError(res: Response, fallback: string): Promise<RelayApiError> {
  const clone = res.clone();
  try {
    const body = (await clone.json()) as { code?: unknown; reason?: unknown };
    if (typeof body.code === 'string') {
      const reason = typeof body.reason === 'string' ? `${body.code}: ${body.reason}` : body.code;
      return new RelayApiError(body.code, reason, res.status);
    }
  } catch {
    // 落到通用契约
  }
  return readCodedError(
    res,
    fallback,
    (code, message, status) => new RelayApiError(code, message, status)
  );
}

const BASE = '/api/mesh/relay';

export class RelayTenantApi {
  constructor(private readonly client: ApiClient = defaultApiClient) {}

  private json<T>(path: string, fallback: string, options: JsonRequestOptions = {}): Promise<T> {
    return requestJson<T>(this.client, path, {
      ...options,
      toError: (res) => readError(res, fallback),
    });
  }

  /** `GET /api/mesh/relay/status`：本机 uplink 形态 + 中继列表。路由不存在时抛 404。 */
  async status(): Promise<RelayTenantStatus> {
    const payload = await this.json<Partial<RelayTenantStatus>>(
      `${BASE}/status`,
      'relay_status_failed'
    );
    return normalizeRelayStatus(payload);
  }

  /** `POST /api/mesh/relay/enroll/proof-material`：拿 `relayHost` 与 `ts` 去签 proof。 */
  proofMaterial(url: string): Promise<RelayProofMaterial> {
    return this.json<RelayProofMaterial>(`${BASE}/enroll/proof-material`, 'relay_proof_failed', {
      method: 'POST',
      body: { url },
    });
  }

  /** `POST /api/mesh/relay/enroll`：换回租户令牌与待签的 `set-relays` payload。 */
  enroll(body: RelayEnrollRequest): Promise<RelayEnrollResponse> {
    return this.json<RelayEnrollResponse>(`${BASE}/enroll`, 'relay_enroll_failed', {
      method: 'POST',
      body,
    });
  }

  /** `POST /api/mesh/relay/leave/prepare`：待签的 `set-relays`（空列表 = 离开全部中继）。 */
  leavePrepare(): Promise<RelayPreparedPayload> {
    return this.json<RelayPreparedPayload>(`${BASE}/leave/prepare`, 'relay_leave_failed', {
      method: 'POST',
      body: {},
    });
  }

  /** `POST /api/mesh/relay/meta-key/prepare`：待签的 `meta-key`（admit 补发 / rotate 换代）。 */
  metaKeyPrepare(body: RelayMetaKeyOp): Promise<RelayPreparedPayload> {
    return this.json<RelayPreparedPayload>(`${BASE}/meta-key/prepare`, 'relay_meta_key_failed', {
      method: 'POST',
      body,
    });
  }

  /** `GET /api/mesh/relay/join-material`：join 串 v3 的材料（仅中继模式）。 */
  async joinMaterial(): Promise<RelayJoinMaterial> {
    const wire = await this.json<Partial<RelayJoinMaterial>>(
      `${BASE}/join-material`,
      'relay_join_material_failed'
    );
    return normalizeJoinMaterial(wire);
  }

  /** `POST /api/mesh/relay/enrollments`：经 uplink 在中继上建一条 enrollment。 */
  createEnrollment(body: {
    enroll_pk: string;
    authorization: string;
    authorization_sig: string;
    exp: number;
  }): Promise<RelayEnrollmentCreated> {
    return this.json<RelayEnrollmentCreated>(`${BASE}/enrollments`, 'relay_enrollment_failed', {
      method: 'POST',
      body,
    });
  }

  /** `GET /api/mesh/relay/enrollments/:id`：与 hub 的同名接口同形，供证书轮询复用。 */
  getEnrollment(id: string): Promise<HubEnrollmentStatus> {
    return this.json<HubEnrollmentStatus>(
      `${BASE}/enrollments/${encodeURIComponent(id)}`,
      'relay_enrollment_status_failed'
    );
  }
}

export const defaultRelayTenantApi = new RelayTenantApi(defaultApiClient);
