// 远程访问（Cloudflare Tunnel）的纯推导：状态徽标、向导步进、主机名校验、错误与进度文案键。
// 全部与 React 无关，便于脱离 DOM 直接测。

import { TunnelApiError } from '@tmex/api-client/local/tunnel-api';
import type {
  LocalAuthStatus,
  TunnelActionRequest,
  TunnelConnectorStatus,
  TunnelErrorCode,
  TunnelMode,
  TunnelStatusResponse,
} from '@tmex/shared';
import {
  accessEffective,
  accessStepState,
  effectiveAccessMode,
  externalAccessState,
} from './access-model';
import { directProtected } from './direct-model';
import type { TunnelCheckResult } from './tunnel-actions';

// `accessEffective` 迁到 access-model（`accessStepState` 要用），这里原样转出，调用方不必改。
export { accessEffective } from './access-model';

export type TunnelPill =
  | 'notConfigured'
  | 'stopped'
  | 'starting'
  | 'running'
  | 'degraded'
  | 'error';

/** 连接器（cloudflared 本地 metrics `/ready`）的四态。 */
export type ConnectorState = 'connected' | 'noConnections' | 'unknown' | 'unprobed';

/** 旧后端没有 `connector` 字段：按「未探测」处理，不能因此判定为无连接。 */
export function connectorState(status: TunnelStatusResponse): ConnectorState {
  const connector: TunnelConnectorStatus | undefined = status.connector;
  if (!connector) return 'unprobed';
  if (connector.reachable === null) return connector.checkedAt === null ? 'unprobed' : 'unknown';
  // 探不到 metrics 端点只说明本机读不到这份指标，边缘连接可能好好的：一律「无法探测」。
  if (!connector.reachable) return 'unknown';
  const ready = connector.readyConnections;
  // 端点应答了却没给出连接数，说不上是「零连接」：宣告断线要有确凿的 0。
  if (typeof ready !== 'number' || !Number.isFinite(ready) || ready < 0) return 'unknown';
  return ready > 0 ? 'connected' : 'noConnections';
}

/** 降级警示里的错误明细：日志行可能很长，卡片上只留够定位问题的开头。 */
const DEGRADED_ERROR_MAX = 200;

export function degradedError(status: TunnelStatusResponse): string | null {
  const text = [status.process.lastError, status.connector?.lastError]
    .map((value) => (value ?? '').trim())
    .find((value) => value !== '');
  if (!text) return null;
  return text.length > DEGRADED_ERROR_MAX ? `${text.slice(0, DEGRADED_ERROR_MAX)}…` : text;
}

/** 进程 / 系统服务还活着（`degraded` 也算活着，只是没有边缘连接）。 */
function tunnelAlive(status: TunnelStatusResponse): boolean {
  if (status.config.externallyManaged) return status.external.running;
  return status.process.state === 'running' || status.process.state === 'degraded';
}

/**
 * 进程活着但没有任何边缘连接——公网地址此时不可达。后端的 `process.state` 是首要依据；
 * 外部托管的 cloudflared 那边只有「进程在不在」，只能靠连接器探测兜底。
 */
export function tunnelDegraded(status: TunnelStatusResponse): boolean {
  if (!tunnelAlive(status)) return false;
  return status.process.state === 'degraded' || connectorState(status) === 'noConnections';
}

/**
 * 进程报错优先于「未配置」：`remove` 之后若上一次失败仍留在 `process.lastError` 上，
 * 用户需要先看到错误而不是一个干净的「未配置」。
 */
