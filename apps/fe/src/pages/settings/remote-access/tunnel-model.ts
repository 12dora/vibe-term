// 远程访问（Cloudflare Tunnel）的纯推导：状态徽标、向导步进、主机名校验、错误与进度文案键。
// 全部与 React 无关，便于脱离 DOM 直接测。

import { TunnelApiError } from '@tmex/api-client/local/tunnel-api';
import type { TunnelErrorCode, TunnelMode, TunnelStatusResponse } from '@tmex/shared';

export type TunnelPill = 'notConfigured' | 'stopped' | 'starting' | 'running' | 'error';

/**
 * 进程报错优先于「未配置」：`remove` 之后若上一次失败仍留在 `process.lastError` 上，
 * 用户需要先看到错误而不是一个干净的「未配置」。
 */
export function tunnelPill(status: TunnelStatusResponse): TunnelPill {
  if (status.process.state === 'error') return 'error';
  if (status.config.mode === 'off') return 'notConfigured';
  if (status.process.state === 'running') return 'running';
  if (status.process.state === 'starting') return 'starting';
  return 'stopped';
}

export type WizardStep = 1 | 2 | 3 | 4;

/**
 * 当前所处步骤。`chosenMode` 是本地选择（尚未落库），只在还没配置出隧道时参与判断：
 * 一旦 `config.mode` 有值，方式就以服务端为准。
 */
export function currentWizardStep(
  status: TunnelStatusResponse,
  chosenMode: TunnelMode | null
): WizardStep {
  if (!status.binary.installed) return 1;
  if (status.config.mode !== 'off') return 4;
  return chosenMode === 'quick' || chosenMode === 'named' ? 3 : 2;
}

/** 步骤 3 展示哪条路径：已配置时以服务端为准，否则用本地选择。 */
export function effectiveMode(
  status: TunnelStatusResponse,
  chosenMode: TunnelMode | null
): TunnelMode {
  if (status.config.mode !== 'off') return status.config.mode;
  return chosenMode ?? 'off';
}

export type StepState = 'todo' | 'current' | 'done';

export function stepState(step: WizardStep, current: WizardStep): StepState {
  if (step === current) return 'current';
  return step < current ? 'done' : 'todo';
}

const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** RFC 1123 主机名（只接受小写），且至少两级——Cloudflare 只能给托管域名下的子域配 DNS。 */
export function isValidHostname(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false;
  const labels = value.split('.');
  if (labels.length < 2) return false;
  return labels.every((label) => label.length <= 63 && HOSTNAME_LABEL.test(label));
}

/** 与后端 `manager.ts` 里 `step(...)` 实际发出的标识一一对应。 */
/**
 * 隧道名称：与后端一致的 `^[a-z0-9](?:[a-z0-9_-]{0,62})$`。名称会直接拼成凭证文件名，
 * 斜杠与 `..` 必须挡在外面；这里只做即时反馈，真正的把关在后端。
 */
const TUNNEL_NAME = /^[a-z0-9](?:[a-z0-9_-]{0,62})$/;

export function isValidTunnelName(value: string): boolean {
  return TUNNEL_NAME.test(value);
}

const JOB_STEPS = new Set([
  'download',
  'extract',
  'verify',
  'login',
  'wait_cert',
  'cancelled',
  'create',
  'create_tunnel',
  'route_dns',
  'start',
  'check',
  'ok',
]);

/** 已知进度标识返回文案键；未知返回 null（由调用方原样展示服务端给的标识）。 */
export function jobStepKey(step: string | null): string | null {
  return step && JOB_STEPS.has(step) ? `settings.remoteAccess.jobStep.${step}` : null;
}

const ERROR_PREFIX = 'settings.remoteAccess.errors.';

const ERROR_CODES = new Set<TunnelErrorCode>([
  'unsupported_platform',
  'binary_missing',
  'download_failed',
  'not_logged_in',
  'login_timeout',
  'invalid_hostname',
  'tunnel_exists',
  'dns_route_failed',
  'process_failed',
  'busy',
  'not_configured',
  'invalid_request',
  'auth_required',
]);

export function tunnelErrorKey(code: string): string | null {
  return ERROR_CODES.has(code as TunnelErrorCode) ? `${ERROR_PREFIX}${code}` : null;
}

export interface TunnelError {
  code: TunnelErrorCode;
  message: string;
}

export function toTunnelError(error: unknown): TunnelError {
  if (error instanceof TunnelApiError) {
    return { code: error.code, message: error.message || error.code };
  }
  return { code: 'unknown', message: error instanceof Error ? error.message : String(error) };
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 已知错误码走本地化文案；未知码退化成「操作失败 + 服务端 message」。 */
export function describeTunnelError(t: Translate, error: TunnelError): string {
  const key = tunnelErrorKey(error.code);
  if (key) return t(key);
  return t(`${ERROR_PREFIX}unknown`, { message: error.message });
}

/**
 * `trustProxy` 是当前进程的生效值，`configuredTrustProxy` 是已写进 app.env 的期望值：
 * 两者不一致就必须重启才算数。后端也给了 `restartRequired`，这里两条都认，避免旧后端漏报。
 */
export function trustProxyRestartRequired(status: TunnelStatusResponse): boolean {
  return status.restartRequired || status.configuredTrustProxy !== status.trustProxy;
}

/** 本机没开登录时后端会拒绝创建隧道（`auth_required`）：动作错误与 job 错误都要认。 */
export function isAuthRequiredError(
  status: TunnelStatusResponse,
  error: TunnelError | null
): boolean {
  return error?.code === 'auth_required' || status.job?.error?.code === 'auth_required';
}

export const TUNNEL_ACTIVE_POLL_MS = 2000;
export const TUNNEL_IDLE_POLL_MS = 10_000;

/** job 在跑或进程正在起来时 2 秒一拉，其余 10 秒。 */
export function tunnelPollInterval(status: TunnelStatusResponse | null | undefined): number {
  if (!status) return TUNNEL_IDLE_POLL_MS;
  const active = status.job?.state === 'running' || status.process.state === 'starting';
  return active ? TUNNEL_ACTIVE_POLL_MS : TUNNEL_IDLE_POLL_MS;
}

/** 日志框只保留末尾若干行：cloudflared 的输出会一直增长，整段渲染会拖垮设置页。 */
export const LOG_TAIL_LINES = 200;

export function logTail(log: string[]): string[] {
  return log.length > LOG_TAIL_LINES ? log.slice(-LOG_TAIL_LINES) : log;
}
