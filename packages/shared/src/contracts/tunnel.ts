// 远程访问（Cloudflare Tunnel）契约。只描述浏览器直连的那台机器（entry 自身），
// 路径固定 `/api/tunnel/*`，与 TLS/LocalApi 一样不带 `/n/<id>` 前缀。

export type TunnelMode = 'off' | 'quick' | 'named';

/**
 * 访问控制方式（向导「访问控制」步的用户选择）：
 * `none` 不设保护、`login` 账号密码登录（mesh 登录或本机登录）、`cloudflare` Cloudflare Access。
 * `null` 表示尚未选择（旧数据），前端按实际状态推导。
 */
export type TunnelAccessMode = 'none' | 'login' | 'cloudflare';

/**
 * `degraded`：cloudflared 进程活着，但连接器没有任何已注册的边缘连接（由本地 metrics
 * `/ready` 或日志判定）——公网地址此时不可达，与「运行中」必须区分。
 */
export type TunnelProcessState = 'stopped' | 'starting' | 'running' | 'degraded' | 'error';

export type TunnelJobKind =
  | 'install'
  | 'login'
  | 'create'
  | 'start'
  | 'stop'
  | 'remove'
  | 'check'
  | 'access';

export type TunnelJobState = 'running' | 'done' | 'error';

export type TunnelErrorCode =
  | 'unsupported_platform'
  | 'binary_missing'
  | 'download_failed'
  | 'not_logged_in'
  | 'login_timeout'
  | 'invalid_hostname'
  | 'tunnel_exists'
  | 'dns_route_failed'
  /** Cloudflare API 调用失败（token 权限不足 / account 不对 / 网络） */
  | 'access_api_failed'
  /** 本机既未启用登录也未受 Access 保护时，启动隧道必须显式带 acknowledgeExposure=true */
  | 'exposure_ack_required'
  | 'process_failed'
  /** 连通性检查：cloudflared 进程在但边缘连接数为 0（边缘/Access 层可达不代表本机可达） */
  | 'connector_down'
  | 'busy'
  | 'not_configured'
  | 'invalid_request'
  /** 本机未启用登录（standalone 且无用户），拒绝把无鉴权的 gateway 暴露到公网 */
  | 'auth_required'
  | 'unknown';

export interface TunnelBinaryStatus {
  installed: boolean;
  version: string | null;
  path: string | null;
  /** managed = tmex 自己下载到数据目录；system = PATH 里已有 */
  source: 'managed' | 'system' | null;
}

export interface TunnelAuthStatus {
  /** `cert.pem`（`cloudflared tunnel login` 产物）是否存在 */
  loggedIn: boolean;
  /** login job 进行中时供用户打开的授权 URL */
  loginUrl: string | null;
}

export interface TunnelConfigStatus {
  mode: TunnelMode;
  /** named 模式的公网主机名（如 tmex.example.com） */
  hostname: string | null;
  tunnelName: string | null;
  tunnelId: string | null;
  /** 随 gateway 启动自动拉起 */
  autoStart: boolean;
  /** 隧道进程由系统服务托管（adopt_external），tmex 不拉起/停止它 */
  externallyManaged: boolean;
  /** 本机监听端口（cloudflared ingress 的 origin） */
  originPort: number;
  /** 用户在「访问控制」步选定的方式；null = 尚未选择 */
  accessMode: TunnelAccessMode | null;
}

export type TunnelAccessPolicyRule =
  | { kind: 'email'; value: string }
  | { kind: 'email_domain'; value: string };

/**
 * Cloudflare Access 应用状态（standalone 模式下公网隧道的鉴权层；mesh 登录实例可选）。
 * API token / account id 只存服务端，状态里只透出是否已保存。
 */
export interface TunnelAccessStatus {
  /** 已保存 Cloudflare API token + account id */
  hasCredentials: boolean;
  accountId: string | null;
  /** Access 团队域（<team>.cloudflareaccess.com），从 API 读取 */
  teamDomain: string | null;
  /** 已为当前 hostname 创建 Access 应用 */
  configured: boolean;
  appId: string | null;
  /** 应用 AUD 标签，网关校验 JWT 时使用 */
  aud: string | null;
  /** 应用覆盖的主机名 */
  hostname: string | null;
  /** allow 策略规则（邮箱 / 邮箱域） */
  rules: TunnelAccessPolicyRule[];
  /** 网关对带 cf-connecting-ip 的请求强制校验 Cf-Access-Jwt-Assertion */
  enforceJwt: boolean;
  /** 校验实际生效：configured && enforceJwt && hostname 与当前隧道主机名一致 */
  effective: boolean;
  /** hub 角色下为 /hub/ 机器端点建的 bypass 应用 id（无则 null） */
  bypassAppId: string | null;
  /** 最近一次 Access API 错误（脱敏） */
  lastError: string | null;
}

