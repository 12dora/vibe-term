import { createMemoizedLoader } from '../lazy-load';

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

export async function stopWatchServiceIfLoaded() {
  const loaded = peekWatchService();
  if (loaded) await loaded.watchService.stop();
}

export function resetWatchServiceLoaderForTests() {
  loader.reset();
}
