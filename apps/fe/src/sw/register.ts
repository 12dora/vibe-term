// SW 注册策略。生产：首帧之后趁空闲注册根作用域 /sw.js（安装期要下 ~10 MB，绝不能和首屏抢），
// 注册完再把「换代接管」接到浏览器事件上（见 ./sw-update.ts：不接管的话 iOS 主屏 PWA 会无限期
// 停在装机那一代的应用壳上）。
// 非生产：主动注销同源上已有的 SW——vite dev 与打包版共用 localhost 端口时，
// 旧 SW 会把 dev 页面的导航请求回放成过期的打包壳，症状是改代码不生效。

import { isSharePathname } from '@/share/share-route';
import { activateWaitingWorkerFromBrowser } from '@vibeterm/ui/sw-activation';
import {
  type SwUpdateRegistrationLike,
  browserSwUpdateGuard,
  createSwUpdateController,
  isShellStaleMessage,
} from './sw-update';

export const SERVICE_WORKER_URL = '/sw.js';

/**
 * 分享页是匿名一次性入口：给它装一整代应用壳缓存既没有复访收益，又会把 ~10 MB 塞进
 * 陌生访客的存储配额。非生产的注销分支不受影响——旧 SW 该清还是要清。
 */
export function shouldRegisterServiceWorker(pathname: string): boolean {
  return !isSharePathname(pathname);
}

export interface ServiceWorkerRegistrationLike {
  unregister(): Promise<boolean>;
}

export interface ServiceWorkerContainerLike {
  register(
    url: string,
    options?: { scope?: string }
  ): Promise<SwUpdateRegistrationLike | null | undefined>;
  getRegistrations(): Promise<readonly ServiceWorkerRegistrationLike[]>;
}

/** 注册成功时给出 registration（供换代接管接线），其余情况一律 null */
export async function applyServiceWorkerPolicy(
  container: ServiceWorkerContainerLike | undefined,
  isProd: boolean,
  pathname = '/'
): Promise<SwUpdateRegistrationLike | null> {
  if (!container) return null;
  try {
    if (!isProd) {
      const registrations = await container.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
      return null;
    }
    if (!shouldRegisterServiceWorker(pathname)) return null;
    return (await container.register(SERVICE_WORKER_URL, { scope: '/' })) ?? null;
  } catch {
    // 不支持 / 非安全上下文 / 隐私模式下注册失败都不该影响应用本身
    return null;
  }
}

interface SwMessageTargetLike {
  readonly controller: unknown;
  addEventListener(type: 'message', listener: (event: { data?: unknown }) => void): void;
}

/** 把换代接管接到浏览器事件上：SW 的 stale 消息、回到前台、bfcache 恢复 */
export function wireServiceWorkerUpdates(
  registration: SwUpdateRegistrationLike,
  container: SwMessageTargetLike | undefined
): void {
  const updates = createSwUpdateController({
    registration,
    hasController: () => Boolean(container?.controller),
    activate: activateWaitingWorkerFromBrowser,
    reload: () => window.location.reload(),
    now: () => Date.now(),
    ...browserSwUpdateGuard(),
  });
  container?.addEventListener('message', (event) => {
    if (isShellStaleMessage(event.data)) updates.onShellStale();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void updates.onSafeMoment();
    else updates.onHidden();
  });
  window.addEventListener('pageshow', (event) => {
    void updates.onSafeMoment({ persisted: (event as PageTransitionEvent).persisted });
  });
  void updates.start();
}

export function setupServiceWorker(): void {
  const nav = (
    globalThis as {
      navigator?: { serviceWorker?: ServiceWorkerContainerLike & SwMessageTargetLike };
    }
  ).navigator;
  const pathname = (globalThis as { location?: { pathname?: string } }).location?.pathname ?? '/';
  void applyServiceWorkerPolicy(nav?.serviceWorker, import.meta.env.PROD, pathname).then(
    (registration) => {
      if (registration) wireServiceWorkerUpdates(registration, nav?.serviceWorker);
    }
  );
}
