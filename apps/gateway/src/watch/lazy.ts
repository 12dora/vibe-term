import type { WatchRuleSampleDto } from '@vibeterm/shared';
import { getWatchRuleById } from '../db/watch';
import { createMemoizedLoader } from '../lazy-load';
import { liveServicesEnabled } from '../live-start-gates';

const loader = createMemoizedLoader(() => import('./service'));

export function loadWatchService() {
  return loader.load();
}

export function peekWatchService() {
  return loader.peek();
}

export async function startWatchService() {
  const { watchService } = await loadWatchService();
  return watchService.start();
}

/** 未加载时：live 且规则已启用才拉起服务（start 会装上全部启用规则），否则与未启动的 refreshRule 一样是空操作。 */
export async function refreshWatchRule(ruleId: string): Promise<void> {
  const loaded = peekWatchService();
  if (loaded) return loaded.watchService.refreshRule(ruleId);
  if (!liveServicesEnabled() || !getWatchRuleById(ruleId)?.enabled) return;
  await startWatchService();
}

export async function removeWatchRule(ruleId: string): Promise<void> {
  await peekWatchService()?.watchService.removeRule(ruleId);
}

export function getWatchSamples(ruleId: string): WatchRuleSampleDto[] {
  return peekWatchService()?.watchService.getSamples(ruleId) ?? [];
}

export async function stopWatchServiceIfLoaded() {
  const loaded = peekWatchService();
  if (loaded) await loaded.watchService.stop();
}

export function resetWatchServiceLoaderForTests() {
  loader.reset();
}
