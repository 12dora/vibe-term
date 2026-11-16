import { createMemoizedLoader } from '../lazy-load';
import { liveServicesEnabled } from '../live-start-gates';

const loader = createMemoizedLoader(() => import('./supervisor'));

export function loadAgentRuntime() {
  return loader.load();
}

export function peekAgentRuntime() {
  return loader.peek();
}

export async function startAgentSupervisor() {
  const { agentSupervisor } = await loadAgentRuntime();
  return agentSupervisor.start();
}

/** REST 首次触达时加载；live 模式下顺带 start（幂等），与旧的开机即启动等价。 */
export async function ensureAgentSupervisor() {
  const { agentSupervisor } = await loadAgentRuntime();
  if (liveServicesEnabled()) await agentSupervisor.start();
  return agentSupervisor;
}

export async function stopAgentSupervisorIfLoaded() {
  const loaded = peekAgentRuntime();
  if (loaded) await loaded.agentSupervisor.stop();
}

export function restoreRemoteAgentSessionsIfLoaded() {
  peekAgentRuntime()?.agentSupervisor.restoreRemoteSessions();
}

export function resetAgentRuntimeLoaderForTests() {
  loader.reset();
}
