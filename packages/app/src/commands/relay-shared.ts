import {
  RELAY_QUOTA_MAX_BANDWIDTH,
  RELAY_QUOTA_MAX_NODES_LIMIT,
  RELAY_QUOTA_MAX_STREAMS_LIMIT,
} from '../../../../apps/gateway/src/relay/relay-quota';
import { errorMessage } from '../lib/error-message';
import type { FetchLike } from '../lib/fetch-like';
import type { LocalAuthContext } from '../lib/local-auth';
import { readBoundedResponseText } from '../lib/pem';
import type { ParsedArgs } from '../types';

/** 每次请求（含读响应体）的上限：中继接受连接却不回话时不能把 failover 卡死。 */
export const RELAY_REQUEST_TIMEOUT_MS = 15_000;
/** health / lookup / 错误体的响应上限。 */
export const RELAY_RESPONSE_MAX_BYTES = 1024 * 1024;
/** redeem 要带回整条密钥日志，单独给一个更宽的上限。 */
export const RELAY_REDEEM_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;

export type RelayIo = {
  log?: (message: string) => void;
  fetcher?: FetchLike;
  auth?: LocalAuthContext;
  env?: Record<string, string>;
  /** 本机用户密码（非交互测试用）。 */
  password?: string;
  /** 中继站点口令（非交互测试用）。 */
  relayPassword?: string;
  /** `relay passwd` 的新口令（非交互测试用）。 */
  newRelayPassword?: string;
  totpCode?: string;
  now?: () => number;
  confirm?: () => boolean | Promise<boolean>;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
};

export type RelayQuota = {
  maxNodes: number;
  maxStreams: number;
  bandwidthBytesPerSec: number | null;
};

/** 传输层失败的一种：`isRelayTransportError` 认它，可以换下一台中继重试。 */
export class RelayTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'RelayTimeoutError';
  }
}

export class RelayApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'RelayApiError';
    this.status = status;
    this.code = code;
  }
}

export function relayLog(io: RelayIo | undefined, message: string): void {
  (io?.log ?? console.log)(message);
}

export function joinRelayUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

/** 绑到 IPv6 字面量（`::`、`::1`、某个 v6 地址）的实例只在 v6 回环上可达。 */
export function loopbackHost(env: Record<string, string | undefined>): string {
  const bind = (env.TMEX_BIND_HOST ?? '').trim().replace(/^\[|\]$/g, '');
  return bind.includes(':') ? '[::1]' : '127.0.0.1';
}

/** CLI 只走回环访问本机 gateway：TMEX_BIND_HOST 可能是 0.0.0.0/::，不能直接拼。 */
export function gatewayBaseUrl(env: Record<string, string | undefined>): string {
  const port = (env.GATEWAY_PORT ?? '').trim();
  if (!port || !/^\d+$/.test(port)) {
    throw new Error('GATEWAY_PORT missing from app.env; run tmex init first');
  }
  return `http://${loopbackHost(env)}:${port}`;
}

export function relayAdminToken(env: Record<string, string | undefined>): string {
  const token = (env.TMEX_RELAY_ADMIN_TOKEN ?? '').trim();
  if (!token) {
    throw new Error(
      'TMEX_RELAY_ADMIN_TOKEN missing from app.env; this machine is not running the relay role'
    );
  }
  return token;
}

async function readRelayBody(
  response: Response,
  maxBytes: number,
  label: string
): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readBoundedResponseText(response, maxBytes);
  } catch (error) {
    const message = errorMessage(error);
    throw new Error(
      message === 'ca_response_too_large'
        ? `${label} response exceeds ${maxBytes} bytes`
        : `${label} response could not be read: ${message}`
    );
  }
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { raw: text };
  }
}

