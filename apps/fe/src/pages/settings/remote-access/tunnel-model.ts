// 远程访问（Cloudflare Tunnel）的纯推导：状态徽标、向导步进、主机名校验、错误与进度文案键。
// 全部与 React 无关，便于脱离 DOM 直接测。

import { TunnelApiError } from '@tmex/api-client/local/tunnel-api';
import type {
  TunnelActionRequest,
  TunnelErrorCode,
  TunnelMode,
  TunnelStatusResponse,
} from '@tmex/shared';
import { externalAccessState } from './access-model';

export type TunnelPill = 'notConfigured' | 'stopped' | 'starting' | 'running' | 'error';

/**
 * 进程报错优先于「未配置」：`remove` 之后若上一次失败仍留在 `process.lastError` 上，
 * 用户需要先看到错误而不是一个干净的「未配置」。
 */
export function tunnelPill(status: TunnelStatusResponse): TunnelPill {
  if (status.process.state === 'error') return 'error';
  if (status.config.mode === 'off') return 'notConfigured';
  // 接管来的隧道由系统服务跑，tmex 侧没有进程，运行态以探测结果为准。
  if (status.config.externallyManaged) return status.external.running ? 'running' : 'stopped';
  if (status.process.state === 'running') return 'running';
  if (status.process.state === 'starting') return 'starting';
  return 'stopped';
}

/**
 * Access 校验是否真的生效。后端 `access.effective` 是唯一真相；旧后端没有这个字段时
 * 用同一条谓词兜底：应用已建、网关强制校验，且应用覆盖的主机名就是当前隧道的主机名
 * （两边都为空不算匹配——没有隧道就谈不上保护）。
 */
export function accessEffective(status: TunnelStatusResponse): boolean {
  const access: { effective?: boolean } = status.access;
  return (
    access.effective ??
    Boolean(
      status.access.configured &&
        status.access.enforceJwt &&
        status.access.hostname &&
        status.access.hostname === status.config.hostname
    )
  );
}

/**
 * Access 徽标。前三档是 tmex 托管的应用（`access.configured`）：不校验令牌 / 绑了别的主机名 / 校验已生效。
 * 后两档来自只读探测，只在 tmex 没有托管应用时出现：
 * `dashboardCovered` = Cloudflare 控制台上已有应用覆盖这个主机名（tmex 不校验令牌）；
 * `unknown` = 有主机名但查不了（没有可用凭证或 API 失败），与「查过了，确实没有」必须区分。
 */
export type AccessPill =
  | 'notConfigured'
  | 'unknown'
  | 'dashboardCovered'
  | 'notEnforced'
  | 'hostnameMismatch'
  | 'protected';

/** 有主机名才谈得上「有没有被 Access 覆盖」：什么都没配时「未配置」就是准确的。 */
function hasCoverableHostname(status: TunnelStatusResponse): boolean {
  return status.config.hostname !== null || status.external.hostnames.length > 0;
}

export function accessPill(status: TunnelStatusResponse): AccessPill {
  if (status.access.configured) {
    if (!status.access.enforceJwt) return 'notEnforced';
    return accessEffective(status) ? 'protected' : 'hostnameMismatch';
  }
  const probed = externalAccessState(status);
  if (probed === 'covered') return 'dashboardCovered';
  return probed === 'unknown' && hasCoverableHostname(status) ? 'unknown' : 'notConfigured';
}

/** 隧道正在对外提供服务：接管来的隧道以探测结果为准。 */
export function isTunnelRunning(status: TunnelStatusResponse): boolean {
  const pill = tunnelPill(status);
  return pill === 'running' || pill === 'starting';
}

/**
 * 关闭强制校验 / 移除 Access 应用会拿掉最后一道保护：隧道正在跑、本机没有登录，
 * 而当前唯一的保护就是生效中的 Access。此时动作必须带上用户的显式确认。
 */
export function wouldDropLastProtection(status: TunnelStatusResponse): boolean {
  return !status.loginEnforced && isTunnelRunning(status) && accessEffective(status);
}

export type WizardStepId =
  | 'install'
  | 'mode'
  | 'login'
  | 'hostname'
  | 'access'
  | 'create'
  | 'quick'
  | 'tunnel'
  | 'proxy';

export interface WizardContext {
  status: TunnelStatusResponse;
  /** 本地选择的方式（尚未落库） */
  chosenMode: TunnelMode | null;
  /** 主机名步骤已在本地确认——契约里没有单独保存主机名的动作，只能由向导自己记。 */
  hostnameConfirmed: boolean;
}

const NAMED_STEPS: WizardStepId[] = [
  'install',
  'mode',
  'login',
  'hostname',
  'access',
  'create',
  'proxy',
];
const QUICK_STEPS: WizardStepId[] = ['install', 'mode', 'quick', 'proxy'];
const UNDECIDED_STEPS: WizardStepId[] = ['install', 'mode', 'tunnel', 'proxy'];

