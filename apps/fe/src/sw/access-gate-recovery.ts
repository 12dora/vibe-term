import { ensureAuthMode, getMeshNodesState } from '@/node/mesh-nodes-store';

// 服务端导航门与缓存壳的冲突兜底。
//
// SW 的导航策略已经把 600 ms 预算让给网络（Cloudflare Access 302、guardEntryAccess 403、
// 域名访问 403 都能在预算内接管）。但网络慢到超预算时，用户拿到的是缓存壳，随后应用的第一批
// API 调用才撞上 403——这时页面已经是「登录界面」而不是服务端自己的拒绝页。
// 这里在 api-client 的响应钩子上盯住启动期的 403：认出访问门的错误码就注销 SW 并整页刷新一次
// （sessionStorage 守卫，杜绝刷新循环），让服务端的页面自己出来。
//
// Cloudflare Access 的 302 跳到别的源，根本到不了响应钩子，另有一次性的 redirect:'manual' 探测。
// 两条路径都只在被 SW 控制时启用；观察者看到第一个非 403 的 /api 响应就自卸，正常启动几乎零开销。

/** 隧道访问门（apps/gateway/src/tunnel/access-guard.ts） */
const ACCESS_DENIED_CODE = 'access_denied';
/** 域名访问开关（apps/gateway/src/api/domain-access-routes.ts） */
const DOMAIN_ACCESS_DISABLED_CODE = 'DOMAIN_ACCESS_DISABLED';

const RELOAD_GUARD_KEY = 'vibeterm.access-gate-reloaded';

const GATE_CODES: readonly string[] = [ACCESS_DENIED_CODE, DOMAIN_ACCESS_DISABLED_CODE];

/** 探测用的启动期接口：随便哪个都行，选它是因为登录前后都会被调用 */
export const GATE_PROBE_PATH = '/api/auth/mode';

/**
 * 403 响应体是否来自服务端的访问门（而不是业务自己的权限不足）。只按错误信封精确比对
 * `error.code`，不做子串兜底：业务响应里恰好带上这些词就被误判成访问门的代价是整个注销 SW。
 *
 * 本函数只用在 `/api/**` 的响应钩子上，而这条路径必定拿到 JSON——
 * `decideDomainAccess` 对 `/api/` 前缀恒返回 `deny-json`（apps/gateway/src/mesh/
 * domain-access-policy.ts 的 `isJsonDeniedPath`），域名访问关闭时的纯文本页
 * （`DOMAIN_ACCESS_DISABLED_TEXT`）只会出现在导航请求上，那一档由 SW 的导航预算直接放行网络。
 * 因此解析不出信封的 403 一律不当访问门。
 */
export function isAccessGateBody(body: string): boolean {
  try {
    const code = (JSON.parse(body) as { error?: { code?: unknown } } | null)?.error?.code;
    return typeof code === 'string' && GATE_CODES.includes(code);
  } catch {
    return false;
  }
}

/**
 * Cloudflare Access 的 302 跳到自己的登录域：跨源重定向根本到不了响应钩子
 * （默认 redirect:'follow' 直接 reject）。所以启动时单独探一次，用 redirect:'manual'
 * 把跳转变成可观察的 opaqueredirect。
 *
 * 注意 opaqueredirect 是不透明的：拿不到 Location，也就分不出「跳去 Access 登录域」和
 * 「同源的某个 302」。这里一律按被门挡住处理——`/api/auth/mode` 正常返回 200 JSON，
 * 任何重定向都说明请求没走到网关自己手里；误判的代价被 sessionStorage 的每会话一次守卫兜住
 * （最多多注销一次 SW、多刷一次页，下次冷启动照常重装）。
 *
 * 只认「解析出来的响应」：fetch 直接 reject 更可能是离线，而离线恰恰是缓存壳该发挥作用的时候，
 * 绝不能因此把 SW 注销掉。
 */
export function isAccessGateProbeResponse(type: string, status: number): boolean {
  return type === 'opaqueredirect' || type === 'error' || status === 0;
}

export interface AccessGateRecoveryDeps {
  unregisterAll: () => Promise<void>;
  reload: () => void;
  readGuard: () => string | null;
  writeGuard: () => void;
}

/** 每会话至多一次：注销 SW 后刷新；已经刷过就不再刷（服务端页面本身就该显示出来了） */
export async function recoverFromAccessGate(deps: AccessGateRecoveryDeps): Promise<boolean> {
  if (deps.readGuard() === '1') return false;
  deps.writeGuard();
  await deps.unregisterAll().catch(() => undefined);
  deps.reload();
  return true;
}

