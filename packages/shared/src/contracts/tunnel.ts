// 远程访问（Cloudflare Tunnel）契约。只描述浏览器直连的那台机器（entry 自身），
// 路径固定 `/api/tunnel/*`，与 TLS/LocalApi 一样不带 `/n/<id>` 前缀。

export type TunnelMode = 'off' | 'quick' | 'named';

export type TunnelProcessState = 'stopped' | 'starting' | 'running' | 'error';

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
  /** 当前步骤的简短机器可读标识（前端映射文案），如 download / verify / route_dns */
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
  /** 保存 Cloudflare API token（需 Access: Apps and Policies 编辑权限）与 account id；同步动作 */
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
  | { action: 'set_access_enforce'; enforceJwt: boolean; acknowledgeExposure?: boolean };

export interface TunnelActionResponse {
  status: TunnelStatusResponse;
  job: TunnelJobStatus | null;
}

export interface TunnelErrorResponse {
  error: { code: TunnelErrorCode; message: string };
}