/**
 * 系统里已存在、不由 tmex 托管的 cloudflared（brew/launchd/systemd 服务或手工进程）。
 * 探测来源：进程列表、launchd/systemd 单元、~/.cloudflared/config.yml 与 cert.pem。
 */
export interface TunnelExternalStatus {
  detected: boolean;
  /** 'launchd' | 'systemd' | 'process' | 'config' */
  source: string | null;
  configPath: string | null;
  tunnelId: string | null;
  tunnelName: string | null;
  /** config.yml ingress 里 service 指向本机 gateway 端口的主机名 */
  hostnames: string[];
  /** ~/.cloudflared/cert.pem 存在 */
  hasOriginCert: boolean;
  running: boolean;
  /**
   * 只读探测：Cloudflare Access 是否已覆盖探测到的/已配置主机名。
   * `checked: false` = 无法检测（无凭证或 API 失败）；与「已检测且未配置」区分。
   * 可选以保持旧客户端/夹具的线兼容。
   */
  externalAccess?: TunnelExternalAccessProbe;
  /**
   * 后台探测进行中，当前字段可能是缓存或尚未探测的占位。
   * 仅在刷新进行中时出现。
   */
  probing?: boolean;
}

/** 外部隧道上的 Cloudflare Access 只读探测结果（不写入本地 access 库）。 */
export interface TunnelExternalAccessProbe {
  checked: boolean;
  hostnameMatch: boolean;
  appId: string | null;
  aud: string | null;
  teamDomain: string | null;
}

/**
 * cloudflared 连接器状态，来自其本地 metrics 端点 `GET /ready`（`--metrics` 参数、
 * 日志里的 metrics 地址或缺省 127.0.0.1:20241–20245）。进程存活 ≠ 有边缘连接：
 * 本机代理 / TUN 抖动时进程常驻但 0 连接，公网地址随之不可达。
 */
export interface TunnelConnectorStatus {
  /** metrics 端点是否应答；`null` = 没找到端点，无法判断 */
  reachable: boolean | null;
  metricsAddr: string | null;
  /** `/ready` 的 readyConnections；端点不可达时为 null */
  readyConnections: number | null;
  connectorId: string | null;
  /** 最近一次探测时间（ISO）；从未探测为 null */
  checkedAt: string | null;
  /** cloudflared 日志（环形缓冲或 --logfile）里最近一条错误行（已脱敏） */
  lastError: string | null;
}

/**
 * cloudflared 边缘地址解析方式。系统解析器把 `*.argotunnel.com` 解析到 198.18.0.0/15
 * （本机代理的 fake-IP）时，边缘 7844 端口会被代理吞掉，进程存活但永远 0 连接；
 * 此时网关改用 DoH 解析出真实边缘 IP，以 `--edge` 静态列表启动 cloudflared 绕开劫持。
 */
export type TunnelEdgeMode = 'system' | 'static';

export interface TunnelEdgeResolution {
  mode: TunnelEdgeMode;
  /** 系统解析器返回了 fake-IP（198.18.0.0/15） */
  fakeIpDetected: boolean;
  /** mode=static 时传给 cloudflared 的 `--edge` 地址（host:port） */
  edgeAddrs: string[];
  /** 最近一次解析时间（ISO） */
  checkedAt: string | null;
  /** DoH 解析失败等原因（已脱敏）；成功为 null */
  lastError: string | null;
}

export interface TunnelProcessStatus {
  state: TunnelProcessState;
  pid: number | null;
  startedAt: string | null;
  /** quick 模式为 trycloudflare 临时地址；named 模式为 https://hostname */
  publicUrl: string | null;
  lastError: string | null;
  restarts: number;
}

