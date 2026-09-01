import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, posix, resolve, win32 } from 'node:path';
import { type TmexRoles, isTmexRoleName, rolesFromName } from '@tmex/shared';
import type { HubMode } from '@tmex/shared/uplink';

export type { TmexRoles };

declare const TMEX_MANAGED_BUILD: boolean | undefined;

function getEnv(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

function getBooleanEnv(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) {
    return defaultValue;
  }
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes';
}

function isManagedBuild(): boolean {
  return typeof TMEX_MANAGED_BUILD === 'boolean' && TMEX_MANAGED_BUILD;
}

function isCompanionManagedRuntime(env: NodeJS.ProcessEnv): boolean {
  return (
    isManagedBuild() ||
    (env.TMEX_MANAGEMENT_MODE === 'companion-cli' && env.TMEX_UPDATE_OWNER === 'companion')
  );
}

export function resolveGatewayPort(
  env: NodeJS.ProcessEnv = process.env,
  allowDynamicPort = isCompanionManagedRuntime(env)
): number {
  const raw = (env.GATEWAY_PORT ?? '9663').trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error('GATEWAY_PORT must be a decimal integer');
  }
  const port = Number(raw);
  const minimum = allowDynamicPort ? 0 : 1;
  if (!Number.isInteger(port) || port < minimum || port > 65535) {
    throw new Error(`GATEWAY_PORT must be an integer in ${minimum}..65535`);
  }
  return port;
}

export function resolveTmuxBin(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  managedBuild = isManagedBuild()
): string {
  const value = env.TMEX_TMUX_BIN?.trim();
  if (!value) {
    if (managedBuild && platform === 'win32') {
      throw new Error('TMEX_TMUX_BIN must be set to an absolute path on managed Windows');
    }
    return 'tmux';
  }
  const isAbsolute = platform === 'win32' ? win32.isAbsolute(value) : posix.isAbsolute(value);
  if (!isAbsolute) {
    throw new Error('TMEX_TMUX_BIN must be an absolute path');
  }
  return value;
}

function getGatewayOwnerToken(): string | null {
  const value = process.env.TMEX_GATEWAY_OWNER_TOKEN?.trim();
  if (!value) {
    return null;
  }
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error('TMEX_GATEWAY_OWNER_TOKEN must be exactly 32 bytes encoded as hex');
  }
  return value.toLowerCase();
}

export function parseTmexRoles(raw: string | undefined): TmexRoles {
  if (raw === undefined) {
    return rolesFromName('standalone');
  }
  const value = raw.trim();
  if (!isTmexRoleName(value)) {
    throw new Error('TMEX_ROLES must be one of standalone | node | hub,node');
  }
  return rolesFromName(value);
}

export function parsePeerPort(raw: string | undefined): number {
  const value = (raw ?? '39001').trim() || '39001';
  if (!/^\d+$/.test(value)) {
    throw new Error('TMEX_PEER_PORT must be a decimal integer');
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('TMEX_PEER_PORT must be an integer in 1..65535');
  }
  return port;
}

