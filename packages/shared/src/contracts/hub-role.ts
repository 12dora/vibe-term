// hub 主 / 备远程切换契约（`POST /api/hub/role`，经入口 `/n/<hubNodeId>/api/hub/role` 代理）。
// 角色写进目标机 `app.env`（`TMEX_HUB_MODE` / `TMEX_HUB_WRITER_EPOCH`）并重启服务；
// 过渡状态由目标机持久化，页面刷新后凭 `operationId` 回读。

export type HubRoleMode = 'active' | 'standby';

export type HubRoleTransitionPhase =
  | 'accepted'
  | 'persisting'
  | 'restarting'
  | 'complete'
  | 'failed';

export interface HubRoleRequest {
  mode: HubRoleMode;
  /**
   * `active` 可省略：目标自行分配 `max(已知 writerEpoch)+1`（推荐，避免调用方视野不全）。
   * 显式传入时须大于目标已知的所有 writerEpoch，否则 `HUB_EPOCH_STALE`。`standby` 忽略。
   */
  writerEpoch?: number;
  /** 幂等键：同一 operationId 重复 POST 返回既有过渡记录 */
  operationId: string;
}

export interface HubRoleTransition {
  operationId: string;
  targetHubId: string;
  mode: HubRoleMode;
  writerEpoch: number | null;
  phase: HubRoleTransitionPhase;
  error: string | null;
  /** epoch 毫秒 */
  startedAt: number;
  updatedAt: number;
}

export type HubRoleErrorCode =
  /** 目标不是 hub 角色安装（`TMEX_ROLES` 不含 hub） */
  | 'HUB_NOT_HUB'
  /** 目标 hub 尚未被授权（无 admit-hub 记录且不在 TMEX_HUB_PEERS） */
  | 'HUB_NOT_AUTHORIZED'
  /** `active` 请求的 writerEpoch 不大于已知最大值 */
  | 'HUB_EPOCH_STALE'
  /** 已有过渡在进行 */
  | 'HUB_ROLE_BUSY'
  /** 目标版本没有该接口（入口把 404/405 映射成这个） */
  | 'HUB_ROLE_UNSUPPORTED'
  | 'INVALID_REQUEST';

export interface HubRoleError {
  code: HubRoleErrorCode;
  message?: string;
}
