import { createMemoizedLoader } from '../lazy-load';
import type { HubRuntime, HubRuntimeOptions } from './hub-runtime';

const loader = createMemoizedLoader(() => import('./hub-runtime'));

export function loadHubRuntime() {
  return loader.load();
}

export function peekHubRuntime() {
  return loader.peek();
}

export async function createDefaultHubRuntime(opts: HubRuntimeOptions): Promise<HubRuntime> {
  const { HubRuntime } = await loadHubRuntime();
  return new HubRuntime(opts);
}

export function resetHubRuntimeLoaderForTests() {
  loader.reset();
}
