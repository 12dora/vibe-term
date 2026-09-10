// SW 注册策略。生产：首帧之后注册根作用域 /sw.js（安装期的预缓存下载不和首屏抢带宽）。
// 非生产：主动注销同源上已有的 SW——vite dev 与打包版共用 localhost 端口时，
// 旧 SW 会把 dev 页面的导航请求回放成过期的打包壳，症状是改代码不生效。

export const SERVICE_WORKER_URL = '/sw.js';

export interface ServiceWorkerRegistrationLike {
  unregister(): Promise<boolean>;
}

export interface ServiceWorkerContainerLike {
  register(url: string, options?: { scope?: string }): Promise<unknown>;
  getRegistrations(): Promise<readonly ServiceWorkerRegistrationLike[]>;
}

export async function applyServiceWorkerPolicy(
  container: ServiceWorkerContainerLike | undefined,
  isProd: boolean
): Promise<void> {
  if (!container) return;
  try {
    if (!isProd) {
      const registrations = await container.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
      return;
    }
    await container.register(SERVICE_WORKER_URL, { scope: '/' });
  } catch {
    // 不支持 / 非安全上下文 / 隐私模式下注册失败都不该影响应用本身
  }
}

export function setupServiceWorker(): void {
  const nav = (globalThis as { navigator?: { serviceWorker?: ServiceWorkerContainerLike } })
    .navigator;
  void applyServiceWorkerPolicy(nav?.serviceWorker, import.meta.env.PROD);
}
