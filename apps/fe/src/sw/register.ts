// SW 注册策略。生产：首帧之后趁空闲注册根作用域 /sw.js（安装期要下 ~10 MB，绝不能和首屏抢）。
// 非生产：主动注销同源上已有的 SW——vite dev 与打包版共用 localhost 端口时，
// 旧 SW 会把 dev 页面的导航请求回放成过期的打包壳，症状是改代码不生效。

import { isSharePathname } from '@/share/share-route';

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
  register(url: string, options?: { scope?: string }): Promise<unknown>;
  getRegistrations(): Promise<readonly ServiceWorkerRegistrationLike[]>;
}

export async function applyServiceWorkerPolicy(
  container: ServiceWorkerContainerLike | undefined,
  isProd: boolean,
  pathname = '/'
): Promise<void> {
  if (!container) return;
  try {
    if (!isProd) {
      const registrations = await container.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
      return;
    }
    if (!shouldRegisterServiceWorker(pathname)) return;
    await container.register(SERVICE_WORKER_URL, { scope: '/' });
  } catch {
    // 不支持 / 非安全上下文 / 隐私模式下注册失败都不该影响应用本身
  }
}

export function setupServiceWorker(): void {
  const nav = (globalThis as { navigator?: { serviceWorker?: ServiceWorkerContainerLike } })
    .navigator;
  const pathname = (globalThis as { location?: { pathname?: string } }).location?.pathname ?? '/';
  void applyServiceWorkerPolicy(nav?.serviceWorker, import.meta.env.PROD, pathname);
}