/** 步骤序列随方式变化：临时隧道没有登录 / 主机名 / 访问控制。 */
export function wizardSteps(ctx: WizardContext): WizardStepId[] {
  const mode = effectiveMode(ctx.status, ctx.chosenMode);
  if (mode === 'named') return NAMED_STEPS;
  if (mode === 'quick') return QUICK_STEPS;
  return UNDECIDED_STEPS;
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

function tunnelReady(status: TunnelStatusResponse): boolean {
  return status.binary.installed || status.config.externallyManaged;
}

/**
 * 每一步单独判定，不按下标推：访问控制是可选步骤，永远不会成为「当前」，
 * 也不应该因为排在创建之前就被算成已完成。
 */
export function wizardStepState(step: WizardStepId, ctx: WizardContext): StepState {
  const { status, hostnameConfirmed } = ctx;
  const mode = effectiveMode(status, ctx.chosenMode);
  const ready = tunnelReady(status);
  const created = status.config.mode === 'named';

  switch (step) {
    case 'install':
      return ready ? 'done' : 'current';
    case 'mode':
      if (!ready) return 'todo';
      return mode === 'off' ? 'current' : 'done';
    case 'tunnel':
      return 'todo';
    case 'quick':
      if (!ready || mode !== 'quick') return 'todo';
      return status.config.mode === 'quick' ? 'done' : 'current';
    case 'login':
      if (!ready || mode !== 'named') return 'todo';
      return status.auth.loggedIn || created ? 'done' : 'current';
    case 'hostname':
      if (wizardStepState('login', ctx) !== 'done') return 'todo';
      return created || hostnameConfirmed ? 'done' : 'current';
    case 'access':
      return status.access.configured ? 'done' : 'todo';
    case 'create':
      if (created) return 'done';
      return wizardStepState('hostname', ctx) === 'done' ? 'current' : 'todo';
    case 'proxy':
      return status.config.mode === 'off' ? 'todo' : 'current';
  }
}

const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** RFC 1123 主机名（只接受小写），且至少两级——Cloudflare 只能给托管域名下的子域配 DNS。 */
export function isValidHostname(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false;
  const labels = value.split('.');
  if (labels.length < 2) return false;
  return labels.every((label) => label.length <= 63 && HOSTNAME_LABEL.test(label));
}

/**
 * 隧道名称：与后端一致的 `^[a-z0-9](?:[a-z0-9_-]{0,62})$`。名称会直接拼成凭证文件名，
 * 斜杠与 `..` 必须挡在外面；这里只做即时反馈，真正的把关在后端。
 */
const TUNNEL_NAME = /^[a-z0-9](?:[a-z0-9_-]{0,62})$/;

export function isValidTunnelName(value: string): boolean {
  return TUNNEL_NAME.test(value);
}

/** 与后端 `manager.ts` 里 `step(...)` 实际发出的标识一一对应。 */
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
  'create_app',
  'policy',
  'delete_app',
  'sync',
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
  'access_api_failed',
  'exposure_ack_required',
  'process_failed',
  'busy',
  'not_configured',
  'invalid_request',
  'auth_required',
]);

/** 带 `{{message}}` 插值的错误文案：服务端的原始描述比通用句子更有用。 */
const ERROR_CODES_WITH_MESSAGE = new Set<TunnelErrorCode>(['access_api_failed']);

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
  if (!key) return t(`${ERROR_PREFIX}unknown`, { message: error.message });
  if (ERROR_CODES_WITH_MESSAGE.has(error.code)) return t(key, { message: error.message });
  return t(key);
}

/**
 * `trustProxy` 是当前进程的生效值，`configuredTrustProxy` 是已写进 app.env 的期望值：
 * 两者不一致就必须重启才算数。后端也给了 `restartRequired`，这里两条都认，避免旧后端漏报。
 */
export function trustProxyRestartRequired(status: TunnelStatusResponse): boolean {
  return status.restartRequired || status.configuredTrustProxy !== status.trustProxy;
}

/** 旧后端在本机未启用登录时会直接拒绝创建隧道（`auth_required`）：动作错误与 job 错误都要认。 */
export function isAuthRequiredError(
  status: TunnelStatusResponse,
  error: TunnelError | null
): boolean {
  return error?.code === 'auth_required' || status.job?.error?.code === 'auth_required';
}

type ExposingAction = Extract<TunnelActionRequest, { acknowledgeExposure?: boolean }>;

/**
 * 会把 tmex 开放到公网的动作：未受保护时必须带上用户的显式确认。
 * 开隧道是一类；拿掉最后一道保护（关掉令牌校验、删掉 Access 应用）是同一件事的另一半。
 */
export function isExposingAction(req: TunnelActionRequest): req is ExposingAction {
  if (req.action === 'set_auto_start') return req.autoStart;
  if (req.action === 'set_access_enforce') return !req.enforceJwt;
  return (
    req.action === 'create' ||
    req.action === 'quick_start' ||
    req.action === 'start' ||
    req.action === 'remove_access'
  );
}

/** 只有用户勾了「我了解风险」才带上 `acknowledgeExposure`，否则由后端 409 挡下。 */
export function withExposureAck(
  req: TunnelActionRequest,
  acknowledged: boolean
): TunnelActionRequest {
  if (!acknowledged || !isExposingAction(req)) return req;
  return { ...req, acknowledgeExposure: true };
}

export function isExposureAckError(
  status: TunnelStatusResponse,
  error: TunnelError | null
): boolean {
  return (
    error?.code === 'exposure_ack_required' || status.job?.error?.code === 'exposure_ack_required'
  );
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
