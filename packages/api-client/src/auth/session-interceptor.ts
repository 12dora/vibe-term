// 401 统一拦截（设计 §4「身份与入口」）：
//   * 全局 401（entry 自身未登录）→ 派发 `auth:required` 并跳 `/login?next=`
//   * `/n/:id/*` 转发回来的 401 `{code:'NODE_LOGIN_REQUIRED', nodeId}` → 只派发事件，
//     由该 node 所在的行/侧边栏显示「登录此节点」，绝不把整页踢去登录页。
//   * 登录仪式自身的 401 → 什么都不做，见 `isLoginCeremonyPath`。

import { type ResponseHook, addResponseHook, urlPathname } from '../client';
import { SELF_NODE_ID, isValidNodeId } from '../node-url';
import { NODE_LOGIN_REQUIRED } from './types';

export const AUTH_REQUIRED_EVENT = 'auth:required';

export interface AuthRequiredDetail {
  /** 需要登录的目标 node；全局 401 时为 `self`。 */
  nodeId: string;
  /** `global` = entry 未登录（会跳登录页）；`node` = 单个 node 未登录。 */
  scope: 'global' | 'node';
  /** 触发的请求路径（含 `/n/:id` 前缀）。 */
  path: string;
}

export type AuthRequiredListener = (detail: AuthRequiredDetail) => void;

const listeners = new Set<AuthRequiredListener>();

