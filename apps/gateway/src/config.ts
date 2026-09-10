import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, posix, resolve, win32 } from 'node:path';
import {
  type VibeTermRoles,
  isVibeTermRoleName,
  rolesFromName,
  validateRoles,
} from '@vibeterm/shared';
import type { HubMode } from '@vibeterm/shared/uplink';

export type { VibeTermRoles };

declare const VIBETERM_MANAGED_BUILD: boolean | undefined;

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
  return typeof VIBETERM_MANAGED_BUILD === 'boolean' && VIBETERM_MANAGED_BUILD;
}

function isCompanionManagedRuntime(env: NodeJS.ProcessEnv): boolean {
  return (
    isManagedBuild() ||
    (env.VIBETERM_MANAGEMENT_MODE === 'companion-cli' && env.VIBETERM_UPDATE_OWNER === 'companion')
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
  const value = env.VIBETERM_TMUX_BIN?.trim();
  if (!value) {
    if (managedBuild && platform === 'win32') {
      throw new Error('VIBETERM_TMUX_BIN must be set to an absolute path on managed Windows');
    }
    return 'tmux';
  }
  const isAbsolute = platform === 'win32' ? win32.isAbsolute(value) : posix.isAbsolute(value);
  if (!isAbsolute) {
    throw new Error('VIBETERM_TMUX_BIN must be an absolute path');
  }
  return value;
}

function getGatewayOwnerToken(): string | null {
  const value = process.env.VIBETERM_GATEWAY_OWNER_TOKEN?.trim();
  if (!value) {
    return null;
  }
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error('VIBETERM_GATEWAY_OWNER_TOKEN must be exactly 32 bytes encoded as hex');
  }
  return value.toLowerCase();
}

export function parseVibeTermRoles(raw: string | undefined): VibeTermRoles {
  if (raw === undefined) {
    return rolesFromName('standalone');
  }
  const value = raw.trim();
  if (!isVibeTermRoleName(value)) {
    throw new Error(
      'VIBETERM_ROLES must be one of standalone | node | hub,node | relay | relay,node'
    );
  }
  const roles = rolesFromName(value);
  const invalid = validateRoles(roles);
  if (invalid) {
    throw new Error(`VIBETERM_ROLES is invalid: ${invalid}`);
  }
  return roles;
}

/** `relay` 单跑（不带 node）：无用户、无设备、不应拉起即时通讯轮询。 */
export function isRelayOnly(roles: VibeTermRoles): boolean {
  return roles.relay && !roles.node && !roles.hub;
}

export function resolveLiveRoles(env: NodeJS.ProcessEnv = process.env): VibeTermRoles {
  return parseVibeTermRoles(env.VIBETERM_ROLES);
}

export function parsePeerPort(raw: string | undefined): number {
  const value = (raw ?? '39001').trim() || '39001';
  if (!/^\d+$/.test(value)) {
    throw new Error('VIBETERM_PEER_PORT must be a decimal integer');
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('VIBETERM_PEER_PORT must be an integer in 1..65535');
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

export type RtcPortRange = {
  begin: number;
  end: number;
};

export function parseRtcPortRange(raw: string | undefined): RtcPortRange | null {
  if (raw === undefined || raw.trim() === '') return null;
  const match = /^(\d+)\s*-\s*(\d+)$/.exec(raw.trim());
  if (!match?.[1] || !match[2]) {
    throw new Error('VIBETERM_RTC_PORT_RANGE must use begin-end format');
  }
  const begin = Number(match[1]);
  const end = Number(match[2]);
  if (
    !Number.isInteger(begin) ||
    !Number.isInteger(end) ||
    begin < 1 ||
    end > 65535 ||
    begin > end
  ) {
    throw new Error('VIBETERM_RTC_PORT_RANGE must be an ordered range within 1..65535');
  }
  return { begin, end };
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
  throw new Error('VIBETERM_HUB_MODE must be active | standby');
}

export function parseHubPriority(raw: string | undefined, mode: HubMode): number {
  if (raw === undefined || raw.trim() === '') return mode === 'standby' ? 200 : 100;
  const value = raw.trim();
  if (!/^\d+$/.test(value)) {
    throw new Error('VIBETERM_HUB_PRIORITY must be a non-negative integer');
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error('VIBETERM_HUB_PRIORITY must be a non-negative integer');
  }
  return n;
}

export function parseHubWriterEpoch(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 1;
  const value = raw.trim();
  if (!/^\d+$/.test(value)) {
    throw new Error('VIBETERM_HUB_WRITER_EPOCH must be an integer >= 1');
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error('VIBETERM_HUB_WRITER_EPOCH must be an integer >= 1');
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
      throw new Error('VIBETERM_HUB_PEERS must be comma-separated 32-hex node ids');
    }
    if (seen.has(value)) continue;
    seen.add(value);
    peers.push(value);
  }
  return peers;
}

export function parseHubAutoPromote(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return false;
  const value = raw.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

export const HUB_AUTO_PROMOTE_TIMEOUT_DEFAULT_MS = 600_000;

export function parseHubAutoPromoteTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return HUB_AUTO_PROMOTE_TIMEOUT_DEFAULT_MS;
  const value = raw.trim();
  if (!/^\d+$/.test(value)) {
    throw new Error('VIBETERM_HUB_AUTO_PROMOTE_TIMEOUT_MS must be an integer >= 1');
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error('VIBETERM_HUB_AUTO_PROMOTE_TIMEOUT_MS must be an integer >= 1');
  }
  return n;
}

/** `null` = auto: on when more than one authorized hub is known. */
export function parseUplinkPreferNearest(raw: string | undefined): boolean | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = raw.trim().toLowerCase();
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false;
  if (value === '1' || value === 'true' || value === 'yes' || value === 'on') return true;
  throw new Error(
    'VIBETERM_UPLINK_PREFER_NEAREST must be 0 | 1 | true | false | yes | no | on | off'
  );
}

