import type { WatchRuleSampleDto } from '@vibeterm/shared';
import { getWatchRuleById } from '../db/watch';
import { createMemoizedLoader } from '../lazy-load';
import { liveServicesEnabled, liveServicesStopping } from '../live-start-gates';

const loader = createMemoizedLoader(() => import('./service'));

export function loadWatchService() {
  return loader.load();
}

export function peekWatchService() {
  return loader.peek();
}

export async function startWatchService() {
  const { watchService } = await loadWatchService();
  if (liveServicesStopping()) return;
  return watchService.start();
}

/**
 * 服务已运行：照常热更新。未运行（未加载 / 重启后 stop 过 / 先在非 live 下加载）：live 且规则启用才 start
 * （start 会装上全部启用规则）；否则与未启动的 refreshRule 一样只做 teardown。
 */
export async function refreshWatchRule(ruleId: string): Promise<void> {
  const loaded = peekWatchService();
  if (loaded?.watchService.isStarted()) return loaded.watchService.refreshRule(ruleId);
  if (liveServicesEnabled() && getWatchRuleById(ruleId)?.enabled) return startWatchService();
  await loaded?.watchService.refreshRule(ruleId);
}

export async function removeWatchRule(ruleId: string): Promise<void> {
  await peekWatchService()?.watchService.removeRule(ruleId);
}

export function getWatchSamples(ruleId: string): WatchRuleSampleDto[] {
  return peekWatchService()?.watchService.getSamples(ruleId) ?? [];
}

export async function stopWatchServiceIfLoaded() {
  const loaded = await loader.settled();
  if (loaded) await loaded.watchService.stop();
}

export function resetWatchServiceLoaderForTests() {
  loader.reset();
}