export function onAuthRequired(listener: AuthRequiredListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(detail: AuthRequiredDetail): void {
  for (const listener of [...listeners]) {
    try {
      listener(detail);
    } catch {
      // 监听方异常不得阻断其余监听者
    }
  }
  const target = globalThis as { dispatchEvent?: (event: Event) => boolean };
  if (typeof target.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
    target.dispatchEvent(new CustomEvent<AuthRequiredDetail>(AUTH_REQUIRED_EVENT, { detail }));
  }
}

export interface SessionInterceptorOptions {
  /** 全局 401 的跳转实现（fe 注入 react-router navigate）。缺省用 location.assign。 */
  navigate?: (to: string) => void;
  /** 当前地址，用于拼 `?next=`。缺省读 location。 */
  currentLocation?: () => string;
  /** 登录页路径，默认 `/login`。 */
  loginPath?: string;
}

let options: SessionInterceptorOptions = {};

export function configureSessionInterceptor(next: SessionInterceptorOptions): void {
  options = { ...options, ...next };
}

function defaultCurrentLocation(): string {
  if (typeof location === 'undefined') return '/';
  return `${location.pathname}${location.search}${location.hash}`;
}

function loginUrl(): string {
  const loginPath = options.loginPath ?? '/login';
  const next = (options.currentLocation ?? defaultCurrentLocation)();
  if (!next || next.startsWith(loginPath)) return loginPath;
  return `${loginPath}?next=${encodeURIComponent(next)}`;
}

function goToLogin(): void {
  const url = loginUrl();
  if (options.navigate) {
    options.navigate(url);
    return;
  }
  if (typeof location !== 'undefined' && typeof location.assign === 'function') {
    location.assign(url);
  }
}

/**
 * 从 `/n/<id>/api/...` 里取出 nodeId；无前缀即 entry 自身。
 * 传入的必须是**已拼上 baseUrl 的**路径（`ResponseHookContext.pathname`），
 * 否则每 node runtime 的相对路径会被误判成 self。
 */
export function nodeIdFromPath(path: string): string {
  const match = /^\/n\/([^/?#]+)(?:[/?#]|$)/.exec(urlPathname(path));
  if (!match) return SELF_NODE_ID;
  let raw: string;
  try {
    raw = decodeURIComponent(match[1]);
  } catch {
    return SELF_NODE_ID;
  }
  // 不是规范 node id 的前缀不可信，按 self 处理（真正的路径拼接侧已由 assertNodeId 拦截）。
  return isValidNodeId(raw) ? raw : SELF_NODE_ID;
}

/**
 * 登录仪式自身的端点。
 *
 * 它们的 401 是**这一次登录尝试**的结论（密码不对、缺通行密钥二次验证……），而不是
 * 「手上这份会话失效了」。当成后者会把整页踢去登录页：常规改密后的重新登录必然先撞一次
 * `401 PASSKEY_REQUIRED`（服务端据此索要二次验证），调用方正准备补一次仪式再登一次，
 * 页面却已经被导航走、连同还在进行的编排一起卸载掉。
 *
 * 真正「会话没了」的信号来自别的路径：任何需要会话的业务端点的 401，以及 WS 的 4401。
 */
const LOGIN_CEREMONY_PATHS = new Set([
  '/api/auth/challenge',
  '/api/auth/login',
  '/api/auth/passkey/login/options',
]);

function isRelayRejection(code: unknown): boolean {
  return typeof code === 'string' && code.startsWith('RELAY_');
}

function isLoginCeremonyPath(path: string): boolean {
  return LOGIN_CEREMONY_PATHS.has(urlPathname(path));
}

type ErrorBody = { code?: unknown; nodeId?: unknown };

const warnedForeignNodeIds = new Set<string>();

/**
 * 决定 NODE_LOGIN_REQUIRED 该记到哪个 node 上。
 *
 * 路径带 `/n/:id` 时以路径为准：hub 转发的 401 可能把 hub 自己的 nodeId 写进 body
 * （实测 `/n/<A>/api/rtc/authorize` 回 `{nodeId: <hub>}`），认 body 会把「需要登录」
 * 记到无关的 node 行上，进而拆掉那棵 runtime 子树。
 * 路径不带前缀时才信 body：那是 entry 本地端点代某个 node 作答（如升级服务的转发调用）。
 */
function resolveNodeLoginTarget(bodyNodeId: unknown, path: string): string {
  const urlNodeId = nodeIdFromPath(path);
  const claimed = typeof bodyNodeId === 'string' ? bodyNodeId : null;
  if (urlNodeId === SELF_NODE_ID) return claimed ?? SELF_NODE_ID;
  if (claimed && claimed !== urlNodeId) warnForeignNodeId(claimed, urlNodeId, path);
  return urlNodeId;
}

function warnForeignNodeId(claimed: string, urlNodeId: string, path: string): void {
  const pair = `${urlNodeId}<-${claimed}`;
  if (warnedForeignNodeIds.has(pair)) return;
  warnedForeignNodeIds.add(pair);
  console.warn(
    `[session-interceptor] NODE_LOGIN_REQUIRED body nodeId ${claimed} does not match path node ${urlNodeId} (${path}); using the path node`
  );
}

/**
 * 处理一次 401 响应。导出以便测试与 WS 4401 关闭码复用（WS 侧没有 Response，
 * 直接调 `handleNodeLoginRequired` / `handleGlobalUnauthorized`）。
 */
export async function handleUnauthorized(res: Response, path: string): Promise<void> {
  let body: ErrorBody = {};
  try {
    // 只读一份克隆，绝不消费调用方要用的 body。
    body = (await res.clone().json()) as ErrorBody;
  } catch {
    body = {};
  }
  if (body.code === NODE_LOGIN_REQUIRED) {
    emit({ nodeId: resolveNodeLoginTarget(body.nodeId, path), scope: 'node', path });
    return;
  }
  const nodeId = nodeIdFromPath(path);
  if (nodeId !== SELF_NODE_ID) {
    // 没有 code 的转发 401 同样只影响该 node。
    emit({ nodeId, scope: 'node', path });
    return;
  }
  // 登录仪式自身的 401：这次尝试的结论归调用方处理，绝不能当成「当前会话失效」。
  if (isLoginCeremonyPath(path)) return;
  // 本机代为访问上级中继时把中继的拒绝原样透传（`RELAY_BAD_PROOF` 等）：那是中继不认凭据，
  // 本机会话仍然有效，不能把整页踢去登录页。
  if (isRelayRejection(body.code)) return;
  emit({ nodeId: SELF_NODE_ID, scope: 'global', path });
  goToLogin();
}

/** WS 关闭码 4401 复用同一套语义。 */
export function handleNodeLoginRequired(nodeId: string, path = ''): void {
  emit({ nodeId, scope: 'node', path });
}

export function handleGlobalUnauthorized(path = ''): void {
  emit({ nodeId: SELF_NODE_ID, scope: 'global', path });
  goToLogin();
}

export const sessionResponseHook: ResponseHook = (res, ctx) => {
  if (res.status !== 401) return;
  // 必须用 pathname（含 baseUrl）而不是调用方相对 path，否则 node runtime 的 401 会被
  // 当成 entry 自身未登录，把整页踢去登录页。
  void handleUnauthorized(res, ctx.pathname);
};

let uninstall: (() => void) | null = null;

/** 挂到 `ApiClient` 全局响应钩子上；重复调用幂等。 */
export function installSessionInterceptor(next?: SessionInterceptorOptions): () => void {
  if (next) configureSessionInterceptor(next);
  if (!uninstall) {
    const remove = addResponseHook(sessionResponseHook);
    uninstall = () => {
      remove();
      uninstall = null;
    };
  }
  return () => uninstall?.();
}

export function uninstallSessionInterceptor(): void {
  uninstall?.();
}