export interface TunnelJobStatus {
  id: string;
  kind: TunnelJobKind;
  state: TunnelJobState;
  /**
   * 当前步骤的简短机器可读标识（前端映射文案），如 download / verify / route_dns。
   * `check` 结束后保留最后一步：`ok`（边缘 + 连接器都通）、`access_protected`（边缘由
   * Cloudflare Access 拦截，且连接器已验证有连接）、`access_protected_unverified`（Access
   * 拦截且找不到连接器 metrics，无法证明本机可达）。
   */
  step: string | null;
  error: { code: TunnelErrorCode; message: string } | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface TunnelStatusResponse {
  supported: boolean;
  platform: string;
  binary: TunnelBinaryStatus;
  auth: TunnelAuthStatus;
  config: TunnelConfigStatus;
  process: TunnelProcessStatus;
  /** 连接器（边缘连接）健康；托管与外部 cloudflared 都填 */
  connector: TunnelConnectorStatus;
  /** 边缘地址解析诊断；只有托管模式启动过 cloudflared 才有值，旧后端无此字段 */
  edge?: TunnelEdgeResolution | null;
  access: TunnelAccessStatus;
  external: TunnelExternalStatus;
  /** 本机是否启用了登录（mesh 角色下的用户名/密码/2FA） */
  loginEnforced: boolean;
  /** 隧道流量是否受保护：loginEnforced，或 Access 已配置且强制校验且主机名匹配 */
  exposureProtected: boolean;
  /** 进行中或最近一次结束的 job */
  job: TunnelJobStatus | null;
  /** 当前进程是否已按 TMEX_TRUST_PROXY=true 运行（生效值） */
  trustProxy: boolean;
  /** app.env 里已保存的值（期望值）；与 trustProxy 不一致即需重启 */
  configuredTrustProxy: boolean;
  /** 已写入 env 但需重启才生效 */
  restartRequired: boolean;
  /** 最近若干行 cloudflared 输出（已脱敏） */
  log: string[];
}

/** `POST /api/tunnel/actions`，异步动作返回 202 + job，同步动作返回 200 + status */
export type TunnelActionRequest =
  | { action: 'install' }
  | { action: 'login' }
  | { action: 'cancel_login' }
  | { action: 'create'; hostname: string; tunnelName?: string; acknowledgeExposure?: boolean }
  /** 未受保护（!exposureProtected）时必须 acknowledgeExposure=true，否则 409 exposure_ack_required */
  | { action: 'quick_start'; acknowledgeExposure?: boolean }
  | { action: 'start'; acknowledgeExposure?: boolean }
  | { action: 'stop' }
  | { action: 'remove' }
  | { action: 'check' }
  | { action: 'set_auto_start'; autoStart: boolean; acknowledgeExposure?: boolean }
  | { action: 'set_trust_proxy'; trustProxy: boolean }
  /** 保存 Cloudflare API token（需 Access: Apps and Policies — Edit 与 Access: Organizations, Identity Providers, and Groups — Read）与 account id；同步动作 */
  | { action: 'set_access_credentials'; apiToken: string; accountId: string }
  | { action: 'clear_access_credentials' }
  /**
   * 为主机名创建/更新 Access 应用与 allow 策略；异步 job kind = 'access'。
   * `hostname` 缺省取 config.hostname（mode=off 时可传向导里已确认的主机名，先于建隧道配置 Access）。
   * hub 角色会同时为 /hub/ 机器端点建 bypass 应用，避免节点 uplink / 加入被 Access 拦截。
   */
  | { action: 'configure_access'; rules: TunnelAccessPolicyRule[]; hostname?: string }
  /**
   * 删除 Access 应用；异步 job kind = 'access'。隧道运行中且这是最后一道保护
   * （!loginEnforced）时必须 acknowledgeExposure=true，否则 409 exposure_ack_required
   */
  | { action: 'remove_access'; acknowledgeExposure?: boolean }
  /** 用已保存凭证按主机名同步 Cloudflare 上已存在的 Access 应用/策略到本地状态；异步 job kind = 'access' */
  | { action: 'sync_access'; hostname?: string }
  /**
   * 接管系统里已存在的隧道：mode=named、hostname 取 external.hostnames[index]，
   * 不由 tmex 拉起进程（external 已在跑），只做状态展示与连通性检查
   */
  | { action: 'adopt_external'; hostname: string }
  /** 关闭强制校验且这是最后一道保护时同样需要 acknowledgeExposure=true */
  | { action: 'set_access_enforce'; enforceJwt: boolean; acknowledgeExposure?: boolean }
  /**
   * 记录「访问控制」步的选择。选 `none` 且隧道正在跑而当前没有任何保护时需 acknowledgeExposure=true，
   * 否则 409 exposure_ack_required；只记录选择，不会移除 Access 应用或关闭登录。
   */
  | { action: 'set_access_mode'; accessMode: TunnelAccessMode; acknowledgeExposure?: boolean };

export interface TunnelActionResponse {
  status: TunnelStatusResponse;
  job: TunnelJobStatus | null;
}

export interface TunnelErrorResponse {
  error: { code: TunnelErrorCode; message: string };
}
