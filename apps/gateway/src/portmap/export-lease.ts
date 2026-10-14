import type { PortMapExportStoreLike } from './store';
import { PORT_MAP_LEASE_SWEEP_MS, isLeaseExpired } from './types';

/** 删除所有已过期的放行行（B 侧），返回被回收的 mapId。 */
export function sweepExpiredExports(
  store: PortMapExportStoreLike,
  now: number = Date.now()
): string[] {
  const reaped: string[] = [];
  for (const row of store.list()) {
    if (!isLeaseExpired(row, now)) continue;
    store.remove(row.mapId);
    reaped.push(row.mapId);
  }
  return reaped;
}

/** 启动即扫一次，之后周期扫描；返回停止函数。 */
export function startExportLeaseSweeper(
  store: () => PortMapExportStoreLike,
  options: { intervalMs?: number; now?: () => number } = {}
): () => void {
  const now = options.now ?? Date.now;
  const sweep = (): void => {
    try {
      sweepExpiredExports(store(), now());
    } catch (err) {
      console.error('[portmap] failed to sweep expired exports', err);
    }
  };
  sweep();
  const timer = setInterval(sweep, options.intervalMs ?? PORT_MAP_LEASE_SWEEP_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
