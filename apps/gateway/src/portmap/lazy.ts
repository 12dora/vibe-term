import { createMemoizedLoader } from '../lazy-load';
import { liveServicesEnabled } from '../live-start-gates';
import { startExportLeaseSweeper } from './export-lease';
import { defaultPortMapExportStore } from './store';

const loader = createMemoizedLoader(() => import('./manager'));

let stopExportSweeper: (() => void) | null = null;

export function loadPortMapManager() {
  return loader.load();
}

export function peekPortMapManager() {
  return loader.peek();
}

/** B 侧放行行由对端随时写入，过期回收不依赖 A 侧 manager，常驻启动（只有 store + 定时器）。 */
export function startPortMapExportSweeper(): void {
  stopExportSweeper ??= startExportLeaseSweeper(defaultPortMapExportStore);
}

export async function startPortMapManager(): Promise<void> {
  const { portMapManager } = await loadPortMapManager();
  portMapManager().start();
}

/** 映射路由首次触达：live 模式下补上开机时因无映射而跳过的 start（start 幂等）。 */
export async function ensurePortMapManagerStarted(): Promise<void> {
  if (liveServicesEnabled()) await startPortMapManager();
}

export function stopPortMapsIfLoaded(): void {
  peekPortMapManager()?.stopPortMaps();
  stopExportSweeper?.();
  stopExportSweeper = null;
}

export function resetPortMapLoaderForTests(): void {
  stopPortMapsIfLoaded();
  loader.reset();
}
