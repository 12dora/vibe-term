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
   * `'staged-package-resume'`：推包可断点续传——`GET /api/system/upgrade/package` 查已收字节数，
   * `PUT` 带 `offset` 从该处续写，链路中断不再丢掉已收到的部分。
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

/**
 * 入口代跑的远程升级进度（`GET /api/mesh/nodes/:id/upgrade`）。本机升级没有这一段。
 * `push` 阶段跨链路中断续传，`attempt` 从 1 开始计，重试时递增。
 */
export interface RemoteUpgradeProgress {
  phase: 'download' | 'push' | 'start';
  /** 已推送到目标的字节数（目标已确认收到的偏移） */
  pushedBytes: number;
  /** 升级包总字节数；下载未完成时为 0 */
  totalBytes: number;
  /**
   * `download` 阶段入口已从发行源取到的字节数。旧入口不上报这两个字段，前端按缺省处理。
   */
  downloadedBytes?: number;
  /** 发行源给出的下载总量；没有 `content-length` 时为 0 */
  downloadTotalBytes?: number;
  /** 当前是第几次推送尝试 */
  attempt: number;
}

/** 升级状态（轮询） */
export interface UpgradeStatus {
  state: UpgradeState;
  /** 目标版本（非 idle 时） */
  targetVersion: string | null;
  /** 最近一次错误（下载阶段失败时上报） */
  error: string | null;
  /** 本次升级开始时间 ISO 串 */
  startedAt: string | null;
  /** 仅远程升级：入口侧的下载 / 推包进度 */
  progress?: RemoteUpgradeProgress;
}

/** `GET /api/system/upgrade/package?version=&sha256=`：已收到多少字节，可否直接开始升级 */
export interface StagedPackageStatus {
  version: string;
  sha256: string;
  /** 已落盘的字节数：续传时作为 `PUT ?offset=` 的取值 */
  receivedBytes: number;
  /** 整包已校验通过并暂存完毕 */
  complete: boolean;
}

/** 触发升级请求体 */
export interface StartUpgradeRequest {
  version: string;
  /** 缺省 `'release'`：目标自行从 GitHub Releases 下载。`'staged'`：使用已推送的暂存包。 */
  source?: 'release' | 'staged';
  /** `source='staged'` 时可选，须与暂存包 sha256 一致 */
  sha256?: string;
}

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

/**
 * 入口转发 `503 NODE_UNREACHABLE` 的安全原因。只允许这一组字面量，避免把堆栈、
 * 主机名或令牌带回浏览器。`relay_reset:*` 对应中继 RST 原因（见 relay-stream-router）。
 * `no_link` 是「压根没有链路」；`link_lost` 是「链路建起来又断了」（中继复位、顶号、
 * 上行切换）——后者重试通常能成，前者不能。
 */
export type NodeUnreachableReason =
  | 'not_admitted'
  | 'no_link'
  | 'link_lost'
  | 'handshake_failed'
  | 'timeout'
  | 'relay_reset:self-target'
  | 'relay_reset:unknown-target'
  | 'relay_reset:offline'
  | 'relay_reset:quota-streams'
  | 'relay_reset:open-failed';

export interface NodeUnreachableErrorBody {
  code: 'NODE_UNREACHABLE';
  nodeId: string;
  reason?: NodeUnreachableReason;
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