/** 转发终端会话（mesh ws 流）单会话在途上限：载体队列 + mux 未回信用字节。 */
export const LINK_STREAM_INFLIGHT_DEFAULT_BYTES = 256 * 1024;
const LINK_STREAM_INFLIGHT_MIN_BYTES = 32 * 1024;

export function parseLinkStreamInflightBytes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return LINK_STREAM_INFLIGHT_DEFAULT_BYTES;
  const value = raw.trim();
  const invalid = new Error(
    `VIBETERM_LINK_STREAM_INFLIGHT_BYTES must be an integer >= ${LINK_STREAM_INFLIGHT_MIN_BYTES}`
  );
  if (!/^\d+$/.test(value)) throw invalid;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < LINK_STREAM_INFLIGHT_MIN_BYTES) throw invalid;
  return n;
}

/** cloudflared 数据目录：显式 `VIBETERM_TUNNEL_DIR`，否则 sqlite 旁的 `tunnel/`。 */
export function resolveTunnelDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.VIBETERM_TUNNEL_DIR?.trim();
  if (explicit) return explicit;
  const dbUrl = (env.DATABASE_URL ?? './vibeterm.db').trim();
  if (dbUrl === ':memory:' || dbUrl.startsWith('file::memory:')) {
    return join(tmpdir(), 'vibeterm-tunnel');
  }
  const dbPath = isAbsolute(dbUrl) ? dbUrl : resolve(dbUrl);
  return join(dirname(dbPath), 'tunnel');
}

const hubMode = parseHubMode(process.env.VIBETERM_HUB_MODE);
const hubUrl = getOptionalEnv('VIBETERM_HUB_URL');

