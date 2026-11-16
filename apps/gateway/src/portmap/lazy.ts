import { createMemoizedLoader } from '../lazy-load';
import { liveServicesEnabled, liveServicesStopping } from '../live-start-gates';
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
  if (liveServicesStopping()) return;
  portMapManager().start();
}

/**
 * 映射路由每次请求前的同步判定：非 live（纯 relay）沿用未启动的 manager；live 下必须已 start，
 * 吊销级联停监听与租约回收才在线。
 */
export function isPortMapManagerReady(): boolean {
  if (!liveServicesEnabled()) return true;
  return peekPortMapManager()?.portMapManager().isStarted() ?? false;
}

/** live 模式下若 manager 未运行（开机无映射、同进程重启后 stop 过、先在非 live 下加载）则 start；start 幂等。 */
export async function ensurePortMapManagerStarted(): Promise<void> {
  if (liveServicesEnabled()) await startPortMapManager();
}

export async function stopPortMapsIfLoaded(): Promise<void> {
  stopExportSweeper?.();
  stopExportSweeper = null;
  (await loader.settled())?.stopPortMaps();
}

export async function resetPortMapLoaderForTests(): Promise<void> {
  await stopPortMapsIfLoaded();
  loader.reset();
}
