// 读地址栏。测试跑在无 DOM 的 bun 环境，`window.location` 可能只有部分字段，一律容错。

export function currentOrigin(): string | null {
  if (typeof window === 'undefined') return null;
  const origin = window.location?.origin;
  return typeof origin === 'string' && origin ? origin : null;
}

export function currentHostname(): string | null {
  if (typeof window === 'undefined') return null;
  const hostname = window.location?.hostname;
  if (typeof hostname === 'string' && hostname) return hostname;
  const origin = currentOrigin();
  if (!origin) return null;
  try {
    return new URL(origin).hostname || null;
  } catch {
    return null;
  }
}

/**
 * 重启完成后整页跳到登录页。
 *
 * 这里刻意用硬跳转而不是 react-router：角色从 standalone 变成 mesh 后，
 * `/api/auth/mode` 的结果、mesh store、WebSocket 连接全都要重新建立，
 * SPA 内部导航保不住一致性。
 */
export function navigateToLogin(): void {
  assignLocation('/login');
}

/**
 * 退出 mesh 后回到设置页的「节点」标签。
 *
 * 同样是硬跳转：角色从 mesh 变回 standalone 后 `/api/auth/mode`、mesh store、WebSocket
 * 全都要重新建立；顺带让新进程重新下发一份干净的鉴权状态。
 */
export function navigateToSettingsNodes(): void {
  assignLocation('/settings?tab=nodes');
}

function assignLocation(url: string): void {
  if (typeof window === 'undefined') return;
  const location = window.location as Location | undefined;
  if (location && typeof location.assign === 'function') {
    location.assign(url);
  }
}
