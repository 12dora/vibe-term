import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import type { HubApi } from '@/node/hub-api';
import type { NodeRow } from '@/node/mesh-nodes';
import type { AuthApi, AuthKdfParamsJson, AuthModeResponse } from '@tmex/api-client/auth/index';

/** 已确认带 uid / kdf 参数的 mesh 模式：管理动作都要签名，缺一不可。 */
export type ResolvedMode = AuthModeResponse & { uid: string; kdfParams: AuthKdfParamsJson };

/** 节点表与行内动作共用的依赖：hub 通道、签名凭据与刷新回调。 */
export interface NodeActionDeps {
  hubApi: HubApi | null;
  hubOnline: boolean;
  mode: ResolvedMode;
  api: AuthApi;
  prompt: CredentialPromptHandle;
  onChanged: () => void;
  /** 升级只依赖入口 → 目标的 peer link，与 hub 管理面无关，故与 rename/revoke 分开一套状态。 */
  upgrade: NodeUpgradeController;
}

/** `GET /api/mesh/upgrade/latest`：入口节点解析出的最新发行版本。 */
export interface NodeUpgradeLatest {
  latestVersion: string;
  changelog: string | null;
  publishedAt: string | null;
}

/**
 * 一行的升级阶段。`pending` 是「已发出请求、目标还没转起来」；`restarting` 是「目标网关正在
 * 重启」——此时连不上目标是预期现象，不是失败。
 */
export type NodeUpgradePhase =
  | 'idle'
  | 'pending'
  | 'downloading'
  | 'executing'
  | 'restarting'
  | 'done'
  | 'failed';

export interface NodeUpgradeEntry {
  phase: NodeUpgradePhase;
  /** 目标版本；latest 还没拿到时为 `null`。 */
  targetVersion: string | null;
  /** 已本地化的失败原因；非 `failed` 阶段为 `null`。 */
  error: string | null;
}

/** 升级状态机对外的只读视图 + 触发入口。 */
export interface NodeUpgradeController {
  latest: NodeUpgradeLatest | null;
  entryOf: (nodeId: string) => NodeUpgradeEntry;
  start: (row: NodeRow) => void;
}

export const IDLE_UPGRADE_ENTRY: NodeUpgradeEntry = {
  phase: 'idle',
  targetVersion: null,
  error: null,
};

/** 没有 uid / kdf 参数时不渲染管理动作；hook 不能条件调用，故给个不会被用到的占位。 */
export const PLACEHOLDER_KDF: AuthKdfParamsJson = {
  salt: '',
  memory_kib: 0,
  iterations: 0,
  parallelism: 0,
};
