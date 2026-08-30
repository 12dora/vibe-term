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
  | 'check';

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
  | 'process_failed'
  | 'busy'
  | 'not_configured'
  | 'invalid_request'
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
  /** 本机监听端口（cloudflared ingress 的 origin） */
  originPort: number;
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
  /** 进行中或最近一次结束的 job */
  job: TunnelJobStatus | null;
  /** 当前进程是否已按 TMEX_TRUST_PROXY=true 运行 */
  trustProxy: boolean;
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
  | { action: 'create'; hostname: string; tunnelName?: string }
  | { action: 'quick_start' }
  | { action: 'start' }
  | { action: 'stop' }
  | { action: 'remove' }
  | { action: 'check' }
  | { action: 'set_auto_start'; autoStart: boolean }
  | { action: 'set_trust_proxy'; trustProxy: boolean };

export interface TunnelActionResponse {
  status: TunnelStatusResponse;
  job: TunnelJobStatus | null;
}

export interface TunnelErrorResponse {
  error: { code: TunnelErrorCode; message: string };
}