export const config = {
  // 核心安全配置（生产环境建议配置，用于加密敏感字段）
  masterKey: process.env.VIBETERM_MASTER_KEY,

  // 服务配置
  port: resolveGatewayPort(),
  bindHost: getEnv('VIBETERM_BIND_HOST', '0.0.0.0'),
  originUrl: originUrlFromBindHost(getEnv('VIBETERM_BIND_HOST', '0.0.0.0'), resolveGatewayPort()),
  baseUrl: getEnv('VIBETERM_BASE_URL', 'http://127.0.0.1:8085'),
  siteNameDefault: getEnv('VIBETERM_SITE_NAME', 'VibeTerm'),

  // 数据库。默认值只用于 dev/test；生产的 DATABASE_URL 由安装版 app.env 注入，
  // 已有安装仍指向安装目录里的 tmex.db。
  databaseUrl: getEnv('DATABASE_URL', './vibeterm.db'),
  tunnelDir: resolveTunnelDir(),

  // 文件传输（上传/下载）单文件字节上限，默认 2GB；后端校验 + 前端上传前预校验共用
  transferMaxBytes: Number.parseInt(getEnv('VIBETERM_TRANSFER_MAX_BYTES', '2147483648'), 10),

  // 转发终端会话的在途上限（载体队列 + mux 未回信用字节）。压到 256 KiB 是拿输出完整性
  // 换交互延迟：超限即进 guard 的丢帧 → stream gap → canonical 回放这条既有降级路径。
  linkStreamInflightBytes: parseLinkStreamInflightBytes(
    process.env.VIBETERM_LINK_STREAM_INFLIGHT_BYTES
  ),

  // 设置默认值（可被数据库中的实际设置覆盖）
  bellThrottleSecondsDefault: Number.parseInt(getEnv('VIBETERM_BELL_THROTTLE_SECONDS', '6'), 10),
  notificationThrottleSecondsDefault: Number.parseInt(
    getEnv('VIBETERM_NOTIFICATION_THROTTLE_SECONDS', '3'),
    10
  ),
  tmuxAllowPassthrough: getBooleanEnv('VIBETERM_TMUX_ALLOW_PASSTHROUGH', false),
  // 逗号分隔的通知渠道禁用清单（如 "webhook,telegram"），命中的内建 channel
  // 在 EventNotifier 构造时直接跳过注册。getter 保证每次构造读取当前环境值。
  get disabledNotificationChannelsEnv(): string {
    return getEnv('VIBETERM_DISABLED_NOTIFICATION_CHANNELS', '');
  },
  // 主题切换时向订阅了 mode 2031 的 pane 注入 CSI ?997;{1|2}n 通知（kill switch）
  themeNotify2031Enabled: getBooleanEnv('VIBETERM_THEME_NOTIFY_2031', true),
  tmuxTermProgram: getEnv('VIBETERM_TMUX_TERM_PROGRAM', 'ghostty'),
  // 受管 session 的 window-style，用于 tmux 代答 pane 内 OSC 10/11 颜色查询；
  // 默认与前端 seoul256 dark 主题一致，设为 off 关闭
  tmuxWindowStyle: getEnv('VIBETERM_TMUX_WINDOW_STYLE', 'fg=#d0d0d0,bg=#262626'),
  // local 设备的 tmux socket（tmux -L <name>）。仅 e2e 注入 VIBETERM_TMUX_SOCKET=vibeterm-e2e
  // 以与生产默认 socket 隔离；生产/普通运行不设 → 空串 → 不加 -L → 用默认 socket。
  tmuxSocket: getEnv('VIBETERM_TMUX_SOCKET', ''),
  tmuxBin: resolveTmuxBin(),
  gatewayOwnerToken: getGatewayOwnerToken(),
  sshReconnectMaxRetriesDefault: Number.parseInt(
    getEnv('VIBETERM_SSH_RECONNECT_MAX_RETRIES', '2'),
    10
  ),
  sshReconnectDelaySecondsDefault: Number.parseInt(
    getEnv('VIBETERM_SSH_RECONNECT_DELAY_SECONDS', '10'),
    10
  ),
  languageDefault: getEnv('VIBETERM_DEFAULT_LANGUAGE', 'en_US'),

  roles: parseVibeTermRoles(process.env.VIBETERM_ROLES),
  hubUrl,
  hubPublicUrl: getOptionalEnv('VIBETERM_HUB_PUBLIC_URL'),
  relayPublicUrl: getOptionalEnv('VIBETERM_RELAY_PUBLIC_URL'),
  relayAdminToken: getOptionalEnv('VIBETERM_RELAY_ADMIN_TOKEN'),
  hubMode,
  hubPriority: parseHubPriority(process.env.VIBETERM_HUB_PRIORITY, hubMode),
  hubWriterEpoch: parseHubWriterEpoch(process.env.VIBETERM_HUB_WRITER_EPOCH),
  hubUrls: parseHubUrls(hubUrl, process.env.VIBETERM_HUB_URLS),
  hubPeers: parseHubPeers(process.env.VIBETERM_HUB_PEERS),
  hubAutoPromote: parseHubAutoPromote(process.env.VIBETERM_HUB_AUTO_PROMOTE),
  hubAutoPromoteTimeoutMs: parseHubAutoPromoteTimeoutMs(
    process.env.VIBETERM_HUB_AUTO_PROMOTE_TIMEOUT_MS
  ),
  uplinkPreferNearest: parseUplinkPreferNearest(process.env.VIBETERM_UPLINK_PREFER_NEAREST),
  peerPort: parsePeerPort(process.env.VIBETERM_PEER_PORT),
  stunServers: parseStunServers(process.env.VIBETERM_STUN_SERVERS),
  peerBindHost: parsePeerBindHost(process.env.VIBETERM_PEER_BIND_HOST),
  rtcPortRange: parseRtcPortRange(process.env.VIBETERM_RTC_PORT_RANGE),
  turnUrl: getOptionalEnv('VIBETERM_TURN_URL'),
  turnUsername: getOptionalEnv('VIBETERM_TURN_USERNAME'),
  turnCredential: getOptionalEnv('VIBETERM_TURN_CREDENTIAL'),
  // When true, local Bun-socket requests (via=self) honour x-forwarded-proto /
  // x-forwarded-host for public origin, Secure cookies, and passkeyAvailable.
  // Never applied to forwarded (via ≠ self) requests. Default false.
  trustProxy: getBooleanEnv('VIBETERM_TRUST_PROXY', false),

  // 环境
  isDev: getEnv('NODE_ENV', 'development') === 'development',
  isTest: getEnv('NODE_ENV', 'development') === 'test',
  isProd: getEnv('NODE_ENV', 'development') === 'production',
} as const;

// 生产环境检查
if (config.isProd && !config.masterKey) {
  throw new Error('VIBETERM_MASTER_KEY is required in production mode');
}