export function tunnelPill(status: TunnelStatusResponse): TunnelPill {
  if (status.process.state === 'error') return 'error';
  if (status.config.mode === 'off') return 'notConfigured';
  if (tunnelAlive(status)) return tunnelDegraded(status) ? 'degraded' : 'running';
  // 接管来的隧道由系统服务跑，tmex 侧没有进程，运行态以探测结果为准。
  if (status.config.externallyManaged) return 'stopped';
  if (status.process.state === 'starting') return 'starting';
  return 'stopped';
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

/**
 * 状态卡上的访问保护徽标。它报的是**实际保护状态**，不是用户选了什么：先看 Access 校验有没有
 * 生效，再看有没有登录门；都没有时才按选定的方式解释「差在哪」——Access 这一档沿用诊断徽标，
 * 「账号密码」报登录门缺失，选了「无」或从没选过就是没有保护。
 * 所以选了「无」但 Access 应用仍在生效时，徽标照实报「已生效」。
 */
export type ProtectionPill = AccessPill | 'loginProtected' | 'loginMissing' | 'unprotected';

export function protectionPill(status: TunnelStatusResponse): ProtectionPill {
  if (accessEffective(status)) return 'protected';
  if (status.loginEnforced) return 'loginProtected';
  const mode = effectiveAccessMode(status);
  if (mode === 'cloudflare') return accessPill(status);
  return mode === 'login' ? 'loginMissing' : 'unprotected';
}

/**
 * 隧道正在对外提供服务：接管来的隧道以探测结果为准。
 * `degraded` 同样算在跑——进程还在，边缘连接随时可能恢复，拿掉最后一道保护一样危险。
 */
export function isTunnelRunning(status: TunnelStatusResponse): boolean {
  const pill = tunnelPill(status);
  return pill === 'running' || pill === 'starting' || pill === 'degraded';
}

/**
 * 隧道正在对外暴露，或随时会暴露——对齐后端 `requireLastProtectionAck` 的判定口径。
 * 接管来的隧道以探测结果为准，探测还在进行时一并算上（后端拿不到探测结论时同样会拦）；
 * 托管进程只要不是「已停止」就算，`error` 也在内：自启动超时会留下 `error`，但拉起意图
 * （后端的 `runningEnabled`）还在，状态里没有这一位，只能按暴露处理。
 */
export function tunnelExposed(status: TunnelStatusResponse): boolean {
  if (status.config.externallyManaged) {
    return status.external.running || status.external.probing === true;
  }
  if (status.config.mode === 'off') return false;
  return status.process.state !== 'stopped';
}

/**
 * 关闭强制校验 / 移除 Access 应用 / 把访问控制改成「无」会拿掉最后一道保护。
 * 判定与后端一致：隧道暴露着且本机没有登录就要确认，与 Access 当前是否生效无关——
 * 一个没生效的 Access 应用后端照样拦，前端提前把勾选摆出来，免得先白吃一个 409。
 */
export function wouldDropLastProtection(status: TunnelStatusResponse): boolean {
  return !status.loginEnforced && tunnelExposed(status);
}

export type WizardStepId =
  | 'path'
  | 'install'
  | 'mode'
  | 'login'
  | 'hostname'
  | 'access'
  | 'create'
  | 'quick'
  | 'direct'
  | 'tunnel'
  | 'proxy';

/**
 * 顶层连接方式：Cloudflare Tunnel 与「直接连接」是并列的两条路径，后者完全不碰 cloudflared。
 * 纯前端概念，永远不会写进 `status.config.mode`。
 */
export type ConnectionPath = 'tunnel' | 'direct';

/** 隧道分支里的子方式（临时 / 命名），与服务端 `TunnelMode` 同构。 */
export type WizardMode = TunnelMode;

export interface WizardContext {
  status: TunnelStatusResponse;
  /** 本地选择的连接方式；`null` = 还没选。 */
  chosenPath: ConnectionPath | null;
  /** 隧道分支里本地选择的子方式（尚未落库） */
  chosenMode: WizardMode | null;
  /** 主机名步骤已在本地确认——契约里没有单独保存主机名的动作，只能由向导自己记。 */
  hostnameConfirmed: boolean;
  /** `/api/auth/mode` 下发的本机登录状态；只有「直接连接」这条路径用得上。 */
  localAuth?: LocalAuthStatus | null;
}

const NAMED_STEPS: WizardStepId[] = [
  'path',
  'install',
  'mode',
  'login',
  'hostname',
  'access',
  'create',
  'proxy',
];
const QUICK_STEPS: WizardStepId[] = ['path', 'install', 'mode', 'quick', 'proxy'];
const TUNNEL_STEPS: WizardStepId[] = ['path', 'install', 'mode', 'tunnel', 'proxy'];
/** 直接连接不装 cloudflared、不建隧道，也就没有安装与反向代理两步。 */
const DIRECT_STEPS: WizardStepId[] = ['path', 'direct'];
/** 还没选连接方式：只给顶层的两张卡，不要摆出一串与直接连接无关的隧道步骤。 */
const PATH_ONLY_STEPS: WizardStepId[] = ['path'];

/** 步骤序列先随连接方式分叉，隧道分支内再随子方式变化。 */
export function wizardSteps(ctx: WizardContext): WizardStepId[] {
  const path = effectivePath(ctx.status, ctx.chosenPath);
  if (path === null) return PATH_ONLY_STEPS;
  if (path === 'direct') return DIRECT_STEPS;
  const mode = effectiveMode(ctx.status, ctx.chosenMode);
  if (mode === 'named') return NAMED_STEPS;
  if (mode === 'quick') return QUICK_STEPS;
  return TUNNEL_STEPS;
}

/**
 * 已经建过隧道（含接管来的）时连接方式由服务端锁死：要走直接连接必须先移除隧道。
 * 否则用本地选择，没选过就是 `null`。
 */
export function effectivePath(
  status: TunnelStatusResponse,
  chosenPath: ConnectionPath | null
): ConnectionPath | null {
  if (status.config.mode !== 'off') return 'tunnel';
  return chosenPath;
}

/**
 * 隧道分支里展示哪种子方式：已配置隧道时以服务端为准，否则用本地选择。
 */
export function effectiveMode(
  status: TunnelStatusResponse,
  chosenMode: WizardMode | null
): WizardMode {
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
  const path = effectivePath(status, ctx.chosenPath);
  const mode = effectiveMode(status, ctx.chosenMode);
  const ready = tunnelReady(status);
  const created = status.config.mode === 'named';

  switch (step) {
    case 'path':
      return path === null ? 'current' : 'done';
    case 'install':
      return ready ? 'done' : 'current';
    case 'mode':
      return modeStepState(mode, ready);
    case 'direct':
      return path === 'direct' ? directStepState(ctx.localAuth) : 'todo';
    case 'tunnel':
      return 'todo';
    case 'quick':
      return quickStepState(status, mode, ready);
    case 'login':
      if (!ready || mode !== 'named') return 'todo';
      return status.auth.loggedIn || created ? 'done' : 'current';
    case 'hostname':
      if (wizardStepState('login', ctx) !== 'done') return 'todo';
      return created || hostnameConfirmed ? 'done' : 'current';
    case 'access':
      // 与创建步同一条门槛：主机名没确认之前轮不到访问控制，步骤编号也就不会跳。
      return wizardStepState('hostname', ctx) === 'done'
        ? accessStepState(status, ctx.localAuth)
        : 'todo';
    case 'create':
      if (created) return 'done';
      return wizardStepState('hostname', ctx) === 'done' ? 'current' : 'todo';
    case 'proxy':
      return status.config.mode === 'off' ? 'todo' : 'current';
  }
}

/** 隧道类型步：cloudflared 没就位时还轮不到它，选定之后就打勾。 */
function modeStepState(mode: WizardMode, ready: boolean): StepState {
  if (!ready) return 'todo';
  return mode === 'off' ? 'current' : 'done';
}

/** 临时隧道那一步：只在隧道分支且选了临时隧道时活跃，落库即打勾。 */
function quickStepState(status: TunnelStatusResponse, mode: WizardMode, ready: boolean): StepState {
  if (!ready || mode !== 'quick') return 'todo';
  return status.config.mode === 'quick' ? 'done' : 'current';
}

/** 查到确实有登录门才算这一步做完；`localAuth` 缺失（旧后端）时停在当前步等用户确认。 */
function directStepState(localAuth: LocalAuthStatus | null | undefined): StepState {
  return directProtected(localAuth) ? 'done' : 'current';
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
  'connector_down',
  'busy',
  'not_configured',
  'invalid_request',
  'auth_required',
]);

