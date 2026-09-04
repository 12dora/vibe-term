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
  /** 当前占用（pending + admitted）；旧中继不下发。 */
  currentNodes?: number;
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
  /** 密钥日志同步健康度；旧节点不返回该字段。 */
  keyLog?: RelayKeyLogHealth;
}

/**
 * 中继上的密钥日志由同租户节点写入，被攻陷的成员可以塞进本机解不开的块。
 * 节点不会因此卡死同步：跳过并计数，`blockedSeq` 是第一条卡住的中继 seq。
 */
export interface RelayKeyLogHealth {
  skipped: number;
  blockedSeq: string | null;
  caughtUp: boolean;
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

/** join 串 v3 里的一条中继：租户编号与令牌由每台中继各自签发，不能跨中继复用。 */
export interface RelayJoinMaterialRelay {
  url: string;
  /** 32 位小写 hex。 */
  tenantId: string;
  /** base64url，32 字节。 */
  token: string;
}

/**
 * `GET /api/mesh/relay/join-material`：拼 join 串 v3 的材料（`logKey` 即 `K_log`）。
 *
 * `relays` 只含**真正持有这条 enrollment** 的中继（即当前 attach 的那台）；完整的有序中继表
 * 由加入后下载到的 `set-relays` 记录给出。
 */
export interface RelayJoinMaterial {
  /** base64url，32 字节。 */
  logKey: string;
  relays: RelayJoinMaterialRelay[];
}

/**
 * 一台中继对应的一块密封包。
 *
 * 每台中继各自签发租户编号与令牌，密封包的 KEK（info = tenant_id）、明文里的令牌与 AAD
 * 全都绑在**那一台**上，绝不能跨中继复用——所以是一台一块，不是一块广播。
 */
export interface RelayPackEntry {
  url: string;
  /** base64url(`nonce(12) ‖ AES-256-GCM(ct‖tag)`)。 */
  sealed_pack: string;
}

/**
 * `POST /api/mesh/relay/pack` 的请求体：密封包由**持有根种子的一方**（浏览器 / CLI）算好，
 * 节点只负责带着各自的租户令牌逐台转发。
 */
export interface RelayPackUpload {
  packs: RelayPackEntry[];
  kdf_params: { salt: string; memory_kib: number; iterations: number; parallelism: number };
  root_epoch: number;
  /** 超出安全整数时用十进制字符串。 */
  head_seq: number | string;
}

/** `POST /api/mesh/relay/pack` 的 200：逐台中继的转发结果（至少一台成功才算 200）。 */
export interface RelayPackUploadResult {
  ok: true;
  results?: { url: string; ok: boolean; status: number; code?: string }[];
}

/** `POST /api/mesh/relay/enrollments` 的 201（字段与 hub 的 `/api/hub/enrollments` 对齐）。 */
export interface RelayEnrollmentCreated {
  id: string;
  /** 节点侧路由返回的是 camelCase 的 `expiresAt`。 */
  expiresAt: number;
  /**
   * @deprecated 从未由服务端下发；只为让尚未跟进改名的调用方继续编译，新代码一律读 `expiresAt`。
   */
  expires_at?: number;
  /** 建码时刻的中继地址表；join 串里的地址以 `join-material` 为准。 */
  relays?: string[];
}

/**
 * `GET /api/mesh/relay/enrollments/:id`。
 *
 * 与 hub 的同名接口**不完全同形**：证书字段一致，但节点侧这条路由用 camelCase 的 `nodeId`
 * 与 `alreadyAdmitted`（hub 是 `node_id` / `already_admitted`）。引擎只从证书里解 node id，
 * 两个字段目前谁都没读；写在类型里是为了别再有人照着 hub 的字段名去取。
 */
export interface RelayEnrollmentStatus extends HubEnrollmentStatus {
  nodeId?: string;
  alreadyAdmitted?: boolean;
}

/** 中继口令不对（中继 `/api/relay/enroll` 的 401 原样透传）。 */
export const RELAY_PASSWORD_INVALID = 'RELAY_PASSWORD_INVALID';
/** 本机还没接入任何中继。 */
export const RELAY_NOT_CONFIGURED = 'RELAY_NOT_CONFIGURED';
/** 中继拒绝：该租户节点数已达配额。 */
export const RELAY_QUOTA_NODES = 'RELAY_QUOTA_NODES';
/** 要摘掉的中继不在本机的中继列表里。 */
export const RELAY_NOT_FOUND = 'RELAY_NOT_FOUND';
/** 只剩这一条中继：摘掉它等于离开，得走 `leavePrepare()`。 */
export const RELAY_LAST = 'RELAY_LAST';

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
  keyLog: { skipped: 0, blockedSeq: null, caughtUp: false },
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
    keyLog: {
      skipped: payload.keyLog?.skipped ?? 0,
      blockedSeq: payload.keyLog?.blockedSeq ?? null,
      caughtUp: payload.keyLog?.caughtUp === true,
    },
  };
}

/** 材料不全就报错，绝不静默拼一个解不开的 join 串出去。 */
const RELAY_TENANT_ID_HEX = /^[0-9a-f]{32}$/;

export function normalizeJoinMaterial(wire: Partial<RelayJoinMaterial>): RelayJoinMaterial {
  const relays = wire.relays ?? [];
  const usable =
    Boolean(wire.logKey) &&
    relays.length > 0 &&
    relays.every(
      (relay) =>
        Boolean(relay?.url) && Boolean(relay?.token) && RELAY_TENANT_ID_HEX.test(relay?.tenantId)
    );
  if (!usable) {
    throw new RelayApiError('RELAY_JOIN_MATERIAL_INVALID', 'incomplete join material', 200);
  }
  return {
    logKey: wire.logKey as string,
    relays: relays.map((relay) => ({
      url: relay.url,
      tenantId: relay.tenantId,
      token: relay.token,
    })),
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

  /**
   * `POST /api/mesh/relay/remove/prepare`：摘掉多中继里的某一条，其余原样保留、优先级重排。
   * 只剩一条时服务端回 `409 RELAY_LAST`（那种情形应当走 `leavePrepare()`）。
   */
  removePrepare(url: string): Promise<RelayPreparedPayload> {
    return this.json<RelayPreparedPayload>(`${BASE}/remove/prepare`, 'relay_remove_failed', {
      method: 'POST',
      body: { url },
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
  async joinMaterial(options: { scope?: 'attached' | 'all' } = {}): Promise<RelayJoinMaterial> {
    const query = options.scope === 'all' ? '?scope=all' : '';
    const wire = await this.json<Partial<RelayJoinMaterial>>(
      `${BASE}/join-material${query}`,
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

  /**
   * `POST /api/mesh/relay/pack`：把密封包交给本机节点，由它转发到各中继。
   * 一台都没转发成功时服务端回 502 `RELAY_PACK_FORWARD_FAILED`。
   */
  uploadPack(body: RelayPackUpload): Promise<RelayPackUploadResult> {
    return this.json<RelayPackUploadResult>(`${BASE}/pack`, 'relay_pack_upload_failed', {
      method: 'POST',
      body,
    });
  }

  /** `GET /api/mesh/relay/enrollments/:id`：证书字段与 hub 同形，供证书轮询复用。 */
  getEnrollment(id: string): Promise<RelayEnrollmentStatus> {
    return this.json<RelayEnrollmentStatus>(
      `${BASE}/enrollments/${encodeURIComponent(id)}`,
      'relay_enrollment_status_failed'
    );
  }
}

export const defaultRelayTenantApi = new RelayTenantApi(defaultApiClient);
