import { createMemoizedLoader } from '../lazy-load';
import { liveServicesEnabled, liveServicesStopping } from '../live-start-gates';

const loader = createMemoizedLoader(() => import('./supervisor'));

export function loadAgentRuntime() {
  return loader.load();
}

export function peekAgentRuntime() {
  return loader.peek();
}

export async function startAgentSupervisor() {
  const { agentSupervisor } = await loadAgentRuntime();
  if (liveServicesStopping()) return;
  return agentSupervisor.start();
}

/**
 * 可同步分发的条件：模块已加载，且 live 模式下 supervisor 确已 start（看服务状态而非模块缓存——
 * 同进程重启 stop 后、或先在非 live 下加载过，模块都还在但服务未运行）。
 */
export function isAgentSupervisorReady(): boolean {
  const loaded = peekAgentRuntime();
  if (!loaded) return false;
  return !liveServicesEnabled() || loaded.agentSupervisor.isStarted();
}

/** 按需加载；live 模式下若未运行则 start（幂等），与旧的开机即启动等价。 */
export async function ensureAgentSupervisor() {
  const { agentSupervisor } = await loadAgentRuntime();
  if (liveServicesEnabled() && !agentSupervisor.isStarted()) await agentSupervisor.start();
  return agentSupervisor;
}

/** 等在途加载落定再停，避免停机与首次懒加载并发时漏停。 */
export async function stopAgentSupervisorIfLoaded() {
  const loaded = await loader.settled();
  if (loaded) await loaded.agentSupervisor.stop();
}

export function restoreRemoteAgentSessionsIfLoaded() {
  peekAgentRuntime()?.agentSupervisor.restoreRemoteSessions();
}

export function resetAgentRuntimeLoaderForTests() {
  loader.reset();
}
