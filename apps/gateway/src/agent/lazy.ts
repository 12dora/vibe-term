import { createMemoizedLoader } from '../lazy-load';

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