export function parseStunServers(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export const DEFAULT_PEER_BIND_HOSTS = ['::', '0.0.0.0'] as const;

export function parsePeerBindHost(raw: string | undefined): string[] {
  if (!raw) {
    return [...DEFAULT_PEER_BIND_HOSTS];
  }
  const hosts = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return hosts.length > 0 ? hosts : [...DEFAULT_PEER_BIND_HOSTS];
}

export function originUrlFromBindHost(bindHost: string, port: number): string {
  const unwrapped =
    bindHost.startsWith('[') && bindHost.endsWith(']') && bindHost.includes(':')
      ? bindHost.slice(1, -1)
      : bindHost;
  const host = unwrapped === '0.0.0.0' ? '127.0.0.1' : unwrapped === '::' ? '::1' : unwrapped;
  const authority = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
  return `http://${authority}`;
}

function getOptionalEnv(key: string): string | null {
  const value = process.env[key]?.trim();
  return value ? value : null;
}

export function parseHubMode(raw: string | undefined): HubMode {
  if (raw === undefined || raw.trim() === '') return 'active';
  const value = raw.trim();
  if (value === 'active' || value === 'standby') return value;
  throw new Error('TMEX_HUB_MODE must be active | standby');
}

export function parseHubPriority(raw: string | undefined, mode: HubMode): number {
  if (raw === undefined || raw.trim() === '') return mode === 'standby' ? 200 : 100;
  const value = raw.trim();
  if (!/^\d+$/.test(value)) {
    throw new Error('TMEX_HUB_PRIORITY must be a non-negative integer');
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error('TMEX_HUB_PRIORITY must be a non-negative integer');
  }
  return n;
}

export function parseHubWriterEpoch(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 1;
  const value = raw.trim();
  if (!/^\d+$/.test(value)) {
    throw new Error('TMEX_HUB_WRITER_EPOCH must be an integer >= 1');
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error('TMEX_HUB_WRITER_EPOCH must be an integer >= 1');
  }
  return n;
}

export function parseHubUrls(seed: string | null, raw: string | undefined): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const add = (item: string) => {
    const value = item.trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    urls.push(value);
  };
  if (seed) add(seed);
  if (raw) {
    for (const part of raw.split(',')) add(part);
  }
  return urls;
}

const HUB_PEER_ID = /^[0-9a-f]{32}$/;

export function parseHubPeers(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  const peers: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const value = part.trim().toLowerCase();
    if (!value) continue;
    if (!HUB_PEER_ID.test(value)) {
      throw new Error('TMEX_HUB_PEERS must be comma-separated 32-hex node ids');
    }
    if (seen.has(value)) continue;
    seen.add(value);
    peers.push(value);
  }
  return peers;
}

/** cloudflared 数据目录：显式 `TMEX_TUNNEL_DIR`，否则 sqlite 旁的 `tunnel/`。 */
export function resolveTunnelDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.TMEX_TUNNEL_DIR?.trim();
  if (explicit) return explicit;
  const dbUrl = (env.DATABASE_URL ?? './tmex.db').trim();
  if (dbUrl === ':memory:' || dbUrl.startsWith('file::memory:')) {
    return join(tmpdir(), 'tmex-tunnel');
  }
  const dbPath = isAbsolute(dbUrl) ? dbUrl : resolve(dbUrl);
  return join(dirname(dbPath), 'tunnel');
}

const hubMode = parseHubMode(process.env.TMEX_HUB_MODE);
const hubUrl = getOptionalEnv('TMEX_HUB_URL');