export interface AccessGateWatchDeps extends AccessGateRecoveryDeps {
  /** api-client 的响应钩子注册函数，返回反注册 */
  addResponseHook: (hook: (res: Response, ctx: { pathname: string }) => void) => () => void;
  /** 页面当前是否被 SW 控制；未被控制时没有缓存壳可言，不必观察 */
  controlled: boolean;
  /** 探测用的 fetch（redirect:'manual'），只在被 SW 控制时发一次 */
  probe: () => Promise<{ type: string; status: number }>;
  /**
   * 复用 in-flight 的 `ensureAuthMode`（同一条 `/api/auth/mode`）。
   * 成功（拿到 mode）就不必再探；失败才用 redirect:'manual' 分辨 Access 302。
   */
  awaitMode?: () => Promise<boolean>;
}

/**
 * 启动时探一次访问门。命中就注销 SW 并刷新（与响应钩子共用同一个 once 守卫，
 * 两条路径同时命中也只刷一次）。
 */
export async function probeAccessGate(deps: AccessGateWatchDeps): Promise<boolean> {
  if (!deps.controlled) return false;
  if (deps.awaitMode) {
    try {
      if (await deps.awaitMode()) return false;
    } catch {
      // mode 拉失败：可能是 Access 302，落到下面的 manual 探测
    }
  }
  let result: { type: string; status: number };
  try {
    result = await deps.probe();
  } catch {
    // reject 多半是离线：离线正是缓存壳该顶上的场景，不做任何处置
    return false;
  }
  if (!isAccessGateProbeResponse(result.type, result.status)) return false;
  return recoverFromAccessGate(deps);
}

/** 页面启动时装上两条兜底：一次性的 302 探测 + 响应钩子上的 403 观察 */
export function installAccessGateGuards(deps: AccessGateWatchDeps): () => void {
  void probeAccessGate(deps);
  return watchAccessGate(deps);
}

/**
 * 装上启动期观察者，返回卸载函数。命中访问门 → 注销 SW + 刷新；
 * 第一个非 403 的 /api 响应说明启动正常，立即自卸。
 */
export function watchAccessGate(deps: AccessGateWatchDeps): () => void {
  if (!deps.controlled) return () => undefined;
  let removed = false;
  const remove = deps.addResponseHook((res, ctx) => {
    if (removed || !ctx.pathname.startsWith('/api/')) return;
    if (res.status !== 403) {
      removed = true;
      remove();
      return;
    }
    removed = true;
    remove();
    void res
      .clone()
      .text()
      .then((body) => {
        if (isAccessGateBody(body)) void recoverFromAccessGate(deps);
      })
      .catch(() => undefined);
  });
  return () => {
    removed = true;
    remove();
  };
}

async function unregisterAllServiceWorkers(): Promise<void> {
  const nav = (
    globalThis as {
      navigator?: {
        serviceWorker?: { getRegistrations(): Promise<readonly { unregister(): unknown }[]> };
      };
    }
  ).navigator;
  const registrations = (await nav?.serviceWorker?.getRegistrations()) ?? [];
  await Promise.all(registrations.map((registration) => registration.unregister()));
}

export function browserAccessGateDeps(
  addResponseHook: AccessGateWatchDeps['addResponseHook']
): AccessGateWatchDeps {
  const nav = (globalThis as { navigator?: { serviceWorker?: { controller?: unknown } } })
    .navigator;
  return {
    addResponseHook,
    controlled: Boolean(nav?.serviceWorker?.controller),
    awaitMode: async () => {
      await ensureAuthMode();
      return getMeshNodesState().mode !== null;
    },
    probe: () =>
      fetch(GATE_PROBE_PATH, { redirect: 'manual', credentials: 'include' }).then((res) => ({
        type: res.type,
        status: res.status,
      })),
    unregisterAll: unregisterAllServiceWorkers,
    reload: () => window.location.reload(),
    readGuard: () => {
      try {
        return globalThis.sessionStorage?.getItem(RELOAD_GUARD_KEY) ?? null;
      } catch {
        return null;
      }
    },
    writeGuard: () => {
      try {
        globalThis.sessionStorage?.setItem(RELOAD_GUARD_KEY, '1');
      } catch {
        // 隐私模式下 sessionStorage 不可用；此时最坏情况是多刷新一次
      }
    },
  };
}
