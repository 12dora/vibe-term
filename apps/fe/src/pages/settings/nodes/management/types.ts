import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import type { HubApi } from '@/node/hub-api';
import type { NodeRow } from '@/node/mesh-nodes';
import type {
  AuthApi,
  AuthKdfParamsJson,
  AuthModeResponse,
  HubEndpointInfo,
} from '@tmex/api-client/auth/index';

/** 已确认带 uid / kdf 参数的 mesh 模式：管理动作都要签名，缺一不可。 */
export type ResolvedMode = AuthModeResponse & { uid: string; kdfParams: AuthKdfParamsJson };

/** 节点表与行内动作共用的依赖：hub 通道、签名凭据与刷新回调。 */
export interface NodeActionDeps {
  hubApi: HubApi | null;
  hubOnline: boolean;
  /**
   * 管理写入当前是否被 hub 接受。挂在 standby 上、或 writer hub 缺席 / 离线时为 `false`：
   * 此时重命名 / 吊销 / 加入都会被 hub 以 `HUB_NOT_WRITER` 拒绝，不如先禁掉。
   * hub 集合未知（旧入口、首屏未加载）时恒为 `true`，单 hub 用户没有任何变化。
   */
  hubWritable: boolean;
  /** writer hub 的对外地址；拒写提示靠它指路。 */
  writerPublicUrl: string | null;
  /** hub 集合（按 nodeId 索引）：表内 hub 徽标的悬浮详情从这里取。 */
  hubDetails: ReadonlyMap<string, HubEndpointInfo>;
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
  /**
   * 「停止升级」已发出、结论还没回来（含 POST 在途时排队等补发的那一档）。与阶段无关：
   * 停止按钮据此变灰转圈，双击不会发出第二条 DELETE。
   */
  cancelling: boolean;
}

/** 一次升级跑完的结论；批量升级据此统计成败。`cancelled` 既不算成功也不算失败。 */
export type UpgradeRunOutcome = 'done' | 'failed' | 'timeout' | 'alreadyLatest' | 'cancelled';

/** 批量升级的进度；`running` 为 `false` 时另外两个值无意义。 */
export interface NodeUpgradeBatchState {
  running: boolean;
  total: number;
  completed: number;
}

/** 升级状态机对外的只读视图 + 触发入口。 */
export interface NodeUpgradeController {
  latest: NodeUpgradeLatest | null;
  entryOf: (nodeId: string) => NodeUpgradeEntry;
  start: (row: NodeRow) => void;
  /** 批量升级：内部按「普通节点 → 远端 hub → 本机」排序，逐组推进。 */
  startAll: (rows: NodeRow[]) => void;
  /** 中断这一行正在进行的升级；只有下载阶段能真正打断，安装阶段由后端拒绝。 */
  cancel: (row: NodeRow) => void;
  batch: NodeUpgradeBatchState;
  /** 当前 latest 下可批量升级的节点数；latest 未知时为 0。 */
  eligibleCount: (rows: NodeRow[]) => number;
  /** 有任何节点的升级在跑（行内或批量）：工具栏据此变灰，与 `startAll` 的同步互斥判定一致。 */
  anyRunning: boolean;
  /** 刷新后正在向各节点回读升级状态：此时还不知道谁在升级，批量入口先锁住。 */
  restoring: boolean;
  /** 回读还没收尾的行：这些行的升级按钮先锁住，避免与回读到的在途升级抢同一台机器。 */
  restoringIds: ReadonlySet<string>;
}

export const IDLE_UPGRADE_BATCH: NodeUpgradeBatchState = {
  running: false,
  total: 0,
  completed: 0,
};

export const IDLE_UPGRADE_ENTRY: NodeUpgradeEntry = {
  phase: 'idle',
  targetVersion: null,
  error: null,
  cancelling: false,
};

/** 没有 uid / kdf 参数时不渲染管理动作；hook 不能条件调用，故给个不会被用到的占位。 */
export const PLACEHOLDER_KDF: AuthKdfParamsJson = {
  salt: '',
  memory_kib: 0,
  iterations: 0,
  parallelism: 0,
};