export const config = {
  // 核心安全配置（生产环境建议配置，用于加密敏感字段）
  masterKey: process.env.TMEX_MASTER_KEY,

  // 服务配置
  port: resolveGatewayPort(),
  bindHost: getEnv('TMEX_BIND_HOST', '0.0.0.0'),
  originUrl: originUrlFromBindHost(getEnv('TMEX_BIND_HOST', '0.0.0.0'), resolveGatewayPort()),
  baseUrl: getEnv('TMEX_BASE_URL', 'http://127.0.0.1:8085'),
  siteNameDefault: getEnv('TMEX_SITE_NAME', 'tmex'),

  // 数据库
  databaseUrl: getEnv('DATABASE_URL', './tmex.db'),
  tunnelDir: resolveTunnelDir(),

  // 文件传输（上传/下载）单文件字节上限，默认 2GB；后端校验 + 前端上传前预校验共用
  transferMaxBytes: Number.parseInt(getEnv('TMEX_TRANSFER_MAX_BYTES', '2147483648'), 10),

  // 设置默认值（可被数据库中的实际设置覆盖）
  bellThrottleSecondsDefault: Number.parseInt(getEnv('TMEX_BELL_THROTTLE_SECONDS', '6'), 10),
  notificationThrottleSecondsDefault: Number.parseInt(
    getEnv('TMEX_NOTIFICATION_THROTTLE_SECONDS', '3'),
    10
  ),
  tmuxAllowPassthrough: getBooleanEnv('TMEX_TMUX_ALLOW_PASSTHROUGH', false),
  // 逗号分隔的通知渠道禁用清单（如 "webhook,telegram"），命中的内建 channel
  // 在 EventNotifier 构造时直接跳过注册。getter 保证每次构造读取当前环境值。
  get disabledNotificationChannelsEnv(): string {
    return getEnv('TMEX_DISABLED_NOTIFICATION_CHANNELS', '');
  },
  // 主题切换时向订阅了 mode 2031 的 pane 注入 CSI ?997;{1|2}n 通知（kill switch）
  themeNotify2031Enabled: getBooleanEnv('TMEX_THEME_NOTIFY_2031', true),
  tmuxTermProgram: getEnv('TMEX_TMUX_TERM_PROGRAM', 'ghostty'),
  // 受管 session 的 window-style，用于 tmux 代答 pane 内 OSC 10/11 颜色查询；
  // 默认与前端 seoul256 dark 主题一致，设为 off 关闭
  tmuxWindowStyle: getEnv('TMEX_TMUX_WINDOW_STYLE', 'fg=#d0d0d0,bg=#262626'),
  // local 设备的 tmux socket（tmux -L <name>）。仅 e2e 注入 TMEX_TMUX_SOCKET=tmex-e2e
  // 以与生产默认 socket 隔离；生产/普通运行不设 → 空串 → 不加 -L → 用默认 socket。
  tmuxSocket: getEnv('TMEX_TMUX_SOCKET', ''),
  tmuxBin: resolveTmuxBin(),
  gatewayOwnerToken: getGatewayOwnerToken(),
  sshReconnectMaxRetriesDefault: Number.parseInt(getEnv('TMEX_SSH_RECONNECT_MAX_RETRIES', '2'), 10),
  sshReconnectDelaySecondsDefault: Number.parseInt(
    getEnv('TMEX_SSH_RECONNECT_DELAY_SECONDS', '10'),
    10
  ),
  languageDefault: getEnv('TMEX_DEFAULT_LANGUAGE', 'en_US'),

  roles: parseTmexRoles(process.env.TMEX_ROLES),
  hubUrl,
  hubPublicUrl: getOptionalEnv('TMEX_HUB_PUBLIC_URL'),
  hubMode,
  hubPriority: parseHubPriority(process.env.TMEX_HUB_PRIORITY, hubMode),
  hubWriterEpoch: parseHubWriterEpoch(process.env.TMEX_HUB_WRITER_EPOCH),
  hubUrls: parseHubUrls(hubUrl, process.env.TMEX_HUB_URLS),
  hubPeers: parseHubPeers(process.env.TMEX_HUB_PEERS),
  peerPort: parsePeerPort(process.env.TMEX_PEER_PORT),
  stunServers: parseStunServers(process.env.TMEX_STUN_SERVERS),
  peerBindHost: parsePeerBindHost(process.env.TMEX_PEER_BIND_HOST),
  turnUrl: getOptionalEnv('TMEX_TURN_URL'),
  turnUsername: getOptionalEnv('TMEX_TURN_USERNAME'),
  turnCredential: getOptionalEnv('TMEX_TURN_CREDENTIAL'),
  // When true, local Bun-socket requests (via=self) honour x-forwarded-proto /
  // x-forwarded-host for public origin, Secure cookies, and passkeyAvailable.
  // Never applied to forwarded (via ≠ self) requests. Default false.
  trustProxy: getBooleanEnv('TMEX_TRUST_PROXY', false),

  // 环境
  isDev: getEnv('NODE_ENV', 'development') === 'development',
  isTest: getEnv('NODE_ENV', 'development') === 'test',
  isProd: getEnv('NODE_ENV', 'development') === 'production',
} as const;

// 生产环境检查
if (config.isProd && !config.masterKey) {
  throw new Error('TMEX_MASTER_KEY is required in production mode');
}
