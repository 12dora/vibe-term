// 服务端导航门与缓存壳的冲突兜底。
//
// SW 的导航策略已经把 600 ms 预算让给网络（Cloudflare Access 302、guardEntryAccess 403、
// 域名访问 403 都能在预算内接管）。但网络慢到超预算时，用户拿到的是缓存壳，随后应用的第一批
// API 调用才撞上 403——这时页面已经是「登录界面」而不是服务端自己的拒绝页。
// 这里在 api-client 的响应钩子上盯住启动期的 403：认出访问门的错误码就注销 SW 并整页刷新一次
// （sessionStorage 守卫，杜绝刷新循环），让服务端的页面自己出来。
//
// 只在被 SW 控制时安装；看到第一个非 403 的 /api 响应就自行卸载，正常启动几乎零开销。

/** 隧道访问门（apps/gateway/src/tunnel/access-guard.ts） */
const ACCESS_DENIED_CODE = 'access_denied';
/** 域名访问开关（apps/gateway/src/api/domain-access-routes.ts） */
const DOMAIN_ACCESS_DISABLED_CODE = 'DOMAIN_ACCESS_DISABLED';

const RELOAD_GUARD_KEY = 'vibeterm.access-gate-reloaded';

/** 403 响应体是否来自服务端的访问门（而不是业务自己的权限不足） */
export function isAccessGateBody(body: string): boolean {
  return body.includes(ACCESS_DENIED_CODE) || body.includes(DOMAIN_ACCESS_DISABLED_CODE);
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
