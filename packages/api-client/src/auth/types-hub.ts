import { CONNECTION_HEADER } from '@vibeterm/shared/http/mesh-headers';
import type { HubEndpointInfo, HubMode } from '@vibeterm/shared/uplink';

/** `GET /api/mesh/hubs` 里本机 uplink 当前挂载的那台 hub；未连上时为 `null`。 */
export interface MeshAttachedHub {
  hubNodeId: string | null;
  publicUrl: string;
  mode: HubMode | null;
  writerEpoch: number | null;
  /** 这条 uplink 建立的时刻（epoch 毫秒）。 */
  since: number;
}

/**
 * 入口是凭什么认这台 hub 的：`signed` = 用户签名授权，`env` = 部署时写进 env 的 peer，
 * `self` = 本机自己就是这台 hub。旧后端不下发。
 */
export type HubAuthorizationKind = 'signed' | 'env' | 'self' | 'none';

/**
 * `GET /api/mesh/hubs` 里的一台 hub：uplink 契约的 `HubEndpointInfo` 再叠一个只有 REST 才有的
 * `authorization`——它是入口本地的授权来源，不在 hub 之间广播，故不进 `HubEndpointInfo` 本体。
 */
export type MeshHubEndpoint = HubEndpointInfo & { authorization?: HubAuthorizationKind };

/**
 * `GET /api/mesh/hubs`（**需会话**）。
 *
 * `writerHubId` 是当前接受管理写入的那台 hub（`active` 中 writerEpoch 最高的一台）；
 * 一台 active 都没有时为 `null`，此时任何 hub 都不收写入。
 */
export interface MeshHubsResponse {
  hubs: MeshHubEndpoint[];
  attached: MeshAttachedHub | null;
  writerHubId: string | null;
  /** uplink 的候选地址顺序与最近一次失败原因（诊断用）。 */
  candidates: Array<{
    publicUrl: string;
    lastError: string | null;
    caMismatch?: { advertised: string; pinned: string };
    lastAttemptAt: number | null;
    rttMs?: number | null;
    rttAt?: number | null;
  }>;
}

/** standby hub 拒绝管理写入的 409：`code` 之外还带 writer 的地址，UI 据此指路。 */
export const HUB_NOT_WRITER = 'HUB_NOT_WRITER';

/** 把请求绑到本标签页的那条 Gateway WS；新旧两个头名同时发送（混合版本桥）。 */
export { CONNECTION_HEADER };

/** `GET /api/mesh/connection` 的 200 响应。 */
export interface MeshConnectionResponse {
  connectionId: string;
}

/**
 * `NO_CONNECTION`：该 sid 在目标 node 上没有 live 的 Gateway WS（primary 还没连上 / 刚断）。
 * `MULTIPLE_CONNECTIONS`：同 sid 有多条（多标签），必须带 connection 头才能定位。
 */
export type MeshConnectionErrorCode = 'NO_CONNECTION' | 'MULTIPLE_CONNECTIONS';

export type MeshConnectionResult =
  | { ok: true; connectionId: string }
  | { ok: false; status: number; code: MeshConnectionErrorCode | string };

/** `GET /n/<hub>/api/hub/enrollments/:id`：redeem 后带证书。 */
export interface HubEnrollmentStatus {
  status: 'pending' | 'redeemed';
  enroll_pk: string;
  /** base64url(borsh(Certificate))；`status==='redeemed'` 时存在。 */
  certificate?: string;
  /** base64url，64 字节。 */
  cert_sig?: string;
  node_id?: string;
}