export async function requestRelayJson(options: {
  fetcher?: FetchLike;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  label: string;
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<Record<string, unknown>> {
  const fetcher = options.fetcher ?? fetch;
  const headers: Record<string, string> = { ...options.headers };
  let payload: string | undefined;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(options.body);
  }
  const timeoutMs = options.timeoutMs ?? RELAY_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetcher(options.url, {
      method: options.method ?? (payload ? 'POST' : 'GET'),
      headers,
      redirect: 'error',
      signal: controller.signal,
      ...(payload === undefined ? {} : { body: payload }),
    });
    const body = await readRelayBody(
      response,
      options.maxBytes ?? RELAY_RESPONSE_MAX_BYTES,
      options.label
    );
    if (!response.ok) {
      throw new RelayApiError(
        response.status,
        relayErrorCode(body, response.status),
        `${options.label} failed: HTTP ${response.status} ${relayErrorCode(body, response.status)}`
      );
    }
    return body;
  } catch (error) {
    if (timedOut) throw new RelayTimeoutError(options.label, timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 仓库统一错误契约是 `{ error: { code, message } }`；旧路由还有 `{ error: 'CODE' }`。 */
export function relayErrorCode(body: Record<string, unknown>, status: number): string {
  const error = body.error;
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const code = (error as Record<string, unknown>).code;
    if (typeof code === 'string' && code) return code;
  }
  if (typeof error === 'string' && error) return error;
  if (typeof body.code === 'string' && body.code) return body.code;
  return `HTTP_${status}`;
}

export function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function asText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function formatBytes(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

export function formatQuota(quota: RelayQuota | null): string {
  if (!quota) return 'inherit';
  const bandwidth =
    quota.bandwidthBytesPerSec == null
      ? 'unlimited'
      : `${Math.round(quota.bandwidthBytesPerSec / 1024)} KB/s`;
  return `nodes=${quota.maxNodes} streams=${quota.maxStreams} bw=${bandwidth}`;
}

export function quotaFromJson(value: unknown): RelayQuota | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const bandwidth = raw.bandwidthBytesPerSec;
  return {
    maxNodes: asNumber(raw.maxNodes),
    maxStreams: asNumber(raw.maxStreams),
    bandwidthBytesPerSec: typeof bandwidth === 'number' ? bandwidth : null,
  };
}

/** `--bandwidth <KBps>|unlimited` → bytes/s；`unlimited`/`0` 表示不限速。 */
export function parseBandwidthFlag(raw: string): number | null {
  const value = raw.trim().toLowerCase();
  if (value === 'unlimited' || value === 'none' || value === '0') return null;
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`invalid --bandwidth: ${raw} (use a KB/s number or "unlimited")`);
  }
  const bytes = Math.round(Number(value) * 1024);
  // 服务端 `normalizeRelayQuota` 只收 [1, RELAY_QUOTA_MAX_BANDWIDTH] 的整数；越界会 400，
  // 而 Infinity 经 JSON.stringify 会变成 null（= 不限速），不能让它悄悄穿过去。
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > RELAY_QUOTA_MAX_BANDWIDTH) {
    throw new Error(
      `invalid --bandwidth: ${raw} (1..${RELAY_QUOTA_MAX_BANDWIDTH / 1024} KB/s or "unlimited")`
    );
  }
  return bytes;
}

export function parseCountFlag(raw: string, flag: string): number {
  const value = raw.trim();
  const limit = flag === 'max-nodes' ? RELAY_QUOTA_MAX_NODES_LIMIT : RELAY_QUOTA_MAX_STREAMS_LIMIT;
  if (!/^\d+$/.test(value)) {
    throw new Error(`invalid --${flag}: ${raw} (expected a positive integer)`);
  }
  const parsed = Number(value);
  // 与服务端 `positiveInt` 同一区间：0 与越界值服务端一律 400。
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > limit) {
    throw new Error(`invalid --${flag}: ${raw} (expected 1..${limit})`);
  }
  return parsed;
}

export function formatTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? '').length))
  );
  const render = (cells: string[]): string =>
    cells
      .map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(widths[index])))
      .join('  ')
      .trimEnd();
  return [render(headers), ...rows.map(render)];
}

export function wantsJson(parsed: ParsedArgs): boolean {
  return parsed.flags.json === true;
}

export function printJson(io: RelayIo | undefined, value: unknown): void {
  relayLog(io, JSON.stringify(value, null, 2));
}

export async function confirmRelayAction(
  io: RelayIo | undefined,
  parsed: ParsedArgs,
  message: string
): Promise<boolean> {
  if (io?.confirm) return await io.confirm();
  if (parsed.flags.yes === true) return true;
  const { isInteractiveStdin, promptConfirm } = await import('../lib/prompt');
  if (!isInteractiveStdin()) {
    throw new Error('refusing without confirmation: stdin is not a TTY, pass --yes');
  }
  return await promptConfirm({ nonInteractive: false }, message, false);
}
