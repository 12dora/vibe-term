import { createMemoizedLoader } from '../lazy-load';

const loader = createMemoizedLoader(() => import('./manager'));

export function loadTunnelManager() {
  return loader.load();
}

export function peekTunnelManager() {
  return loader.peek();
}

export async function startTunnelManager() {
  const { tunnelManager } = await loadTunnelManager();
  return tunnelManager.start();
}

export async function stopTunnelManagerIfLoaded() {
  const loaded = peekTunnelManager();
  if (loaded) await loaded.tunnelManager.stop();
}

export function resetTunnelManagerLoaderForTests() {
  loader.reset();
}