/** 带 `{{message}}` 插值的错误文案：服务端的原始描述比通用句子更有用。 */
const ERROR_CODES_WITH_MESSAGE = new Set<TunnelErrorCode>(['access_api_failed', 'connector_down']);

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

export interface CheckNotice {
  tone: 'success' | 'warning' | 'error';
  testId: string;
  /** 主文案的键；`message` 非空时按 `{{message}}` 插值。 */
  key: string;
  message: string | null;
  /** 另起一行原样展示的服务端描述。 */
  detail: string | null;
}

const CHECK_PREFIX = 'settings.remoteAccess.check.';

/**
 * 检查结论的呈现。成功也分三档：边缘与本机都验过（`ok`）、被 Access 拦在边缘但连接器在线
 * （`access_protected`），以及被拦下且连接器探不到——后者证明不了本机可达，必须降成警示，
 * 否则又回到「检查通过但隧道其实是断的」那个坑。
 */
export function checkNotice(check: TunnelCheckResult): CheckNotice {
  if (!check.ok) {
    if (check.code === 'connector_down') {
      return {
        tone: 'error',
        testId: 'remote-access-check-failed',
        key: `${ERROR_PREFIX}connector_down`,
        message: check.message ?? '',
        detail: null,
      };
    }
    return {
      tone: 'error',
      testId: 'remote-access-check-failed',
      key: `${CHECK_PREFIX}unreachable`,
      message: null,
      detail: check.message,
    };
  }
  if (check.step === 'access_protected_unverified') {
    return {
      tone: 'warning',
      testId: 'remote-access-check-warning',
      key: `${CHECK_PREFIX}accessProtectedUnverified`,
      message: null,
      detail: check.message,
    };
  }
  const key = check.step === 'access_protected' ? 'accessProtected' : 'reachable';
  return {
    tone: 'success',
    testId: 'remote-access-check-ok',
    key: `${CHECK_PREFIX}${key}`,
    message: null,
    detail: check.message,
  };
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
  if (req.action === 'set_access_mode') return req.accessMode === 'none';
  return (
    req.action === 'create' ||
    req.action === 'quick_start' ||
    req.action === 'start' ||
    req.action === 'remove_access'
  );
}

/** 只有用户勾了这个动作旁边那条警示才带上 `acknowledgeExposure`，否则由后端 409 挡下。 */
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
