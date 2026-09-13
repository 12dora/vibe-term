import { createMemoizedLoader } from '../../../../apps/gateway/src/lazy-load';

const loader = createMemoizedLoader(() => import('../../../../apps/gateway/src/hub/hub-runtime'));
const meshLoader = createMemoizedLoader(
  () => import('../../../../apps/gateway/src/mesh/mesh-runtime')
);

export function loadHubRuntimeModule() {
  return loader.load();
}

export function loadMeshRuntimeModule() {
  return meshLoader.load();
}

export function peekHubRuntimeModule() {
  return loader.peek();
}

export function peekMeshRuntimeModule() {
  return meshLoader.peek();
}

export function resetAssembleRuntimeLoadersForTests() {
  loader.reset();
  meshLoader.reset();
}
