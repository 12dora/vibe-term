// 系统信息与自更新契约

/** 部署方式：launchd（macOS）/ systemd（Linux）/ none（非 CLI 安装，如手动部署/dev） */
export type GatewayDeployment = 'launchd' | 'systemd' | 'none';

/** 升级状态机：仅这三态 */
export type UpgradeState = 'idle' | 'downloading' | 'executing';

/** 系统信息（gateway 权威），用于设置页版本 section */
export interface SystemInfo {
  /** 展示版本（非 production 带 _dev 后缀） */
  version: string;
  /** 原始版本号（不带后缀），用于检查更新比较 */
  baseVersion: string;
  /** 是否 production 环境 */
  isProd: boolean;
  /** 是否通过 CLI（tmex init）安装 */
  installedViaCli: boolean;
  /** 部署方式 */
  deployment: GatewayDeployment;
  /** 是否允许程序内自更新：isProd && installedViaCli && deployment!=='none' */
  canSelfUpdate: boolean;
  /** 服务名（CLI 安装时来自 install-meta，否则 null） */
  serviceName: string | null;
  /** 文件传输（上传/下载）单文件字节上限（前端据此做上传前预校验） */
  transferMaxBytes: number;
  /**
   * 管理模式（可选，向后兼容）：
   * - none：开源默认，允许 CLI 自更新路径
   * - app / companion-cli：由外部宿主管理版本，禁止自更新
   */
  managementMode?: 'none' | 'app' | 'companion-cli';
  /** 更新权归属（可选）；managed 时为 app|companion */
  updateOwner?: 'self' | 'app' | 'companion';
  /**
   * 本节点支持的升级能力。旧节点无此字段。
   * `'staged-package'`：接受入口推送的 tarball（`PUT /api/system/upgrade/package`）并从暂存包升级。
   * `'upgrade-cancel'`：支持 `DELETE /api/system/upgrade` 与 `DELETE /api/system/upgrade/package`。
   */
  upgradeCapabilities?: string[];
}

/** 检查更新结果 */
export interface UpdateCheckResult {
  /** 当前版本（base） */
  currentVersion: string;
  /** npm 上的最新版本（查询失败为 null） */
  latestVersion: string | null;
  /** 是否有可用更新 */
  hasUpdate: boolean;
  /** 目标版本 changelog（markdown，拉取不到为 null） */
  changelog: string | null;
  /** 最新版本发布时间 ISO 串（无则 null） */
  publishedAt: string | null;
}

/** 用户取消下载阶段的升级；FE 按此精确字符串识别 */
export const UPGRADE_CANCELLED = 'UPGRADE_CANCELLED';

/** 升级状态（轮询） */
export interface UpgradeStatus {
  state: UpgradeState;
  /** 目标版本（非 idle 时） */
  targetVersion: string | null;
  /** 最近一次错误（下载阶段失败时上报） */
  error: string | null;
  /** 本次升级开始时间 ISO 串 */
  startedAt: string | null;
}

/** 触发升级请求体 */
export interface StartUpgradeRequest {
  version: string;
  /** 缺省 `'release'`：目标自行从 GitHub Releases 下载。`'staged'`：使用已推送的暂存包。 */
  source?: 'release' | 'staged';
  /** `source='staged'` 时可选，须与暂存包 sha256 一致 */
  sha256?: string;
}

/** `PUT /api/system/upgrade/package` 成功响应 */
export interface StagedUpgradePackageResponse {
  version: string;
  sha256: string;
  bytes: number;
}

export interface RestartGatewayResponse {
  success: boolean;
  message: string;
}

/** 节点管理页「升级到最新」的稳定错误码 */
export type MeshUpgradeErrorCode =
  | 'NODE_LOGIN_REQUIRED'
  | 'NODE_UNREACHABLE'
  | 'UPGRADE_NOT_ALLOWED'
  | 'UPGRADE_IN_PROGRESS'
  | 'UPGRADE_ALREADY_LATEST'
  | 'UPGRADE_UNSUPPORTED'
  | 'UPGRADE_CANCEL_UNSUPPORTED'
  | 'UPGRADE_NOT_CANCELLABLE'
  | 'UPGRADE_NOT_RUNNING'
  | 'RELEASE_UNAVAILABLE'
  | 'NOT_FOUND';

/**
 * 远程卸载：目标节点 `POST /api/system/uninstall` 受理后返回 `scheduled`，随后由脱离的
 * 卸载器停服务、删安装目录 / shim / 数据——之后目标离线，状态不再可查。
 */
export type UninstallState = 'idle' | 'scheduled' | 'failed';

export interface UninstallStatus {
  state: UninstallState;
  startedAt: string | null;
  error: string | null;
}

/** `POST /api/system/uninstall` 请求体；目前只有 `full`（删服务、程序、shim、env、数据库） */
export interface StartUninstallRequest {
  mode?: 'full';
}

/** 节点管理页「卸载 tmex」的稳定错误码 */
export type MeshUninstallErrorCode =
  | 'NODE_LOGIN_REQUIRED'
  | 'NODE_UNREACHABLE'
  /** 目标不是 CLI 安装（容器 / 手动部署）或无服务管理器，无法自卸载 */
  | 'UNINSTALL_NOT_ALLOWED'
  /** 目标版本没有卸载接口 */
  | 'UNINSTALL_UNSUPPORTED'
  /** 不能从入口卸载入口自己 */
  | 'UNINSTALL_SELF_BLOCKED'
  | 'UPGRADE_IN_PROGRESS'
  | 'NOT_FOUND';

export interface MeshUninstallError {
  code: MeshUninstallErrorCode;
  nodeId?: string;
}

/**
 * 入口记录的节点长事务，随 `GET /api/mesh/nodes` 每行下发（`operation`），页面刷新后据此
 * 恢复行状态。`uninstall`：requested → uninstalling（目标已受理，随后离线）→ 由入口在该
 * 节点被吊销 / 消失时清除，或 `DELETE /api/mesh/nodes/:id/operation` 手动清除，超时自清。
 * `role-switch`：由 hub 主备切换写入，phase 由该接口定义。
 */
export type MeshNodeOperationKind = 'uninstall' | 'role-switch';

export interface MeshNodeOperation {
  kind: MeshNodeOperationKind;
  phase: string;
  /** epoch 毫秒 */
  startedAt: number;
  updatedAt: number;
  error: string | null;
}

/** `GET /api/mesh/upgrade/latest`：具体可安装版本，不含入口节点 hasUpdate */
export interface MeshUpgradeLatest {
  latestVersion: string;
  changelog: string | null;
  publishedAt: string | null;
}

export interface MeshUpgradeError {
  code: MeshUpgradeErrorCode;
  nodeId?: string;
  version?: string;
}

/** 本机可被其他设备访问的地址线索（`GET /api/system/addresses`），供「接入更多设备」面板拼地址 */
export interface AccessAddressesResponse {
  /** 网关监听地址（app.env `TMEX_BIND_HOST`） */
  bindHost: string;
  /** 网关监听端口 */
  port: number;
  /** 只监听回环：局域网设备无法直接访问 */
  loopbackOnly: boolean;
  /** 本机非回环 IPv4（私网段优先），只在 `loopbackOnly=false` 时有意义 */
  lanAddresses: string[];
}
